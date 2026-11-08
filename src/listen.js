/**
 * listen.js — 把"视频里在说什么"接进来。
 *
 * ## 为什么需要它
 *
 * see-now 抓的是**屏幕**：`capture.js` 那条 ffmpeg 管道挂着 `-an`，一个音频字节都没有。
 * 所以模型看到的永远只有画面 —— 它不知道画面里的人在说什么、旁白讲到哪了。
 * `dsh-video-storyboard` 有 ASR，是因为它读的是文件、有音轨；实时看屏幕没有这条捷径。
 *
 * ## 这条链怎么分工
 *
 *    Python（examples/floating-chat/listen.py）
 *      WASAPI loopback 抓系统输出 → 16k 单声道 → 按静音断句 → `seg-<epochMs>.wav`
 *    Node（这里）
 *      扫目录取 wav → canonicalizeWav → 宿主 speechToText / 本地 HTTP → `{t0,t1,text}`
 *
 * 采集放 Python、转写放 Node，不是随手分的：
 *   - 抓回环只能走 pyaudiowpatch（PortAudio 官方不暴露 loopback 设备，实测 sounddevice
 *     的 WASAPI host API 里只有麦克风），那是 Python 包；
 *   - 宿主 `speechToText` 是 Node 侧的服务，只能在 Node 里调。
 *
 * ## 时间码为什么用 epoch 毫秒
 *
 * WASAPI loopback **静音时不推送数据**（实测 3 秒静音 callback 触发 0 次），
 * 样本数累加出来的时间是错的。而墙上时间是真实世界在走 —— 所以文件名里带
 * 段首的 epoch 毫秒，Node 侧拿它跟画面帧的 wall clock 对齐，中间静音多久都不漂。
 *
 * ## 部署（三级降级，永远不让"看屏幕"起不来）
 *
 *   1. 宿主 `speechToText`（DSH 桌面版自带 SenseVoice）—— 社区用户零安装
 *   2. `~/.dsh/asr.json` 指的 OpenAI 兼容服务（本地 :8000 那种）
 *   3. 都没有 → 不起 Python、不出字幕，`status` 里说明原因，看画面一切照旧
 */

import { spawn, spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LISTEN_DEFAULTS, PREFER_KEYS } from './tuning.js';
import { pyLauncherPythons } from './window.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const LISTEN_SCRIPT = join(HERE, '..', 'examples', 'floating-chat', 'listen.py');

/** 台词缓冲保留多久（毫秒）。看屏幕是长期会话，不修剪会一直涨。 */
const KEEP_MS = 180_000;
/** 连续失败几次就停（每 3 秒一句，坏一次不算坏，一直坏就别耗着了）。 */
const MAX_FAILS = 3;
/**
 * 失败到上限后隔多久重试。
 *
 * 30 秒是照着"本地服务冷启动"定的：模型加载实测要 20~30 秒，
 * 比这更短只是在它还没 ready 的时候反复打空。
 */
const RETRY_MS = 30_000;

/**
 * 把 ffmpeg/PortAudio 风格的 WAV 改写成宿主认的 **canonical** 形式。
 *
 * 宿主的 `validateWave()` 逐字节认死三条：`RIFF size === len - 8`、`data` 块
 * **必须正好在偏移 36**、`data size === len - 44`。而**管道写的 WAV 做不到前两条**
 * （长度回填不了，只能写 0xFFFFFFFF），ffmpeg 还会插一个 `LIST/INFO` 把 data 顶到 70。
 * 三条全灭 → 宿主抛 "Audio must be a canonical 16 kHz mono PCM16 WAV recording"，
 * 上层只看到一句 asr-failed，日志里毫无线索（2026-11-02 macOS 实报）。
 *
 * 这段和 `dsh-video-storyboard/src/storyboard/host-asr.js` 是同一套逻辑 ——
 * 两边都不想去依赖对方（see-now 对 storyboard 没有依赖），所以各自留一份。
 *
 * @param {Buffer|Uint8Array} input
 * @returns {Buffer} 44 字节头 + PCM
 */
export function canonicalizeWav(input) {
  const bytes = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < 44 || bytes.toString('latin1', 0, 4) !== 'RIFF'
    || bytes.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV（缺 RIFF/WAVE 头）');
  }
  let p = 12;
  let fmt = null;
  let payload = null;
  while (p + 8 <= bytes.length) {
    const id = bytes.toString('latin1', p, p + 4);
    const size = bytes.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === 'data') {
      const end = size === 0xFFFFFFFF ? bytes.length : Math.min(bytes.length, body + size);
      payload = bytes.subarray(body, end - ((end - body) & 1));
      break;
    }
    if (id === 'fmt ' && size >= 16 && body + 16 <= bytes.length) fmt = bytes.subarray(body, body + 16);
    if (size === 0xFFFFFFFF || body + size > bytes.length) break;
    p = body + size + (size & 1);
  }
  if (!fmt) throw new Error('WAV 里没有 fmt 块');
  if (!payload) throw new Error('WAV 里没有 data 块');

  const out = Buffer.alloc(44 + payload.length);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(out.length - 8, 4);
  out.write('WAVE', 8, 'latin1');
  out.write('fmt ', 12, 'latin1');
  out.writeUInt32LE(16, 16);
  fmt.copy(out, 20);
  out.write('data', 36, 'latin1');
  out.writeUInt32LE(payload.length, 40);
  payload.copy(out, 44);
  return out;
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) ?? {}; } catch { return {}; }
}

function dshHome(env = process.env) {
  return env.DSH_HOME || join(homedir(), '.dsh');
}

// ------------------------------------------------------------------ 转写

/**
 * 宿主 `speechToText` 适配器。取法和 storyboard 一致：`ctx.get(name)`，
 * **不能写 `ctx.speechToText`** —— cordis 对未声明的服务在 get 陷阱里直接抛，`?.` 挡不住。
 *
 * @returns {null | ((wav:Buffer) => Promise<string>)}
 */
export function hostTranscriber(ctx, { language = 'zh', timeoutMs = 30_000 } = {}) {
  let svc = null;
  try { svc = ctx?.get?.('speechToText') ?? null; } catch { svc = null; }
  if (!svc || typeof svc.resolve !== 'function' || typeof svc.transcribe !== 'function') return null;

  /** 模型不会因为"服务在"就自动加载；先 prepare 再等它 ready（最多 5 秒，等不到就直接试）。 */
  async function providerId() {
    if (typeof svc.snapshot !== 'function') return undefined;
    const id = svc.snapshot()?.selection?.providerId;
    if (!id) return undefined;
    const view = () => svc.snapshot()?.providers?.find((v) => v.id === id);
    const phase = () => view()?.preparation?.phase;
    if (!phase() || phase() === 'ready' || phase() === 'standby') return id;
    if (typeof svc.prepare !== 'function') return id;
    try { svc.prepare(id); } catch { return id; }
    const until = Date.now() + 5_000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 150));
      const p = phase();
      if (p === 'ready' || p === 'standby' || p === 'failed') return id;
    }
    return id;
  }

  return async function viaHost(wav) {
    const id = await providerId();
    const spec = svc.resolve({
      audio: new Uint8Array(wav), language, ...(id ? { providerId: id } : {}),
    });
    const r = await svc.transcribe(spec, AbortSignal.timeout(timeoutMs));
    return String(r?.text ?? '').trim();
  };
}

/** `~/.dsh/asr.json`（和 storyboard 共用同一份配置）：`{baseUrl, key, model, language}` */
/**
 * 转写服务的**协议形态**。`asr.json` 的 `api` 字段选它。
 *
 * - `openai-audio`（默认）：OpenAI 的 `/audio/transcriptions`，multipart 上传音频。
 *   所有说自己"OpenAI 兼容语音接口"的服务都是这个。
 * - `chat-audio`：`/chat/completions`，音频 base64 塞进 `messages[].content[].input_audio`。
 *   小米 MiMo-V2.5-ASR 是这种。它文档标题写「OpenAI API 兼容」，但兼容的是**聊天**
 *   接口 —— 端点、请求体、返回结构三样都和音频接口不同，直接换 baseUrl 会 404。
 *
 * 加这一档不是为了某一家：把"转写服务"绑死在一种协议上，等于把那些只提供聊天形态
 * 的模型挡在门外。
 */
export const ASR_APIS = Object.freeze(['openai-audio', 'chat-audio']);

export function asrConfig(env = process.env) {
  const home = dshHome(env);
  const cfg = readJson(join(home, 'asr.json'));
  const baseUrl = env.DSH_ASR_BASE_URL || cfg.baseUrl || '';
  if (!baseUrl) return null;
  const api = String(env.DSH_ASR_API || cfg.api || 'openai-audio');
  return {
    baseUrl: String(baseUrl).replace(/\/+$/, ''),
    /** 协议形态。写错了退回默认 —— 拼错一个词不该让整个听写不可用。 */
    api: ASR_APIS.includes(api) ? api : 'openai-audio',
    key: env.DSH_ASR_KEY || cfg.key || '',
    model: env.DSH_ASR_MODEL || cfg.model || 'paraformer-zh-2024-03-09',
    language: env.DSH_ASR_LANGUAGE || cfg.language || 'zh',
    /**
     * `manage` 必须原样带出来 —— 它是"服务没起时怎么拉起"的唯一来源。
     * 早先这里只挑了 4 个字段，于是 `ensureService` 永远报"没写 manage.start"，
     * 服务永远不会被拉起（2026-11-04 排查"看不到字幕"时发现）。
     */
    manage: cfg.manage && typeof cfg.manage === 'object' ? cfg.manage : undefined,
  };
}

/**
 * 把一段 wav 交给转写服务（see-now 自己不发音频给模型，只转交给用户配的那个服务）。
 *
 * 两种协议形态，按 `cfg.api` 分：
 * - `openai-audio`：multipart 打 `/audio/transcriptions`，读 `text`
 * - `chat-audio`：JSON 打 `/chat/completions`，读 `choices[0].message.content`
 */
/**
 * 发一个 POST，走 `node:http` / `node:https` 而不是全局 `fetch`。
 *
 * 为什么不用 fetch：宿主里可能装着会包住 `fetch` 的插件（billion-context 就是），
 * 它把每个经过 fetch 的目标都当成自己的"上游"去探测，连不上就挂一条
 * 「上游不可用 · connect-refused ×3」。转写请求发往 127.0.0.1:8000，一旦被那种
 * 插件看见，就会被登记成一个假上游，界面上于是常年挂着一条"服务不可用"的提示 ——
 * 而实际原因可能只是面板没刷新。用自己的 http 通道，这条请求就只属于我们。
 */
function send(urlStr, { method = 'POST', headers = {}, body = null, signal, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (e) {
      reject(e);
      return;
    }
    const mod = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = mod(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)));
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error('aborted'));
        return;
      }
      signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }
    if (body) req.write(body);
    req.end();
  });
}

/** 手写 multipart：只要一个文件 + 几个文本字段，不值得为它引一个依赖。 */
function buildMultipart(fields, boundary) {
  const parts = [];
  for (const f of fields) {
    parts.push(Buffer.from(`--${boundary}\r\n`));
    if (f.filename) {
      parts.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\n` +
            `Content-Type: ${f.type || 'application/octet-stream'}\r\n\r\n`,
        ),
      );
      parts.push(Buffer.from(f.data));
      parts.push(Buffer.from('\r\n'));
    } else {
      parts.push(Buffer.from(`Content-Disposition: form-data; name="${f.name}"\r\n\r\n${f.value}\r\n`));
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(parts);
}
export function httpTranscriber(cfg, { timeoutMs = 30_000, log = () => {} } = {}) {  if (!cfg?.baseUrl) return null;
  const chat = cfg.api === 'chat-audio';
  return async function viaHttp(wav) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = chat
        ? await postChatAudio(cfg, wav, ac.signal, timeoutMs)
        : await postOpenAiAudio(cfg, wav, ac.signal, timeoutMs);
      if (!res.ok) throw new Error(`HTTP ${res.status}：${(await res.text()).slice(0, 120)}`);
      const j = await res.json();
      return chat ? chatAudioText(j) : String(j?.text ?? '').trim();
    } catch (e) {
      log(`转写失败：${e?.message ?? e}`);
      // **必须抛**。以前这里 `return ''`，于是上层看到的只是"这段没说话"：
      // 失败计数永远不涨、永远不停、status 里永远是"在听、0 句" ——
      // 服务根本没起的时候，界面上和"视频是默片"一模一样（2026-11-04 实报）。
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };
}

function postOpenAiAudio(cfg, wav, signal, timeoutMs) {
  const boundary = `----seenow${Math.random().toString(16).slice(2)}`;
  const body = buildMultipart(
    [
      { name: 'file', filename: 'a.wav', type: 'audio/wav', data: wav },
      { name: 'model', value: cfg.model },
      { name: 'response_format', value: 'json' },
      { name: 'language', value: cfg.language || 'zh' },
    ],
    boundary,
  );
  return send(`${cfg.baseUrl}/audio/transcriptions`, {
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
      ...(cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}),
    },
    body,
    signal,
    timeoutMs,
  });
}

function postChatAudio(cfg, wav, signal, timeoutMs) {
  const body = {
    model: cfg.model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'input_audio',
            // 纯 base64 + format，不用 data URL：OpenAI 原生与小米两种写法都认这种，
            // 而 data URL 只有部分服务认。
            input_audio: { data: Buffer.from(wav).toString('base64'), format: 'wav' },
          },
        ],
      },
    ],
  };
  if (cfg.language) body.asr_options = { language: cfg.language };
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return send(`${cfg.baseUrl}/chat/completions`, {
    headers: {
      'content-type': 'application/json',
      'content-length': String(payload.length),
      ...(cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}),
    },
    body: payload,
    signal,
    timeoutMs,
  });
}

/** `choices[0].message.content` 可能是字符串，也可能是分段数组。 */
function chatAudioText(j) {
  const c = j?.choices?.[0]?.message?.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) {
    return c.map((p) => (typeof p === 'string' ? p : (p?.text ?? ''))).join('').trim();
  }
  return '';
}

// ------------------------------------------------------------------ 本地服务

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 端点活着吗。2 秒超时 —— 本地服务要么秒回要么没起，等再久没意义。 */
export async function probeService(baseUrl, { timeoutMs = 2000 } = {}) {
  try {
    const origin = new URL(baseUrl).origin;
    const res = await send(`${origin}/health`, { method: 'GET', timeoutMs });
    return res.ok;
  } catch { return false; }
}

/**
 * 本地转写服务没在跑就拉起来（按 `~/.dsh/asr.json` 的 `manage.start`）。
 *
 * 为什么必须有：那个服务是**空闲就退**的（`idleMs: 5000`），平时根本不在。
 * storyboard 有 `asr-lifecycle.js` 负责按需拉起，see-now 原来没有 ——
 * 表现就是"听得见、但一句台词都转不出来"，而界面上还显示"在听"。
 *
 * **只管拉、不管关**：服务自己有 idleMs，用完自己走。我们只保证"要用的时候它在"。
 */
/** `python.exe` → 同目录的 `pythonw.exe`。

 * `asr.json` 的 `manage.start` 里写的是 `python.exe`（console app）。`windowsHide`
 * 对**大多数**情况够用，但商店版/某些包装器仍会闪一个黑框 —— 用户看到的就是
 * "用着用着弹一个 ASR 窗口"。`pythonw.exe` 从根上不开控制台；`stdio:'ignore'`
 * 会把它的 stdout 接到 NUL，服务里的 `print` 不会因为 `sys.stdout is None` 炸。
 */
function withoutConsole(exe) {
  try {
    if (process.platform !== 'win32') return exe;
    if (basename(String(exe)).toLowerCase() !== 'python.exe') return exe;
    const guess = join(dirname(String(exe)), 'pythonw.exe');
    return existsSync(guess) ? guess : exe;
  } catch {
    return exe;
  }
}

export async function ensureService(cfg, { log = () => {}, waitMs = 60_000 } = {}) {
  const start = cfg?.manage?.start;
  if (!start) return { ok: false, reason: 'asr.json 里没写 manage.start' };
  if (await probeService(cfg.baseUrl)) return { ok: true, already: true };

  const cmd = Array.isArray(start) ? start.map(String) : [String(start)];
  const [rawExe, ...args] = cmd;
  const exe = withoutConsole(rawExe);
  log(`转写服务没在跑，拉起：${[exe, ...args].join(' ')}`);
  // `asr.json` 的 `idleMs` 是**毫秒**，而服务读的是环境变量 `ASR_IDLE_EXIT_S`（秒）。
  // 不传的话它用自带的 300 秒 —— 用户看到的就是"see 已经关了，ASR 还在跑五分钟"。
  const env = { ...process.env };
  const idleMs = Number(cfg?.manage?.idleMs);
  if (Number.isFinite(idleMs) && idleMs > 0) env.ASR_IDLE_EXIT_S = String(idleMs / 1000);
  /**
   * **spawn 失败是异步的**：exe 不存在（ENOENT）不会被下面的 try 接住，而是在下一拍
   * 以 `'error'` 事件发出来 —— 没人监听就是 uncaught，**整个宿主进程直接退出**。
   * Windows 上最常见：`manage.start: ["python", ...]`，而 python.org 默认安装不进 PATH。
   */
  let spawnErr = null;
  try {
    // 脚本目录当 cwd：很多服务按相对路径找模型
    const cwd = args[0] ? dirname(args[0]) : undefined;
    const child = spawn(exe, args, {
      detached: true, stdio: 'ignore', windowsHide: true, env, ...(cwd ? { cwd } : {}),
    });
    child.once('error', (e) => {
      spawnErr = e;
      log(`转写服务起不来：${e?.code ?? e?.message ?? e}（${exe}）`);
    });
    child.unref();
  } catch (e) {
    return { ok: false, reason: `起不来：${e?.message ?? e}` };
  }

  const spawnFailed = () => ({ ok: false, reason: `起不来：${spawnErr?.code ?? spawnErr?.message ?? spawnErr}（${exe}）` });
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    // 短步长先睡：spawn 的 'error' 在下一拍就到，没必要让用户白等满 1 秒
    for (let i = 0; i < 10 && !spawnErr; i += 1) await sleep(100);
    if (spawnErr) return spawnFailed();
    if (await probeService(cfg.baseUrl)) return { ok: true, waitedMs: waitMs - (until - Date.now()) };
  }
  if (spawnErr) return spawnFailed();
  return { ok: false, reason: `等了 ${Math.round(waitMs / 1000)} 秒还没就绪` };
}

/**
 * 选一个能用的转写器。
 *
 * `prefer`（`see-now.json` 的 `listen.prefer`）决定用哪个：
 *
 * - `auto`  —— 宿主优先，没有就回落 `~/.dsh/asr.json`。默认值，社区用户零安装。
 * - `host`  —— 只用宿主自带的 `speechToText`。
 * - `local` —— 只用 `~/.dsh/asr.json` 指的服务，**不碰宿主**。
 *
 * 后两个**不互相顶替**。用户之所以去指定，是因为他知道两边转出来的东西不一样
 * （宿主 SenseVoice 走 CPU、70ms 级；自建服务往往在 GPU 上、带字级时间码）——
 * 悄悄回落到他没选的那个，比"没有字幕"更难查：界面显示在听，说的却不是他以为的那个引擎。
 */
export function resolveTranscriber(ctx, { env = process.env, log = () => {}, prefer = 'auto' } = {}) {
  const want = PREFER_KEYS.includes(prefer) ? prefer : 'auto';

  const pickHost = () => {
    const fn = hostTranscriber(ctx);
    return fn ? { kind: 'host', transcribe: fn, label: '宿主 SenseVoice' } : null;
  };
  const pickLocal = () => {
    const cfg = asrConfig(env);
    // 没配 baseUrl 就别造一个必然失败的转写器 —— 那种失败要等到第一次真请求才暴露，
    // 表现是"在听、0 句"，和"视频是默片"分不开
    if (!cfg) return null;
    const fn = httpTranscriber(cfg, { log });
    return fn ? { kind: 'http', transcribe: fn, label: `本地 ${cfg.baseUrl}` } : null;
  };

  if (want === 'host') return pickHost();
  if (want === 'local') return pickLocal();
  return pickHost() ?? pickLocal();
}

// ------------------------------------------------------------------ 静音窗口

/**
 * 静音窗口文件的路径。**默认和陪看共用同一个文件**（`$DSH_HOME/watch/out/quiet-until.json`）。
 *
 * 共用的理由：这个文件回答的是"这台机器上现在有没有人在念话"，跟是哪个插件在念无关。
 * 陪看的 `bin/watch.mjs` 写它（防两个 SAPI 抢话），`mic.py` 读它（防麦克风听见自己），
 * 我们两边都要 —— 写自己那份的话，麦克风那条就漏了。
 */
export function quietFile(env = process.env) {
  return env.DSH_QUIET_FILE || join(dshHome(env), 'watch', 'out', 'quiet-until.json');
}

/**
 * 占住静音窗口：告诉采集"接下来这几秒我在念，别听"。
 *
 * ⚠️ 这不是"屏蔽自己"，是**闭嘴不听** —— 窗口内整段音频直接丢，代价是：
 * 如果用户正好在这几秒说话、或者视频里正好有人在说台词，那一段也没了。
 *
 * 为什么不真做回声消除（AEC）：回环抓的是**系统混音后的成品**，AI 的声音和视频的声音
 * 在同一个信号里线性叠加，要减干净得知道它播出的每一个样本、确切时刻、以及系统音量与
 * 重采样链 —— 差一点就是减不干净的残差，而 ASR 对残差比对人声更敏感（会吐出更怪的句子）。
 * `aec.py` 那套是给麦克风用的（电信号 vs 空气传播，两条不同路径），套到回环上不成立。
 *
 * 真正的"只抓视频、不抓自己"要**按进程分轨**（Windows 的 process loopback），
 * 只能抓浏览器/播放器的音频树，AI 从别的进程出来的声音根本进不来。那是另一件事，
 * 要写 COM（`ActivateAudioInterfaceAsync`），pyaudiowpatch 没有这个能力。
 *
 * ## 谁该调它、什么时候调（issue #33）
 *
 * 以前只有 `due` 调，而 `due` 是"该念了"，**不是"出声了"**。慢 TTS（本机合成要 30~60 秒）
 * 的情况：`due` 那一刻占的窗口早就过期了，等声音真出来，回环把它当视频台词收回去 ——
 * 模型接着自己的话聊，停不下来。
 *
 * 所以 `spoken`（适配器在开始播放那一瞬发的）**也必须调一次**，从真正出声的那一刻
 * 重新起算。两条都调不冲突：`due` 那次是提前占位（快 TTS 靠它），`spoken` 那次是纠偏，
 * 后写的 `until` 会直接覆盖前者（长了就延长，短了就缩短 —— 快 TTS 多聋几秒正是这个原因）。
 *
 * @param {{env?:object, extraMs?:number, durationMs?:number}} [opts]
 *   `durationMs`：适配器知道的音频真实时长。给了就用它，字数只是拿不到时长时的兜底 ——
 *   按字数估算对慢语速会低估、对 edge-tts 这种快语速会高估，两个方向都会出问题。
 * @returns {number|null} 静音到什么时候（epoch ms）
 */
export function markSpeaking(text, { env = process.env, extraMs = 1200, durationMs = null } = {}) {
  const chars = String(text ?? '').trim().length;
  const real = Number(durationMs);
  if (!chars && !(Number.isFinite(real) && real > 0)) return null;
  /**
   * 有真实时长就用真实的（+ 收尾余量）；没有才退回字数估算。
   * 中文约 4~5 字/秒，取 4 再乘 1.5 倍余量 —— **宁可多静音，也别把自己的话变成台词**。
   */
  const ms = Number.isFinite(real) && real > 0
    ? Math.ceil(real) + extraMs
    : Math.ceil((chars / 4) * 1000 * 1.5) + extraMs;
  const until = Date.now() + ms;
  try {
    const p = quietFile(env);
    mkdirSync(dirname(p), { recursive: true });
    const body = { until, at: Date.now(), by: 'see-now' };
    if (Number.isFinite(real) && real > 0) body.durationMs = Math.round(real);
    writeFileSync(p, JSON.stringify(body), 'utf8');
  } catch { /* 写不了最多是"可能听见自己"，别让它影响念 */ }
  return until;
}

// ------------------------------------------------------------------ Python

const PY_PROBE = 'import pyaudiowpatch, numpy';

/** 这个解释器有没有抓回环要的两个包（真跑一次 import，名字像没用）。 */
export function canListen(python) {
  const r = spawnSync(python, ['-c', PY_PROBE], { timeout: 8000, windowsHide: true, stdio: 'ignore' });
  return r?.status === 0;
}

/**
 * 找解释器。顺序：
 *   1. `DSH_SEE_PYTHON`（调试/临时）
 *   2. `~/.dsh/see-window.json` 的 `listenPython` / `python`
 *   3. PATH 上的 python3/python/pythonw（win32 顺序不同）
 *
 * 注意 **window.py 用的那个解释器未必有 pyaudiowpatch**（商店版 Python 往往没有），
 * 所以这里不看 tkinter，只看能不能 import。
 */
export function findListenPython({ env = process.env } = {}) {
  const cfg = readJson(join(dshHome(env), 'see-window.json'));
  const list = [
    env.DSH_SEE_PYTHON,
    cfg.listenPython,
    cfg.python,
    env.DSH_FLOAT_PYTHON,
    ...(process.platform === 'win32'
      // `py` 启动器兜底：python.org 默认安装不进 PATH（见 window.js 的 pyLauncherPythons）
      ? ['python.exe', 'pythonw.exe', ...pyLauncherPythons().slice().reverse()]
      : ['python3', 'python']),
  ].filter(Boolean);
  for (const py of [...new Set(list)]) {
    if (canListen(py)) return py;
  }
  return null;
}

// ------------------------------------------------------------------ 台词缓冲

/**
 * 台词缓冲。抽出来是为了可测 —— 时间窗过滤这种东西，靠"起个 Python 真录一段"
 * 是测不出边界（跨窗、超长、乱序）的。
 *
 * `t0/t1` 都是 epoch 毫秒。
 */
export function createLineBuffer({ keepMs = KEEP_MS } = {}) {
  let lines = [];
  const put = (t0, t1, t, partial) => {
    const entry = { t0, t1, text: t, partial };
    lines.push(entry);
    // 修剪：只留最近 keepMs。看屏幕是长期会话，两三小时不修剪就是几千条
    if (lines.length > 8) {
      const cut = Date.now() - keepMs;
      lines = lines.filter((l) => l.t1 >= cut);
    }
    return entry;
  };
  return {
    add(t0, t1, text) {
      const t = String(text ?? '').trim();
      if (!t) return null;
      return put(t0, t1, t);
    },
    /**
     * 写入/覆盖同一句的台词。
     *
     * 为什么需要覆盖：长句「边说边出」会先给一版 `partial` 快照，整句落盘后再给准确版。
     * 判据是 **t0 相同就是同一句**（t0 是句首的墙上时间，由 Python 侧那一段唯一决定）。
     *
     * 两条铁律：
     *  - **整句永远盖过快照**（`prev.partial === false && partial` 时不许覆盖）；
     *  - **快照不许把整句改回 partial**（同一句的迟到快照直接丢掉）。
     *
     * @param {{partial?:boolean}} [o]
     */
    upsert(t0, t1, text, { partial = false } = {}) {
      const t = String(text ?? '').trim();
      if (!t) return null;
      // 从后往前找：同一句的快照和整句都在尾部，比从头扫快
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const l = lines[i];
        if (l.t0 !== t0) continue;
        if (l.partial === false && partial) return l;
        l.t1 = t1;
        l.text = t;
        l.partial = partial;
        return l;
      }
      return put(t0, t1, t, partial);
    },
    /**
     * 取某段时间窗里的台词。**窗口按相交算**（`l.t1 >= from && l.t0 <= to`），
     * 跨窗的那句两边都算 —— 宁可让模型看到同一句两次（它只会觉得啰嗦），
     * 也不要漏掉（漏了它就完全不知道这段说了什么）。
     *
     * 超长时**从新往旧丢**：最近的话更相关。
     */
    between(fromMs, toMs, { maxChars = 1200 } = {}) {
      if (!lines.length) return [];
      const out = [];
      let chars = 0;
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const l = lines[i];
        if (l.t1 < fromMs || l.t0 > toMs) continue;
        if (chars + l.text.length > maxChars && out.length) break;
        out.push(l);
        chars += l.text.length;
      }
      return out.reverse();
    },
    /** 这句有没有**完整版**了（整句比快照准，有它就不必再转快照）。 */
    hasFinal(t0) {
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const l = lines[i];
        if (l.t0 === t0) return l.partial === false;
      }
      return false;
    },
    /**
     * 清空。
     *
     * 一次听音会话的台词只属于那一次会话：采集重启后（stop → watch），旧句子如果
     * 还留在缓冲里，第一张图的时间窗会从"上一轮结束"算起，把它们当成这一轮说的话
     * 挂上去，偏移还是负的（issue #39）。所以 `start()` 里先清一次。
     */
    reset() {
      lines = [];
    },
    get size() { return lines.length; },
    get all() { return lines.slice(); },
  };
}

// ------------------------------------------------------------------ 主体

/**
 * @param {object} o
 * @param {object|null} o.ctx        宿主 ctx（取 speechToText）
 * @param {string} [o.dir]           wav 落盘目录（默认 `~/.dsh/see-now/audio`）
 * @param {string} [o.python]        解释器（默认自动找）
 * @param {string} [o.script]        listen.py（默认包内那份）
 * @param {NodeJS.ProcessEnv} [o.env]
 */
export function createListener({
  ctx = null, dir = null, python = null, script = LISTEN_SCRIPT,
  /**
   * 延迟参数（`~/.dsh/see-now.json` 的 `listen` 段，见 tuning.js）。
   *
   * 分两半：`silence` / `maxSeg` / `live` 那组交给 Python 侧（它们决定"什么时候切一段"），
   * `pollMs` 留在这里（决定"多久扫一次目录"）。
   */
  listen = LISTEN_DEFAULTS,
  env = process.env, log = () => {}, pollMs = null,
  /**
   * 测试注入口：给一个转写器就完全不碰 `resolveTranscriber` / Python / 设备。
   * 线上永远不传 —— `drain()` 是这条链里最容易出错的地方（覆盖、去重、失败不退），
   * 不能只靠"起个真设备听一遍"来验。
   */
  transcriber: injected = null,
} = {}) {
  const audioDir = dir || join(dshHome(env), 'see-now', 'audio');
  const cfg = { ...LISTEN_DEFAULTS, ...(listen ?? {}) };
  // `pollMs` 显式传值时优先（老测试还在用），否则读配置
  const pollInterval = Number.isFinite(Number(pollMs)) && Number(pollMs) > 0
    ? Number(pollMs) : cfg.pollMs;
  const buffer = createLineBuffer();
  let child = null;
  let timer = null;
  let busy = false;
  let fails = 0;
  let enabled = Boolean(injected);
  let reason = '没启动';
  let transcriber = injected;
  let lastSegAt = 0;
  let total = 0;
  /** 最近一句的延迟：从**句首**到**进了台词缓冲**（毫秒）。status 里直接看得见。 */
  let lastLineLagMs = null;
  /** 临时快照（`partial`）转成功过几次 —— 用来判断"边说边出"到底有没有在干活 */
  let partials = 0;
  /** live 文件去重：`name -> "size:mtime"`。同名覆盖是常态，内容变了才重转。 */
  const liveSeen = new Map();
  /** 音量条数据：`{step, from, db[]}`，Python 那边每秒原子重写一次 levels.json */
  let levels = null;
  let levelsAt = 0;
  /** 转写连续失败时的暂停截止时间（epoch ms）。见 drain 里的注释。 */
  let pausedUntil = 0;
  /** 最近一次转写错误（status 里要看得见，不能只进日志） */
  let lastError = null;
  /** 上次主动拉起本地服务的时刻（60 秒内不重复拉，免得起两个抢端口） */
  let lastEnsureAt = 0;
  /** 快照失败只记一次日志（成功一次就复位），别每拍刷屏 */
  let liveErrLogged = false;

  function state() {
    return {
      enabled,
      reason,
      backend: transcriber?.label ?? null,
      python: python ?? null,
      dir: audioDir,
      lines: buffer.size,
      total,
      lastSegAt: lastSegAt || null,
      /** 最近一句从**开口**到**台词可读**用了多久（毫秒）。调延迟就看这个数。 */
      lastLineLagMs,
      /** 正在说话时先给的那版临时台词转成功过几次（"边说边出"有没有在干活） */
      partials,
      /** 转写出过错就带上原因 —— "在听但没台词"必须能分清是没人说话还是转写挂了 */
      error: lastError,
      paused: pausedUntil > Date.now(),
      /** 生效的延迟参数：用户改 see-now.json 之后一眼能核对 */
      tuning: { ...cfg },
    };
  }

  /**
   * 读音量序列（每秒最多读一次 —— Python 那边就是这么写的，读更勤只是白扫盘）。
   *
   * 这东西**和转写是两条独立的线**：转写要等一整句说完，音量条是即时的。
   * 所以哪怕转写服务挂了、或者全是纯音乐没人说话，音量条照样有。
   */
  function pollLevels() {
    if (Date.now() - levelsAt < 900) return;
    levelsAt = Date.now();
    try {
      const raw = JSON.parse(readFileSync(join(audioDir, 'levels.json'), 'utf8'));
      if (Array.isArray(raw?.db) && raw.db.length) levels = raw;
    } catch { /* 还没写出来 / 正在 rename，下一次再说 */ }
  }

  /**
   * 取某段时间窗的音量序列，**对齐到 `wallFrom`**（第一格就是这一秒的声音）。
   *
   * 返回的 `db` 长度按 `span/step` 算死 —— 画条时按列聚合，长度不对就整体错位
   * （图上的柱子比声音晚半秒，看着像卡带）。
   *
   * @returns {null | {step:number, db:number[]}}
   */
  function levelsBetween(wallFrom, wallTo, { maxPoints = 900 } = {}) {
    pollLevels();     // 自己读一次：转写那条线挂了（或者全是纯音乐）也照样有音量条
    if (!levels || !(wallTo > wallFrom)) return null;
    const stepMs = (Number(levels.step) || 0.1) * 1000;
    const span = wallTo - wallFrom;
    const n = Math.round(span / stepMs);
    if (n < 2) return null;
    const count = Math.min(n, maxPoints);
    const out = [];
    for (let i = 0; i < count; i += 1) {
      const t = wallFrom + (i * span) / count;
      const k = Math.round((t - levels.from) / stepMs);
      const v = k >= 0 && k < levels.db.length ? levels.db[k] : -120;
      out.push(Number.isFinite(v) ? v : -120);
    }
    return { step: span / count / 1000, db: out };
  }

  /**
   * 扫目录，处理没见过的 wav。**一次一条，串行** —— 本地 paraformer 是单线程的
   * （实测 3 个并发总共 530ms ≈ 串行 522ms），并发打进去只会互相排队。
   *
   * 两类文件：
   *  - `seg-<t0>.wav` —— 一句完整的（静音断句 / maxSeg 强切），**准的**；
   *  - `live-<t0>.wav` —— 长句说到一半的快照，**同名覆盖**，只是让字幕早几秒出现。
   *
   * 顺序是 **先 seg 后 live**：seg 落盘意味着这句已经说完，对应的 live 文件马上会被
   * Python 删掉；先转 seg 能避免"白转一次马上被覆盖的快照"。
   */
  async function drain() {
    if (busy || !transcriber) return;
    /**
     * **连续失败不 stop，只暂停**。
     *
     * 以前是"3 次就收工"，可最常见的那种失败（本地服务没起 / 正在冷启动 30 秒）
     * 完全会自己好起来 —— 那时候把整条链停掉，等于永久放弃。而且停掉会连带
     * kill 采集进程，音量条也没了。
     *
     * 暂停期间**不删文件**（留着等重试），到点先重新探活/拉起服务。
     */
    if (pausedUntil) {
      if (Date.now() < pausedUntil) return;
      pausedUntil = 0;
      fails = 0;
      // prefer=host 时本地服务根本不在候选里，拉起来只是白开一个进程再等它自己睡
      if (cfg.prefer !== 'host') ensureService(asrConfig(env), { log }).catch(() => {});
    }
    busy = true;
    try {
      pollLevels();       // 音量条和转写共用这一拍，但它自己节流到 1 秒一次
      let names = [];
      try { names = readdirSync(audioDir); } catch { names = []; }
      let segs = names
        .filter((n) => /^seg-\d+\.wav$/.test(n))
        .sort((a, b) => Number(a.slice(4, -4)) - Number(b.slice(4, -4)));
      // 转写长期不通时目录会堆 —— 只留最新的 40 段，老的直接扔
      if (segs.length > 40) {
        for (const old of segs.slice(0, segs.length - 40)) {
          try { unlinkSync(join(audioDir, old)); } catch { /* 删不掉算了 */ }
        }
        segs = segs.slice(-40);
      }
      const lives = names.filter((n) => /^live-\d+\.wav$/.test(n));
      if (env.DSH_SEE_NOW_DEBUG) {
        log(`[listen] drain: 目录里 ${names.length} 个文件，整句 ${segs.length} / 快照 ${lives.length}`);
      }

      for (const name of segs) {
        const path = join(audioDir, name);
        let wav = null;
        try {
          // Python 侧是「写 .tmp 再 rename」，所以这里看到的都是完整的；
          // 但如果是老版本/被手动塞进来的，size 为 0 就跳过，别拿去转写。
          if (statSync(path).size < 1024) continue;
          wav = readFileSync(path);
        } catch { continue; }
        const t0 = Number(name.slice(4, -4));
        let text = '';
        try {
          text = await transcriber.transcribe(canonicalizeWav(wav));
          fails = 0;
          lastError = null;
        } catch (e) {
          fails += 1;
          lastError = String(e?.message ?? e);
          log(`转写出错（${fails}/${MAX_FAILS}）：${lastError}`);
          /**
           * **第一次失败就顺手把本地服务拉起来**（不 await，不挡这条链）。
           *
           * `asr.json` 的 `manage.idleMs` 常配成几秒 —— 视频安静一会儿服务就自己睡了，
           * 再说话时第一个请求必然 `fetch failed`。等失败 3 次才动手（旧逻辑）要白丢
           * 30 秒字幕；这里第一次就 spawn。60 秒内不重复拉，免得起了两个抢端口。
           */
          if (transcriber?.kind === 'http' && Date.now() - lastEnsureAt > 60_000) {
            lastEnsureAt = Date.now();
            ensureService(asrConfig(env), { log }).catch(() => {});
          }
          if (fails >= MAX_FAILS) {
            pausedUntil = Date.now() + RETRY_MS;
            reason = `在听（音量条还在），但转写连续失败：${lastError}`;
          }
          continue;      // **不删文件** —— 服务起来之后这些段还要用
        }
        // 处理完就删：目录是工作区，不是档案。留着会几小时涨到几千个文件。
        try { unlinkSync(path); } catch { /* 删不掉就下次再说 */ }
        // 这句已经有准的了，它的临时快照（还没转的）不必再转
        liveSeen.delete(`live-${t0}.wav`);
        if (!text) continue;
        const dur = Math.max(0.2, (wav.length - 44) / 2 / 16_000);
        const t1 = t0 + Math.round(dur * 1000);
        // **upsert**：同一句如果先出过快照，这里用整句结果把它盖掉
        buffer.upsert(t0, t1, text, { partial: false });
        lastSegAt = Date.now();
        lastLineLagMs = lastSegAt - t0;
        total += 1;
      }

      /**
       * 长句快照：只转**内容变过**的（Python 侧同名覆盖，size/mtime 一起变）。
       * 失败**不计入 `fails`** —— 它只是"提前给一版"，挂了不该把主链路暂停 30 秒。
       */
      if (!cfg.live) {
        for (const n of lives) { try { unlinkSync(join(audioDir, n)); } catch { /* 算了 */ } }
      } else {
        for (const name of lives) {
          const path = join(audioDir, name);
          const t0 = Number(name.slice(5, -4));
          // 整句已经转出来了（Python 删文件失败 / 被占用）：这个快照没用，清掉
          if (buffer.hasFinal(t0)) {
            liveSeen.delete(name);
            try { unlinkSync(path); } catch { /* 占着就下次 */ }
            continue;
          }
          let st = null;
          try { st = statSync(path); } catch { continue; }
          if (st.size < 1024) continue;
          const stamp = `${st.size}:${Math.round(st.mtimeMs)}`;
          if (liveSeen.get(name) === stamp) continue;
          liveSeen.set(name, stamp);
          let wav = null;
          try { wav = readFileSync(path); } catch { continue; }
          let text = '';
          try {
            text = await transcriber.transcribe(canonicalizeWav(wav));
            liveErrLogged = false;
          } catch (e) {
            // 快照失败**不计入 `fails`**（它只是"提前给一版"，挂了不该把主链路暂停），
            // 但也不能完全静默 —— "临时字幕为什么一直不出现"时这是唯一线索。
            if (!liveErrLogged) {
              liveErrLogged = true;
              log(`[listen] 快照转写失败（不影响整句）：${e?.message ?? e}`);
            }
            continue;
          }
          if (!text) continue;
          const dur = Math.max(0.2, (wav.length - 44) / 2 / 16_000);
          const t1 = t0 + Math.round(dur * 1000);
          const before = buffer.all.length;
          const line = buffer.upsert(t0, t1, text, { partial: true });
          if (line && buffer.all.length > before) {
            partials += 1;
            lastLineLagMs = Date.now() - t0;
          }
        }
        // 目录里可能残留上一句的快照（Python 删失败/被占用），别让它一直重转
        if (liveSeen.size > 32) {
          const keep = new Set(lives);
          for (const k of liveSeen.keys()) if (!keep.has(k)) liveSeen.delete(k);
        }
      }
    } finally {
      busy = false;
    }
  }

  /**
   * 起采集。**幂等**，失败只记状态不抛 —— 音频是加分项，装不上最多没字幕。
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async function start() {
    if (child) return { ok: true, reason: 'already' };
    // 新的一次听音会话：上一轮的台词不能留到这一轮（issue #39，偏移会是负的）
    buffer.reset();
    if (env.DSH_SEE_AUDIO === '0') {
      reason = '被 DSH_SEE_AUDIO=0 关掉了';
      enabled = false;
      return { ok: false, reason };
    }
    transcriber = injected ?? resolveTranscriber(ctx, { env, log, prefer: cfg.prefer });
    if (!transcriber) {
      // 指定了引擎就直说**是哪个**没到位 —— 指定模式下还说"没有可用的转写服务"等于没说
      reason = cfg.prefer === 'host'
        ? 'listen.prefer 是 host，但宿主没有可用的 speechToText'
        : cfg.prefer === 'local'
          ? `listen.prefer 是 local，但 ${join(dshHome(env), 'asr.json')} 里没有配 baseUrl`
          : '没有可用的转写服务（宿主没有 speechToText，也没有 ~/.dsh/asr.json）';
      enabled = false;
      return { ok: false, reason };
    }
    /**
     * 走 HTTP 就先确认本地服务在不在。
     *
     * **不 await**：服务冷启动要 20~30 秒，挡在这里会让"开始看"变成一个几十秒的空转。
     * 采集和音量条先跑，转写在后台等它就绪 —— 期间的段不删，起来之后照常处理。
     */
    if (transcriber.kind === 'http') {
      ensureService(asrConfig(env), { log })
        .then((r) => { if (!r.ok) log(`转写服务没起来：${r.reason}`); })
        .catch(() => { /* 已经在里面兜过了 */ });
    }
    if (!existsSync(script)) {
      reason = `找不到 listen.py（${script}）`;
      enabled = false;
      return { ok: false, reason };
    }
    python ??= findListenPython({ env });
    if (!python) {
      reason = '没有能用的 Python（要 `pip install pyaudiowpatch numpy`，'
        + '或把解释器路径写进 ~/.dsh/see-window.json 的 listenPython）';
      enabled = false;
      return { ok: false, reason };
    }

    mkdirSync(audioDir, { recursive: true });
    try {
      // 断句与快照参数全部透传给 Python —— 它们是"什么时候切一段"的唯一决定者
      child = spawn(python, [
        script, '--out', audioDir,
        '--silence', String(cfg.silence),
        '--max-seg', String(cfg.maxSeg),
        ...(cfg.live ? ['--live-min', String(cfg.liveMin), '--live-step', String(cfg.liveStep)] : ['--live', '0']),
        // 收工靠关 stdin（见 stop()）：Windows 的 kill() 是 TerminateProcess，SIGTERM handler 不会跑
        '--stop-on-eof',
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...env, DSH_VIDEO_CACHE_DIR: join(dshHome(env), 'see-now') },
      });
    } catch (e) {
      reason = `起不来：${e?.message ?? e}`;
      enabled = false;
      child = null;
      return { ok: false, reason };
    }

    child.stdout?.on('data', (d) => {
      const s = String(d).trim();
      if (s) log(`[listen] ${s.slice(0, 400)}`);
    });
    child.stderr?.on('data', (d) => {
      const s = String(d).trim();
      if (s) log(`[listen] ${s.slice(-400)}`);
    });
    const proc = child;
    // stdin 只用来发"该收工了"（EOF）；对面先退的话写端会 EPIPE，吞掉
    proc.stdin?.on('error', () => {});
    // spawn 失败（ENOENT / EACCES / 杀软拦截）是异步 'error'：不监听就是 uncaught，宿主直接退
    proc.on('error', (e) => {
      log(`[listen] 采集进程起不来：${e?.code ?? e?.message ?? e}`);
      if (child !== proc) return;
      child = null;
      enabled = false;
      if (timer) { clearInterval(timer); timer = null; }
      reason = `起不来：${e?.code ?? e?.message ?? e}`;
    });
    proc.on('exit', (code) => {
      // 优雅停止要等最多 1.5 秒：期间可能已经 start() 了新的一轮，旧进程的 exit 不许动新状态
      if (child !== proc) return;
      const wasEnabled = enabled;
      child = null;
      enabled = false;
      if (timer) { clearInterval(timer); timer = null; }
      if (wasEnabled) {
        reason = `采集进程退出了（code=${code}）`;
        log(reason);
      }
    });

    // 等它把设备打开：不确认就报"在听"，用户会以为功能开了其实一句都没录（踩过）
    const ok = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 4000);
      const onData = (d) => {
        if (!String(d).includes('"event": "device"')) return;
        clearTimeout(t);
        child?.stdout?.off('data', onData);
        resolve(true);
      };
      child?.stdout?.on('data', onData);
      child?.once('exit', () => { clearTimeout(t); resolve(false); });
      child?.once('error', () => { clearTimeout(t); resolve(false); });
    });
    if (!ok) {
      stop('回环设备没打开（没有可用的 WASAPI loopback？）');
      reason = '回环设备没打开 —— 这台机器抓不到系统输出的声音';
      return { ok: false, reason };
    }

    enabled = true;
    reason = '在听';
    timer = setInterval(() => {
      // 这里**不能静默吞**：drain 里的意外（权限、编码、表单构造）如果被 `.catch(() => {})`
      // 吃掉，表现就是"在听、但永远没台词"，日志里一条线索都没有。
      drain().catch((e) => log(`[listen] drain 出错：${e?.message ?? e}`));
    }, pollInterval);
    timer.unref?.();
    return { ok: true };
  }

  function stop(why = null) {
    if (timer) { clearInterval(timer); timer = null; }
    if (child) {
      const proc = child;
      child = null;
      /**
       * **先关 stdin，让 listen.py 自己走 finally**（交出没说完的半句、关 WASAPI 设备）。
       * 直接 kill() 在 Windows 上是 TerminateProcess —— SIGTERM handler 永远不跑，
       * 那半句话和设备清理一起丢。1.5 秒还不走再硬杀。
       */
      let hard = null;
      try { proc.stdin?.end(); } catch { /* 已经关了 */ }
      if (proc.exitCode === null && proc.signalCode === null) {
        hard = setTimeout(() => { try { proc.kill(); } catch { /* 已经没了 */ } }, 1500);
        hard.unref?.();
        proc.once('exit', () => clearTimeout(hard));
      }
      if (!proc.stdin) { try { proc.kill(); } catch { /* 已经没了 */ } }
    }
    enabled = false;
    reason = why || '停了';
  }

  /**
   * 取某段时间窗里的台词（见 `createLineBuffer().between`）。
   */
  function between(fromMs, toMs, opts) {
    return buffer.between(fromMs, toMs, opts);
  }

  /**
   * 等"正在飞的那一段"落定（最多 `maxMs`）。
   *
   * ## 为什么这个函数比整个 ASR 链路都值钱
   *
   * `attachLines()` 取台词的窗口是「**上一张图的 wallTo → 这一张的 wallTo**」。
   * 那么：图在 15.0 秒生成，而 14.8 秒那句话要 15.35 秒才转完 —— 它**赶不上这张图**，
   * 被推到下一张。下一张 15 秒后才出，于是这套台词在用户眼里晚了整整 15 秒，
   * 而 ASR 链路本身只用 0.7 秒。**边界效应才是"字幕比画面晚十几秒"的主因。**
   *
   * 出图前等最多 300ms（通常 100~200ms 就够：pollMs 100 + 转写 180），
   * 把这段边界吃掉。代价是出图晚不到 0.3 秒，远小于解说延迟的 3.71s 上限。
   *
   * **积压时不参与等待**：`seg` 排到 3 个以上说明转写服务跟不上，等只会拖慢出图。
   *
   * @returns {Promise<boolean>} true = 手上已经清空（没有在飞的段）
   */
  async function settle(maxMs = 300) {
    if (!transcriber) return false;
    const until = Date.now() + maxMs;
    for (;;) {
      let names = [];
      try { names = readdirSync(audioDir); } catch { names = []; }
      let queued = 0;
      for (const n of names) if (n.startsWith('seg-')) queued += 1;
      if (queued > 3) return false;          // 积压：等也等不来
      if (!busy && queued === 0) return true;
      if (Date.now() >= until) return false;
      await sleep(25);
    }
  }

  return { start, stop, state, between, levelsBetween, drain, settle };
}
