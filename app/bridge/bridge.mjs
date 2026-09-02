#!/usr/bin/env node
/**
 * QQBot-Pack 通用桥接 · bridge.mjs（通用版 v2.2-g，源自 qq-bot-bridge v2.2）
 *
 * 三层触发：
 *   1) 被 @（或 @全体）→ 必回，回复时 @ 回去
 *   2) 命中兴趣词 且 不含黑名单词 → 带最近群聊上下文交给模型判断
 *      模型觉得值得插嘴就正常回；不值得就回 [SILENT]（桥接拦截，不发）
 *   3) 其他 / 黑名单词 → 静默
 * 附加：限频（每分钟最多 N 条）、白名单热更新、发言人标注、掉号看门狗、日志落盘。
 *
 * 通用化要点（相对原版）：
 *  - 零个人化：不含任何机器/人名/账号/路径硬编码；身份信息全部来自配置。
 *  - 纯相对路径：包根 = 本文件所在 app\bridge 的上级两级；配置默认读
 *    <包根>\config\bridge.config.json（可用环境变量 BRIDGE_CONFIG 覆盖）。
 *  - 人设外置：首次建会话时自动读取 <包根>\<配置 personaFile> 作为人设种子。
 *  - 规则令牌：config.replyPolicy.rules 里可写 {botName} {selfQq} {ownerNick} {ownerQq}，
 *    程序每次发问前自动替换为当前实际值（群里 @ 用到的号随消息自动识别）。
 *  - 日志双通道：控制台 + <包根>\logs\bridge.log（超 5MB 自动轮转为 .1.log）。
 *  - 看门狗只对"曾经成功登录过"的实例自动重登（防止首次扫码阶段被反复拉起）；
 *    重登时连 NapCat 启动器的循环窗口一起结束再开新窗，避免两个循环抢 6099。
 *
 * 依赖：Node 22+（内置 fetch 与 WebSocket），零 npm 依赖。
 * 用法：NapCat 登录小号并填好 config\bridge.config.json 后执行 node app\bridge\bridge.mjs
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PACKAGE_ROOT, CONFIG_PATH, loadConfig, sleep, dshCall, waitForReply, tailBaseline } from './dsh-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 常量与工具
// ---------------------------------------------------------------------------
const NAPCAT_WEBUI_PORT = 6099;   // NapCat WebUI/OneBot 宿主端口（看门狗据此找进程）
// 以下两项支持环境变量覆盖，仅供测试隔离用（生产保持默认）
const LOCK_PORT = Number(process.env.BRIDGE_LOCK_PORT || 34567);   // bridge 单实例锁端口
const LOG_FILE = process.env.BRIDGE_LOG_FILE
  ? path.resolve(process.env.BRIDGE_LOG_FILE)
  : path.join(PACKAGE_ROOT, 'logs', 'bridge.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const NAPCAT_DIR = path.join(PACKAGE_ROOT, 'app', 'napcat');
const NAPCAT_LAUNCHER = '启动NapCat.bat';            // 看门狗重登用启动器（可被 watchdog.launcherBat 覆盖）
const FALLBACK_TEXT = '呜……我这边刚卡了一下没回上！再戳我一次试试？(。﹏。*)';

function rel(p) { return path.resolve(PACKAGE_ROOT, p || '.'); }

// —— 日志：控制台 + 文件（超限轮转）——
function writeLogLine(line) {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      const bak = `${LOG_FILE}.1.log`;
      try { fs.renameSync(LOG_FILE, bak); } catch { /* 占用等场景忽略 */ }
    }
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch { /* 日志失败不影响主流程 */ }
}
function log(...args) {
  const line = `${new Date().toISOString()} [bridge] ${args.join(' ')}`;
  console.log(line);
  writeLogLine(line);
}

// ---------------------------------------------------------------------------
// 配置读取与令牌替换
// ---------------------------------------------------------------------------
let cached;
try {
  cached = loadConfig();
} catch (e) {
  console.error(`[bridge] 配置加载失败：${e.message}`);
  console.error(`[bridge] 请先把 config\\bridge.config.example.json 复制一份改名为 config\\bridge.config.json 并填写后重试。`);
  process.exit(1);
}
function refreshConfig() {
  try {
    cached = loadConfig();
  } catch (e) {
    log('⚠️ 配置读取失败（沿用旧值）:', e.message);
  }
}
function cfgOf(...keys) {
  let o = cached;
  for (const k of keys) {
    if (o == null) return undefined;
    o = o[k];
  }
  return o;
}
const botName = () => String(cfgOf('bot', 'name') || '小助手');
const ownerQq = () => Number(cfgOf('owner', 'qq')) || 0;
const ownerNick = () => String(cfgOf('owner', 'nick') || '');
/** 替换规则文本里的身份令牌 */
function fillTokens(text, selfQq) {
  return String(text ?? '')
    .replace(/\{botName\}/g, botName())
    .replace(/\{selfQq\}/g, String(selfQq ?? ''))
    .replace(/\{ownerNick\}/g, ownerNick() || '主人')
    .replace(/\{ownerQq\}/g, ownerQq() ? String(ownerQq()) : '未配置');
}

// ---------------------------------------------------------------------------
// 人设种子组装：身份说明 + 人设档案文件 + 可选附加文本
// ---------------------------------------------------------------------------
function readPersona() {
  const file = String(cfgOf('personaFile') || '').trim();
  if (!file) return '';
  try {
    return fs.readFileSync(rel(file), 'utf8').trim();
  } catch (e) {
    log(`⚠️ 读取人设档案失败（${file}）:`, e.message);
    return '';
  }
}
function buildSeed() {
  const persona = readPersona();
  const parts = [];
  parts.push(`你是 QQ 群里的机器人「${botName()}」。以下是你的人设档案，从现在起你完全以这个人设思考、说话、回复：`);
  parts.push(persona || '（人设档案未配置或为空——那就做一个友善、有礼貌、话不多但乐于助人的群聊助手，用中文回复。）');
  if (ownerQq()) {
    parts.push(`主人：只有 [${ownerNick() || '主人'}(QQ:${ownerQq()})] 是你的主人（称呼：${ownerNick() || '主人'}），其他人都按群友对待、用昵称称呼。`);
  }
  const extra = String(cfgOf('seedExtra') || '').trim();
  if (extra) parts.push(extra);
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// 单实例锁：占住本地端口，占不到说明已有实例在跑 → 立即退出（防止重复回复）
// ---------------------------------------------------------------------------
const lock = net.createServer();
lock.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log('⚠️ 检测到已有桥接实例在运行，本实例自动退出（防止同一消息回复两次）');
    process.exit(0);
  }
  throw e;
});
lock.listen(LOCK_PORT, '127.0.0.1', () => log(`🔒 单实例锁已获取 (127.0.0.1:${LOCK_PORT})`));

// ---------------------------------------------------------------------------
// OneBot v11 客户端（正向 WS）
// ---------------------------------------------------------------------------
let ws = null;
let outQueue = [];

function wsSend(obj) {
  outQueue.push(obj);
  flushOut();
}
function flushOut() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    while (outQueue.length) ws.send(JSON.stringify(outQueue.shift()));
  }
}
function connect() {
  const url = cfgOf('onebot', 'accessToken')
    ? `${cfgOf('onebot', 'wsUrl')}?access_token=${encodeURIComponent(cfgOf('onebot', 'accessToken'))}`
    : cfgOf('onebot', 'wsUrl');
  ws = new WebSocket(url);
  ws.onopen = () => { log('✅ OneBot WS 已连接:', cfgOf('onebot', 'wsUrl')); flushOut(); };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (typeof msg?.echo === 'string' && msg.echo.startsWith(WD_PREFIX)) { wdOnResponse(msg); return; }
    handleEvent(msg).catch((err) => log('处理事件出错:', err.message));
  };
  ws.onclose = () => { log('⚠️ OneBot WS 断开，3 秒后重连...'); setTimeout(connect, 3000); };
  ws.onerror = (e) => log('OneBot WS 错误:', e.message || '');
}

/** 从 OneBot 消息段提取纯文本 */
function extractText(msg) {
  if (typeof msg === 'string') return msg.trim();
  if (!Array.isArray(msg)) return '';
  let s = '';
  for (const seg of msg) {
    if (!seg) continue;
    if (seg.type === 'text') s += seg.data?.text ?? '';
    else if (seg.type === 'at') s += `@${seg.data?.qq ?? ''} `;
    else if (seg.type === 'image') s += '[图片] ';
    else if (seg.type === 'face') s += '[表情] ';
    else if (seg.type === 'record') s += '[语音] ';
    else if (seg.type === 'video') s += '[视频] ';
    else if (seg.type === 'file') s += '[文件] ';
    else s += `[${seg.type}] `;
  }
  return s.trim();
}

/** 是否 @ 了小号（含 @全体）。selfId 未配置时用事件自带的 self_id */
function isMentioned(msg) {
  if (!Array.isArray(msg.message)) return false;
  const selfId = cfgOf('onebot', 'selfId') || msg.self_id;
  return msg.message.some((seg) => seg?.type === 'at' && (String(seg.data?.qq) === String(selfId) || seg.data?.qq === 'all'));
}

/** 命中关键词 */
function hitKeywords(text, words) {
  return (words || []).some((w) => w && text.includes(w));
}

/** 超长回复按行切块（QQ 单条消息限制） */
function splitText(text, max = 1500) {
  const out = [];
  while (text.length > max) {
    let cut = text.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    out.push(text.slice(0, cut).trim());
    text = text.slice(cut).trimStart();
  }
  if (text) out.push(text);
  return out;
}

/** 发群消息；atQq 存在时消息开头 @ 对方（并剥离模型手写的开头文字 @，防双重 @） */
function sendGroupMsg(groupId, text, atQq) {
  let body = text;
  if (atQq) body = body.replace(/^@\S+\s*/, '');
  const prefix = atQq ? `[CQ:at,qq=${atQq}] ` : '';
  for (const chunk of splitText(prefix + body)) {
    wsSend({
      action: 'send_group_msg',
      params: { group_id: groupId, message: chunk },
      echo: `reply-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    });
  }
}

// ---------------------------------------------------------------------------
// 群上下文（最近 N 条，供"真人感"判断）
// ---------------------------------------------------------------------------
const groupContext = new Map(); // groupId -> [{nick, qq, text, time}]

function pushContext(groupId, nick, qq, text) {
  const arr = groupContext.get(groupId) || [];
  arr.push({ nick, qq, text, time: Date.now() });
  const win = cfgOf('replyPolicy', 'contextWindow') || 8;
  if (arr.length > win) arr.splice(0, arr.length - win);
  groupContext.set(groupId, arr);
}
function contextText(groupId) {
  const arr = groupContext.get(groupId) || [];
  return arr.map((m) => `[${m.nick}(QQ:${m.qq})] ${m.text}`).join('\n');
}

// ---------------------------------------------------------------------------
// 限频（每分钟最多 N 条回复）
// ---------------------------------------------------------------------------
const replyTimes = [];
function canReplyNow() {
  const max = cfgOf('replyPolicy', 'maxRepliesPerMinute') ?? 3;
  const now = Date.now();
  while (replyTimes.length && replyTimes[0] < now - 60000) replyTimes.shift();
  return replyTimes.length < max;
}
function markReplied() { replyTimes.push(Date.now()); }

// ---------------------------------------------------------------------------
// 消息处理（触发判定 + 白名单热更新 + 去重 + 串行队列）
// ---------------------------------------------------------------------------
const recentIds = new Set();

async function handleEvent(msg) {
  if (msg.post_type !== 'message' || msg.message_type !== 'group') return;
  refreshConfig();
  if (!(cfgOf('groups') || []).includes(msg.group_id)) return;   // 白名单
  const selfId = cfgOf('onebot', 'selfId') || msg.self_id;
  if (msg.user_id === selfId) return;                            // 防回声
  if (recentIds.has(msg.message_id)) return;                     // 去重
  recentIds.add(msg.message_id);
  if (recentIds.size > 200) recentIds.delete(recentIds.values().next().value);
  const text = extractText(msg.message);
  if (!text) return;
  const nick = msg.sender?.card || msg.sender?.nickname || `QQ${msg.user_id}`;
  const attributed = `[${nick}(QQ:${msg.user_id})] ${text}`;

  // —— 触发判定 ——
  const mentioned = isMentioned(msg);
  const policy = cfgOf('replyPolicy') || {};
  const interest = !mentioned && hitKeywords(text, policy.interestKeywords);
  const blocked = !mentioned && hitKeywords(text, policy.blockKeywords);

  const meta = { mentioned, nick, qq: msg.user_id, selfId };
  if (mentioned) {
    log(`🔔 群 ${msg.group_id} @${msg.user_id}(${nick}) @了 我: ${text.slice(0, 50)}`);
    pushContext(msg.group_id, nick, msg.user_id, text);
    enqueue(() => processMessage(msg.group_id, attributed, meta));
  } else if (interest && !blocked) {
    log(`👀 群 ${msg.group_id} @${msg.user_id}(${nick}) 命中兴趣词: ${text.slice(0, 50)}`);
    pushContext(msg.group_id, nick, msg.user_id, text);
    enqueue(() => processMessage(msg.group_id, attributed, meta));
  } else {
    if (blocked) log(`🤫 群 ${msg.group_id} @${msg.user_id} 命中黑名单词，静默`);
    pushContext(msg.group_id, nick, msg.user_id, text); // 仍记入上下文供后续判断
  }
}

let chain = Promise.resolve();
function enqueue(fn) {
  chain = chain.then(fn).catch((e) => log('队列任务失败:', e.message));
}

/** 兜底提醒：处理失败/超时时，@ 的人至少要收到一句话，绝不让群里以为"机器人掉线" */
function fallbackReply(groupId, meta, why) {
  if (!meta.mentioned) return; // 非 @ 触发（兴趣词）失败 → 静默即可，本就克制
  if (!canReplyNow()) { log(`⏸ 限频：兜底提醒跳过（${why}）`); return; }
  markReplied();
  const text = String(cfgOf('replyPolicy', 'fallbackText') || FALLBACK_TEXT);
  sendGroupMsg(groupId, text, meta.qq);
  log(`💊 已发兜底提醒（${why}）`);
}

async function processMessage(groupId, attributed, meta) {
  // 一个群一个会话：sessionId = 前缀 + "-" + 群号，各群记忆隔离
  const sessionId = `${cfgOf('dsh', 'sessionId')}-${groupId}`;
  // 组装 prompt：规则（令牌替换）+ 最近群聊上下文 + 新消息
  const rules = fillTokens(cfgOf('replyPolicy', 'rules'), meta.selfId);
  const ctx = contextText(groupId);
  const prompt = `${rules}\n\n最近群聊：\n${ctx}\n\n新消息：${attributed}`;
  const baseUrl = cfgOf('dsh', 'baseUrl');
  const cwd = cfgOf('dsh', 'cwd') ? rel(cfgOf('dsh', 'cwd')) : PACKAGE_ROOT;

  try {
    let baseline;
    try {
      baseline = await tailBaseline(baseUrl, sessionId);
    } catch (e) {
      if (e.code !== 'session-not-found') throw e;
      log('🆕 创建专用会话并加载人设...');
      await dshCall(baseUrl, 'session.create', { sessionId, cwd });
      await dshCall(baseUrl, 'session.prompt', {
        sessionId, mode: 'queue',
        content: [{ type: 'text', text: buildSeed() }],
      });
      // 等 seedPrompt 首答：异常/超时不致命（会话已建），不阻塞主流程
      try {
        await waitForReply(baseUrl, sessionId, -1, cfgOf('timeouts', 'replyMs') ?? 300000, cfgOf('timeouts', 'pollMs') ?? 1200);
      } catch (e2) {
        log('⚠️ 人设首答等待异常（不阻塞）:', e2.code || '', e2.message);
      }
      log('✅ 会话已就绪');
      baseline = await tailBaseline(baseUrl, sessionId);
    }

    await dshCall(baseUrl, 'session.prompt', {
      sessionId, mode: 'queue',
      content: [{ type: 'text', text: prompt }],
    });
    // throwOnTimeout：超时抛错走兜底，不再静默空吞（"掉线"根源）
    const reply = await waitForReply(baseUrl, sessionId, baseline, cfgOf('timeouts', 'replyMs') ?? 300000, cfgOf('timeouts', 'pollMs') ?? 1200, { throwOnTimeout: true });

    if (!reply.trim()) {
      log('⚠️ 模型回复为空串');
      fallbackReply(groupId, meta, '空回复');
      return;
    }
    // —— 沉默标记拦截 ——
    const marker = cfgOf('replyPolicy', 'silentMarker') || '[SILENT]';
    if (reply.startsWith(marker) || reply.trim() === marker) {
      log('🤫 模型判定不值得插嘴，静默');
      return;
    }
    // —— 限频 ——
    if (!canReplyNow()) {
      log('⏸ 限频：1 分钟内回复已达上限，本条跳过');
      return;
    }
    markReplied();
    const atQq = (meta.mentioned && cfgOf('replyPolicy', 'replyAt') !== false) ? meta.qq : null;
    sendGroupMsg(groupId, reply, atQq);
    log(`💬 已回复（${reply.length} 字）${atQq ? `并 @${atQq}` : ''}`);
  } catch (e) {
    // 任何异常（网络闪断 / DSH 重启 / reply-timeout / 会话异常）→ @ 的人收到兜底，不静默"掉线"
    log(`⚠️ processMessage 异常兜底: ${e.code || ''} ${e.message}`);
    fallbackReply(groupId, meta, e.code || e.message);
  }
}

// ---------------------------------------------------------------------------
// 看门狗（掉号自动重登，无人值守）
// 场景：账号被腾讯挤下线 / NapCat 假死——主人远程不在电脑前，必须全自动恢复。
// 原理：复用本 WS 每 N 秒发 get_login_info 探活 → 连续失败/WS 断 → 结束 NapCat
//       启动器窗口进程树（连循环窗口一起，防两个循环抢 6099）→ 重新拉起 NapCat。
// 安全闸：只有"本会话内曾探活成功（成功登录过）"才允许自动重登——首次部署时
//       用户正对着二维码扫码，绝不能被看门狗反复杀进程；登录成功即自动武装。
//       快速登录也失败则有限重试后停下（防风控），日志提示人工（WebUI 扫码兜底）。
// ---------------------------------------------------------------------------
const WD_PREFIX = 'watchdog-';
const wdState = { miss: 0, okStreak: 0, reloginCount: 0, lastRelogin: 0, coolUntil: 0, warmUntil: Date.now() + 120000, armed: false };

function wdConf() { return cfgOf('watchdog') || {}; }

function wdPing() {
  if (Date.now() < wdState.warmUntil) return; // 启动宽限期：前 2 分钟不探活，避免误判
  const wd = wdConf();
  if (wd.enable === false) return;
  if (Date.now() < wdState.coolUntil) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    wsSend({ action: 'get_login_info', echo: `${WD_PREFIX}ping-${Date.now()}` });
  } else {
    wdOnMiss('WS 未连接（NapCat 可能已死）');
  }
}

function wdOnResponse(msg) {
  if (msg.retcode === 0 && msg.data?.user_id) {
    wdState.armed = true;                       // 成功登录过一次 → 武装看门狗
    wdState.miss = 0;
    if (++wdState.okStreak >= 2) { wdState.reloginCount = 0; wdState.coolUntil = 0; }
  } else {
    wdOnMiss(`get_login_info 异常 retcode=${msg.retcode || '?'}（NapCat 活着但未登录/离线）`);
  }
}

function wdOnMiss(reason) {
  if (Date.now() < wdState.warmUntil) return;
  if (Date.now() < wdState.coolUntil) return;
  if (!wdState.armed) {
    log('🐶 [看门狗] 尚未成功登录过（首次扫码中？），跳过自动重登:', reason);
    return;
  }
  wdState.miss++;
  wdState.okStreak = 0;
  const wd = wdConf();
  const limit = wd.missLimit || 3;
  log(`👀 [看门狗] 探活失败 ${wdState.miss}/${limit}（${reason}）`);
  if (wdState.miss >= limit) wdRelogin(reason);
}

function wdRelogin(reason) {
  const wd = wdConf();
  if (Date.now() - wdState.lastRelogin < (wd.reloginMinGapMs || 300000)) return; // 防抖
  const maxRel = wd.maxRelogin || 3;
  if (wdState.reloginCount >= maxRel) {
    log(`🚨 [看门狗] 已连续自动重登 ${maxRel} 次仍离线——停止自动重试（防风控）。请人工兜底：打开 NapCat 网页版（见日志顶部端口）扫码登录，或按部署文档配置账密回退启动器`);
    wdState.warmUntil = Date.now() + 1800000; // 半小时后恢复自动（万一那时 NapCat 又被手动拉起了）
    return;
  }
  wdState.reloginCount++;
  wdState.lastRelogin = Date.now();
  wdState.coolUntil = Date.now() + 120000; // 2 分钟冷却，等 NapCat 重启完成
  wdState.miss = 0;
  log(`💥💥 [看门狗] 检测到掉号（${reason}），自动重登 #${wdState.reloginCount}...`);
  reloginNapcat().catch((e) => log('⚠️ [看门狗] 重登流程出错:', e.message));
}

function findPidByPort(port) {
  return new Promise((resolve) => {
    exec(`netstat -ano | findstr "LISTENING" | findstr ":${port} "`, (err, stdout) => {
      if (err) return resolve(null);
      const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
      const pid = lines.length ? ((lines[lines.length - 1].match(/(\d+)\s*$/) || [])[1] || null) : null;
      resolve(pid);
    });
  });
}

/** 查进程的父进程 PID（找 NapCat 启动器循环窗口所在 cmd） */
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
      if (err) log('⚠️ [看门狗] exec 失败:', cmd, '→', err.message);
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function reloginNapcat() {
  const pid = await findPidByPort(NAPCAT_WEBUI_PORT);
  if (pid) {
    // 结束整个启动器窗口进程树（cmd 循环 + node），避免旧循环 5 秒后复活抢端口
    const parent = await parentPidOf(pid);
    if (parent && parent !== 1) {
      log(`  [看门狗] 结束 NapCat 启动器进程树 PID=${parent}（含 ${pid}）`);
      await execCmd(`taskkill /F /T /PID ${parent}`);
    } else {
      log(`  [看门狗] 杀 NapCat 进程树 PID=${pid}`);
      await execCmd(`taskkill /F /T /PID ${pid}`);
    }
  } else {
    log('  [看门狗] 6099 未监听（NapCat 已死/未起），直接拉起');
  }
  await sleep(3000);
  const launcher = String(cfgOf('watchdog', 'launcherBat') || NAPCAT_LAUNCHER);
  log(`  [看门狗] 重新启动 NapCat（${launcher}，缓存票据自动快速登录，失败则回落二维码）...`);
  await execCmd(`start "NapCat-QQBot(看门狗重登)" cmd /c "cd /d ${NAPCAT_DIR} && ${launcher}"`);
}

function wdStart() {
  const wd = wdConf();
  log(`🐶 看门狗${wd.enable === false ? ' 已停用' : ` 启用：每 ${(wd.pingIntervalMs || 30000) / 1000}s 探活，连续 ${wd.missLimit || 3} 次失败自动重启 NapCat（登录成功后武装，防抖 ${(wd.reloginMinGapMs || 300000) / 60000} 分钟，上限 ${wd.maxRelogin || 3} 次）`}`);
  setInterval(wdPing, wd.pingIntervalMs || 30000);
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
log(`🐟 QQBot 通用桥接 v2.2-g 启动（@触发 + 关键词主动 + 真人克制 + 掉号看门狗）`);
log('  配置:', CONFIG_PATH);
log('  包根:', PACKAGE_ROOT);
log('  日志:', LOG_FILE);
log('  DSH :', cfgOf('dsh', 'baseUrl'), '| 会话前缀:', cfgOf('dsh', 'sessionId'));
log('  白名单群:', (cfgOf('groups') || []).join(', ') || '（未配置——请先在 config\\bridge.config.json 填群号）');
log('  机器人名:', botName(), ownerQq() ? `| 主人: ${ownerNick() || '主人'}(${ownerQq()})` : '| 主人: 未配置');
log('  人设档案:', cfgOf('personaFile') || '（未配置）');
log('  回复模式:', cfgOf('replyPolicy', 'mode'), '| 兴趣词数:', (cfgOf('replyPolicy', 'interestKeywords') || []).length, '| 黑名单词数:', (cfgOf('replyPolicy', 'blockKeywords') || []).length);
connect();
wdStart();

process.on('SIGINT', () => { log('再见～'); process.exit(0); });
