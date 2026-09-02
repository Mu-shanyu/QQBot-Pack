/**
 * QQBot-Pack 通用桥接 · dsh-client.mjs（公共模块）
 * DSH 本地 API 客户端 + 取回复工具，供 bridge.mjs 与测试脚本共用。
 *
 * 通用化说明（相对原版 qq-bot-bridge\dsh-client.mjs）：
 *  - 配置路径不再默认取本目录 config.json，而是：
 *        1) 环境变量 BRIDGE_CONFIG 指定的绝对/相对路径（测试与 WebUI 用）；
 *        2) 缺省 = 封装包根目录 config\bridge.config.json（本文件位于 app\bridge\，
 *           向上两级即包根，纯相对定位，拷到任何目录都能跑）。
 *  - 其余 DSH 调用/取回复逻辑与原版一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 包根目录 = app\bridge 向上两级（app\bridge -> app -> 包根） */
export const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

export const CONFIG_PATH = process.env.BRIDGE_CONFIG
  ? path.resolve(process.env.BRIDGE_CONFIG)
  : path.join(PACKAGE_ROOT, 'config', 'bridge.config.json');

export function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`配置格式错误：${CONFIG_PATH} 顶层必须是 JSON 对象`);
  }
  return parsed;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let rpcSeq = 0;
const nextRpcId = () => `bridge-${Date.now()}-${++rpcSeq}`;

/** 调 DSH 本地 API：POST /api/<method>（报文格式见 dsh-host-apiproxy/rpc） */
export async function dshCall(baseUrl, method, payload) {
  const rpcId = nextRpcId();
  const res = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': baseUrl,
    },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  });
  if (!res.ok) throw new Error(`DSH HTTP ${res.status} (${method})`);
  const body = await res.json();
  if (body.type !== 'server-response' || body.rpcId !== rpcId) {
    throw new Error(`DSH 响应格式异常 (${method})`);
  }
  if (!body.result.ok) {
    const e = new Error(`DSH ${method} 失败: ${body.result.error.code} ${body.result.error.message}`);
    e.code = body.result.error.code;
    throw e;
  }
  return body.result.value;
}

/** 从 assistant/message 事件里提取纯文本（跳过 reasoning / tool_call 块） */
export function assistantText(message) {
  const parts = [];
  const c = message?.content;
  if (typeof c === 'string') {
    parts.push(c);
  } else if (Array.isArray(c)) {
    for (const b of c) {
      if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    }
  }
  return parts.join('\n').trim();
}

/** 轮询 session.history，等新的一轮回复完成，返回拼接的文本
 *  opts.throwOnTimeout=true 时：超时且未等到 turn/end 抛 {code:'reply-timeout'}（默认返回空串） */
export async function waitForReply(baseUrl, sessionId, baselineSeq, timeoutMs, pollMs, opts = {}) {
  const deadline = Date.now() + timeoutMs;
  const texts = [];
  const seen = new Set();
  let done = false;
  while (Date.now() < deadline) {
    const { events } = await dshCall(baseUrl, 'session.history', { sessionId, maxMessages: 40 });
    for (const entry of events) {
      const ev = entry?.event;
      if (!ev || ev.seq <= baselineSeq || seen.has(ev.seq)) continue;
      seen.add(ev.seq);
      if (ev.type === 'assistant/message') {
        const t = assistantText(ev.data?.message);
        if (t) texts.push(t);
      }
      if (ev.type === 'turn/end') done = true;
    }
    if (done) break;
    await sleep(pollMs);
  }
  if (!done && opts.throwOnTimeout) {
    const e = new Error(`等待回复超时（${timeoutMs}ms 内未见 turn/end）`);
    e.code = 'reply-timeout';
    throw e;
  }
  return texts.join('\n\n');
}

/** 取历史尾部最大 seq（作为“回复开始前”的基线） */
export async function tailBaseline(baseUrl, sessionId) {
  const { events } = await dshCall(baseUrl, 'session.history', { sessionId, maxMessages: 1 });
  let max = -1;
  for (const entry of events) {
    const seq = entry?.event?.seq ?? -1;
    if (seq > max) max = seq;
  }
  return max;
}
