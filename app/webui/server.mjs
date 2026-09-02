#!/usr/bin/env node
/**
 * QQBot-Pack · 门户 + 管理面板（server.mjs）
 *
 * Node 22+ 零依赖 http 服务（端口 3210，127.0.0.1 只本机访问）：
 *   - 门户首页：NapCat(6099) / DSH(3080) / OneBot WS(3001) / 桥接 状态卡片 + 跳转链接
 *   - 管理面板：读/写 config\bridge.config.json（白名单群、兴趣词、黑名单词、回复规则热改，
 *               写前自动备份 .bak）；查看 logs 尾部（bridge.log / dsh.log）；一键重启
 *               bridge / NapCat（由各自启动器循环窗口自动拉起）；打开 NapCat WebUI（自动带令牌）
 *
 * 启动：node app\webui\server.mjs   （可用环境变量 WEBUI_PORT 覆盖端口，便于测试）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');          // 包根（app\webui 上两级）
const PUBLIC = path.join(__dirname, 'public');
const CONFIG_FILE = path.join(ROOT, 'config', 'bridge.config.json');
const LOGS_DIR = path.join(ROOT, 'logs');
const NAPCAT_DIR = path.join(ROOT, 'app', 'napcat');
const NAPCAT_CFG_DIR = path.join(NAPCAT_DIR, 'data', 'config');
const NAPCAT_WEBUI_PORT = 6099;
const ONEBOT_PORT = 3001;
const DSH_PORT = 3080;
const BRIDGE_LOCK_PORT = 34567;   // bridge 单实例锁端口（bridge 进程监听它）
const HOST = '127.0.0.1';
const PORT = Number(process.env.WEBUI_PORT || 3210);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...a) { console.log(new Date().toISOString(), '[webui]', ...a); }

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function readText(p, fallback = '') {
  try { return fs.readFileSync(p, 'utf8'); } catch { return fallback; }
}
function writeText(p, s) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s, 'utf8');
}
/** 端口探活：TCP 能连上即视为 up */
function checkPort(port, host = HOST, timeoutMs = 900) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (up) => { sock.destroy(); resolve(up); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}
/** HTTP GET 状态码（连不上返回 0） */
function httpCode(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode || 0); });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
  });
}
/** 监听某端口的 PID */
function pidByPort(port) {
  return new Promise((resolve) => {
    exec(`netstat -ano | findstr "LISTENING" | findstr "127.0.0.1:${port} "`, (err, stdout) => {
      if (err) return resolve(null);
      const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
      const m = lines.length ? (lines[lines.length - 1].match(/(\d+)\s*$/) || []) : [];
      resolve(m[1] || null);
    });
  });
}
function parentPidOf(pid) {
  return new Promise((resolve) => {
    exec(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId"`, (err, stdout) => {
      if (err) return resolve(null);
      resolve(parseInt(String(stdout).trim(), 10) || null);
    });
  });
}
function execCmd(cmd) {
  return new Promise((resolve) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) log('exec 失败:', cmd, '→', err.message);
      resolve({ stdout: stdout || '', stderr: stderr || '', code: err ? 1 : 0 });
    });
  });
}

/** 读取文件尾部最近 N 行（大文件只读末尾 128KB） */
function tailLines(file, n = 200) {
  try {
    const st = fs.statSync(file);
    if (st.size === 0) return [];
    const start = Math.max(0, st.size - 128 * 1024);
    const buf = fs.readFileSync(file, { encoding: 'utf8', start });
    const lines = buf.split(/\r?\n/).filter(Boolean);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 配置读写（写前备份 .bak）
// ---------------------------------------------------------------------------
function loadConfig() {
  try {
    const j = JSON.parse(readText(CONFIG_FILE, '{}'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}

/**
 * 局部更新配置：只替换 patch 里出现的字段，其余保留；写前把旧文件复制为
 * .bak（再留一份带时间戳的 .bak，最多留 5 份）。文件先写 .tmp 再改名，防半截文件。
 * 返回 {ok, message}
 */
function patchConfig(patch) {
  const cur = loadConfig();
  const apply = (obj, segs, value) => {
    let o = obj;
    for (let i = 0; i < segs.length - 1; i++) {
      const k = segs[i];
      if (o[k] == null || typeof o[k] !== 'object') o[k] = {};
      o = o[k];
    }
    o[segs[segs.length - 1]] = value;
  };
  for (const [key, value] of Object.entries(patch || {})) {
    apply(cur, key.split('.'), value);
  }
  const out = JSON.stringify(cur, null, 2) + '\n';
  try {
    // 备份
    if (fs.existsSync(CONFIG_FILE)) {
      writeText(`${CONFIG_FILE}.bak`, readText(CONFIG_FILE));
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const stamp = `${CONFIG_FILE}.bak-${ts}`;
      try { fs.copyFileSync(CONFIG_FILE, stamp); } catch { /* ignore */ }
      try {
        const old = fs.readdirSync(path.dirname(CONFIG_FILE))
          .filter((f) => /^bridge\.config\.json\.bak-\d{4}-\d{2}-\d{2}T/.test(f))
          .sort();
        while (old.length > 5) fs.unlinkSync(path.join(path.dirname(CONFIG_FILE), old.shift()));
      } catch { /* ignore */ }
    }
    const tmp = `${CONFIG_FILE}.tmp`;
    writeText(tmp, out);
    fs.renameSync(tmp, CONFIG_FILE);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  }
}

/** NapCat WebUI 令牌（供前端拼自动登录链接；未生成时返回空） */
function napcatToken() {
  const w = JSON.parse(readText(path.join(NAPCAT_CFG_DIR, 'webui.json'), '{}') || '{}');
  return String(w.token || '');
}

// ---------------------------------------------------------------------------
// 状态汇总
// ---------------------------------------------------------------------------
async function collectStatus() {
  const [napcat, dsh, onebot, bridge, dshHttp, napcatHttp] = await Promise.all([
    checkPort(NAPCAT_WEBUI_PORT),
    checkPort(DSH_PORT),
    checkPort(ONEBOT_PORT),
    checkPort(BRIDGE_LOCK_PORT),
    httpCode(`http://${HOST}:${DSH_PORT}/`),
    httpCode(`http://${HOST}:${NAPCAT_WEBUI_PORT}/webui`),
  ]);
  const bridgeLog = tailLines(path.join(LOGS_DIR, 'bridge.log'), 300);
  const lastLine = bridgeLog[bridgeLog.length - 1] || '';
  const hasLogin = bridgeLog.some((l) => l.includes('✅ 会话已就绪') || /探活失败 0\//.test(l) || l.includes('武装'));
  const wdLines = bridgeLog.filter((l) => l.includes('[看门狗]') || l.includes('💥') || l.includes('🐶'));
  const cfg = loadConfig();
  return {
    services: {
      napcat: { port: NAPCAT_WEBUI_PORT, up: napcat, http: napcatHttp },
      dsh: { port: DSH_PORT, up: dsh, http: dshHttp },
      onebot: { port: ONEBOT_PORT, up: onebot },
      bridge: { up: bridge, lockPort: BRIDGE_LOCK_PORT, logUpdatedAt: lastLine.slice(0, 24) || '' },
    },
    napcatToken: napcatToken(),
    configLoaded: Object.keys(cfg).length > 0,
    configPath: CONFIG_FILE,
    groups: cfg.groups || [],
    owner: cfg.owner || {},
    botName: cfg.bot?.name || '小助手',
    watchdog: cfg.watchdog || {},
    hasLogin,
    watchdogLog: wdLines.slice(-20),
    bridgeLogTail: bridgeLog.slice(-15),
  };
}

// ---------------------------------------------------------------------------
// 重启动作（目标由各自的启动器循环窗口自动拉起；未用启动器拉起则提示）
// ---------------------------------------------------------------------------
async function restartTarget(target) {
  if (target === 'bridge') {
    // 只杀 bridge 进程本体（锁端口 34567 的监听者）；其启动器循环窗口 5 秒后自动拉起
    const pid = await pidByPort(BRIDGE_LOCK_PORT);
    if (!pid) return { ok: false, message: '桥接当前未在运行（34567 无监听），无需重启' };
    await execCmd(`taskkill /F /PID ${pid}`);
    return { ok: true, message: `已结束桥接进程 PID=${pid}，等待启动器窗口自动拉起（约 5 秒）……` };
  }
  if (target === 'napcat') {
    // 结束整个启动器窗口进程树（cmd 循环 + node），再开一个新窗口
    const pid = await pidByPort(NAPCAT_WEBUI_PORT);
    if (!pid) {
      await execCmd(`start "NapCat-QQBot" cmd /c "cd /d ${NAPCAT_DIR} && 启动NapCat.bat"`);
      return { ok: true, message: 'NapCat 未在运行，已直接拉起' };
    }
    const parent = await parentPidOf(pid);
    if (parent && parent !== 1) {
      await execCmd(`taskkill /F /T /PID ${parent}`);
    } else {
      await execCmd(`taskkill /F /T /PID ${pid}`);
    }
    await sleep(1500);
    await execCmd(`start "NapCat-QQBot" cmd /c "cd /d ${NAPCAT_DIR} && 启动NapCat.bat"`);
    return { ok: true, message: `已重启 NapCat（原进程 ${parent ? `树 PID=${parent}` : `PID=${pid}`}）` };
  }
  return { ok: false, message: `未知目标 ${target}` };
}

// ---------------------------------------------------------------------------
// HTTP 路由
// ---------------------------------------------------------------------------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 2 * 1024 * 1024) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = u.pathname;

  // —— 静态资源 ——
  if (p === '/' || p === '/index.html') {
    const html = readText(path.join(PUBLIC, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }

  // —— API ——
  try {
    if (p === '/api/status' && req.method === 'GET') {
      return sendJson(res, 200, await collectStatus());
    }
    if (p === '/api/config' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, config: loadConfig() });
    }
    if (p === '/api/config' && req.method === 'POST') {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { ok: false, message: '请求体不是合法 JSON' }); }
      if (!body.fields || typeof body.fields !== 'object') {
        return sendJson(res, 400, { ok: false, message: '缺少 fields（要修改的字段对象）' });
      }
      // 白名单群/关键词数组先做类型与格式校验，防把配置写坏
      for (const k of ['groups']) {
        if (body.fields[k] !== undefined && !Array.isArray(body.fields[k])) {
          return sendJson(res, 400, { ok: false, message: `字段 ${k} 必须是数组` });
        }
      }
      const r = patchConfig(body.fields);
      return sendJson(res, r.ok ? 200 : 500, r);
    }
    if (p === '/api/logs' && req.method === 'GET') {
      const file = String(u.searchParams.get('file') || 'bridge').replace(/[^a-zA-Z0-9_-]/g, '');
      const n = Math.min(Number(u.searchParams.get('tail') || 200) || 200, 2000);
      const path_ = path.join(LOGS_DIR, `${file}.log`);
      if (!fs.existsSync(path_)) return sendJson(res, 404, { ok: false, message: `日志不存在：${file}.log` });
      return sendJson(res, 200, { ok: true, lines: tailLines(path_, n) });
    }
    if (p === '/api/restart' && req.method === 'POST') {
      if (process.env.DISABLE_RESTART === '1') {
        return sendJson(res, 400, { ok: false, message: '本实例处于测试模式（DISABLE_RESTART=1），重启动作已禁用' });
      }
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
      const r = await restartTarget(String(body.target || ''));
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    if (p === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true });
    }
    sendJson(res, 404, { ok: false, message: '未找到接口: ' + p });
  } catch (e) {
    sendJson(res, 500, { ok: false, message: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  log(`QQBot 门户+管理台已启动: http://${HOST}:${PORT}`);
});
