/**
 * window.js — 拉起那颗悬浮窗（Python + tkinter，无边框/置顶/液态玻璃）。
 *
 * ## 为什么借用 watch 那份脚本，而不是拷一份
 *
 * 那份 `window.py` 有 3000 多行，而且**还在改**（用户刚收尾完一轮视觉）。
 * 拷一份进来 = 从今往后两边各自演化，改好的一边另一边看不见。
 * 所以默认策略是「找到哪份用哪份」，按优先级：
 *
 *   1. `DSH_SEE_WINDOW` 环境变量        —— 显式指定
 *   2. `~/.dsh/see-window.json` 的 script
 *   3. `~/.dsh/watch-window.json` 的 script  —— 用户就在那儿维护
 *   4. profile 里装的 `dsh-watch-together/examples/floating-chat/window.py`
 *   5. 开发仓库里的 `../dsh-watch-together/examples/floating-chat/window.py`
 *
 * 真到要独立发版那天，把 window.py 拷进 `examples/floating-chat/` 并加进第 5 步即可。
 *
 * ## 两个必须分开的东西
 *
 * - **聊天记录**：靠 `DSH_VIDEO_CACHE_DIR` 传给子进程，指到 `~/.dsh/see-now`。
 *   不分开的话，see-now 的消息会和陪看的消息串进同一个窗。
 * - **pid 锁**：`~/.dsh/see-now-window.pid`。不分开的话，陪看的窗开着时我们就不敢开了。
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chatDir, dshHome } from './chat.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 包里自带的那份 —— 由 `scripts/sync-window.mjs` 从上游生成，是最后的兜底 */
export const PACKAGED = join(HERE, '..', 'examples', 'floating-chat', 'window.py');
const REL = join('examples', 'floating-chat', 'window.py');

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) ?? {}; } catch { return {}; }
}

/** Windows 上 rename 撞上"对面正开着这个文件"时报的几种码 —— 都是暂时的，等一下就好。 */
const TRANSIENT_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY']);

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 不支持就不等 */ }
}

/**
 * 写 JSON：**tmp 再 rename**，Windows 上被占用时重试，最后退回直接覆盖。
 *
 * 为什么要重试：窗口进程每 250ms 用 `Path.read_text()` 读一次 `watch-window.json`，
 * Python 的 `open()` 不带 `FILE_SHARE_DELETE` —— 那一瞬间 `MoveFileEx` 必然
 * EPERM/EACCES；杀软和索引服务也会这样短暂占住文件。以前一次失败就放弃，
 * 于是"让窗口显示出来"这条救命指令会偶发失败，还在目录里留一个 `.json.tmp`。
 *
 * 字节格式不变：`indent=2`、无尾随换行（和窗口那边的 `write_config` 逐字节一致）。
 *
 * @param {{rename?: typeof renameSync, retries?: number}} [o] — `rename` 可注入，测试用
 */
export function writeJsonAtomic(path, obj, { rename = renameSync, retries = 5 } = {}) {
  const text = JSON.stringify(obj, null, 2);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  let last = null;
  for (let i = 0; i < retries; i += 1) {
    try {
      rename(tmp, path);
      return;
    } catch (e) {
      last = e;
      if (!TRANSIENT_RENAME.has(e?.code)) break;
      sleepSync(20 * 2 ** i);
    }
  }
  try { unlinkSync(tmp); } catch { /* 已经没了 */ }
  // rename 一直被挡（对面只是在读）：直接覆盖写也能成，读的一方最多读到一次半截 JSON，
  // 两边的 readJson 都兜了 —— 比"写失败"强。不是暂时性错误就照实抛。
  if (!TRANSIENT_RENAME.has(last?.code)) throw last;
  writeFileSync(path, text, 'utf8');
}

function seeConfig() {
  return readJson(join(dshHome(), 'see-window.json'));
}

export function pidPath() {
  return join(dshHome(), 'see-now-window.pid');
}

/**
 * pid 文件的 mtime（毫秒；没有就 0）。
 *
 * 用来区分**"用户手动重开了窗"**和**"窗一直没关过"** —— 两者 `windowAlive()` 都是 true。
 * 重开窗会重写 pid 文件，mtime 一定变；残留进程不会。
 */
export function pidStamp() {
  try { return statSync(pidPath()).mtimeMs; } catch { return 0; }
}

/** 心跳文件：窗口每秒 touch 一次，用来区分"进程还在"和"窗口真的在画"。 */
function heartbeatPath() {
  return join(chatDir(), 'window-heartbeat');
}

/** 心跳多久算过期。窗口 1 秒写一次，6 秒足够容忍一次 GC 或短暂卡顿。 */
export const HEARTBEAT_STALE_SEC = 6;

/**
 * 窗口的**可见性**配置（`~/.dsh/watch-window.json` 的 `hidden`）。
 *
 * 这个文件是**两个窗共用**的（陪看和 see-now 读到同一份 geometry / name / hidden），
 * 由 Python 侧的 `_sync_visible()` 每 250ms 读一次 mtime，变了就 withdraw / deiconify。
 *
 * **踩过的坑**：插件以前从不碰它。用户在窗上点了「藏起来」（或者陪看那边藏过），
 * `hidden` 就一直是 `true` —— 之后 `watch` 一切正常、进程在、心跳在跳，**屏幕上什么都没有**。
 * 模型没有"显示"这条指令，只能读文件猜，于是它答"我这边只有读权限，发不了显示指令"
 * （2026-11-03 社区反馈，原话）。
 */
export function windowConfigPath(env = process.env) {
  return join(dshHome(env), 'watch-window.json');
}

/**
 * 悬浮窗的外观预设，写进 `watch-window.json` 的 `glass`。
 *
 *   auto   不写这个键：窗口按环境自己选（远程/录屏 → solid，其余 → live）
 *   live   实时玻璃：每帧抓屏 + 模糊，最好看也最吃 CPU
 *   frost  静态磨砂：一张预生成的底板，不抓屏（低配机/高分屏选它）
 *   solid  纯色：最省，任何捕获方式都看得见
 *
 * 为什么放在这个文件里而不是 `see-now.json`：窗口进程只看这一份的 mtime，
 * 写别处要等下次开窗才生效。
 */
export const WINDOW_STYLES = Object.freeze(['auto', 'live', 'frost', 'solid']);

function styleOf(cfg) {
  const raw = typeof cfg?.glass === 'string' ? cfg.glass.trim().toLowerCase() : '';
  return WINDOW_STYLES.includes(raw) ? raw : 'auto';
}

/** 现在的样式 + 文件位置（面板要能把"改的是哪个文件"说出来）。 */
export function readWindowStyle(env = process.env) {
  const path = windowConfigPath(env);
  const cfg = readJson(path);
  return {
    path,
    exists: existsSync(path),
    style: styleOf(cfg),
    // `hidden` 是老键，`mode` 是新键：两个都认（和窗口的 `window_mode` 同一套判断）
    mode: cfg.hidden === true || cfg.mode === 'hidden' ? 'hidden' : 'full',
    danmaku: cfg.danmaku === true,
  };
}

/**
 * 改样式。**只动 `glass` 一个键**：同一个文件里还有 geometry / name / hidden，
 * 整体覆盖会把用户摆好的位置和"藏起来"的状态一起抹掉。
 *
 * 写完窗口 250ms 内自己换过来（它盯这个文件的 mtime），不用重开 DSH。
 *
 * @returns {{ok: boolean, changed?: boolean, style?: string, rejected?: string[]}}
 */
export function setWindowStyle(style, { log = () => {}, env = process.env } = {}) {
  const want = String(style ?? '').trim().toLowerCase();
  if (!WINDOW_STYLES.includes(want)) {
    return { ok: false, style: null, rejected: [`样式只能是 ${WINDOW_STYLES.join(' / ')}`] };
  }
  const path = windowConfigPath(env);
  const cfg = readJson(path);
  // 已经是目标值就不写盘：少刷一次 mtime，窗口就少醒一轮
  if (styleOf(cfg) === want && (want === 'auto' ? cfg.glass === undefined : cfg.glass === want)) {
    return { ok: true, changed: false, style: want };
  }
  // `auto` 不落盘 —— 窗口把"没有 glass 键"理解成自动，写个 auto 反而看不懂
  if (want === 'auto') delete cfg.glass;
  else cfg.glass = want;
  try {
    writeJsonAtomic(path, cfg);
  } catch (e) {
    const error = String(e?.message ?? e);
    log(`写 ${path} 失败：${error}`);
    return { ok: false, style: styleOf(cfg), rejected: [error] };
  }
  return { ok: true, changed: true, style: want };
}

/**
 * 本进程的会话标识。`hidden` 只有**本会话亲手藏的**才算数 ——
 * 上一版把 `hidden` 写成永久状态，DSH 重启后窗口进程还残留着，就变成
 * "进程活着、心跳在跳、屏幕上什么都没有"，且没有任何手段自愈（issue #32 第 1 点）。
 *
 * 用"会话"而不是时间戳：用户刚点完隐藏就重启，时间戳还没过期，
 * 但意图已经属于上一个会话了。
 */
const SESSION_ID = `${process.pid}-${Date.now().toString(36)}`;

/** 窗是不是被藏起来了。读不到就当没藏（不能因为一个坏文件把窗判成看不见）。 */
export function windowHidden(env = process.env) {
  const cfg = readJson(windowConfigPath(env));
  if (cfg.hidden !== true) return false;
  // 没有 `hiddenBy` 的是旧版本写的（那时没有会话概念），一律当遗留
  if (cfg.hiddenBy === SESSION_ID) return true;
  // **遗留状态必须顺手改回去**：Python 侧只认 `hidden` 字段，这里"当它没藏"
  // 并不会让窗口出现 —— 那就成了最坏的一种：Node 说"显示中"，屏幕上什么都没有。
  // 写一次之后文件就是 hidden:false，下次直接走上面的早退。
  try { setWindowHidden(false, { env }); } catch { /* 只读盘也照常回答 */ }
  return false;
}

/**
 * 改可见性。**读-改-写整份文件**，不能只写 `{hidden:false}` ——
 * 那样会把 `script` / `geometry` / `name` 一起抹掉，下一次开窗就得重新找解释器。
 * 写法跟窗口那边（`write_config`）逐字节一致：`indent=2`、无尾随换行、`.json.tmp` 再 rename。
 *
 * @returns {{changed:boolean, hidden:boolean, error?:string}}
 */
/**
 * `show` 是"让他看见"的开关，`hidden` 是它落盘后的形态 —— **两者方向相反**。
 *
 * 这里是唯一换算点：`show:true` 必须写 `hidden:false`。
 * （以前 `index.js` 把 `show` 直接当 `hidden` 传给 `setWindowHidden`，于是
 * "让它显示"这条救命指令恰恰把窗口藏了起来，见 issue #32 第 2 点。）
 */
export function hiddenForShow(show) {
  return !show;
}

export function setWindowHidden(hidden, { log = () => {}, env = process.env } = {}) {
  const path = windowConfigPath(env);
  const cfg = readJson(path);
  const want = Boolean(hidden);
  // 已经是目标状态就**不写**：多写一次会让 Python 侧多醒一轮，还会把 mtime 刷成"刚刚改过"
  if (Boolean(cfg.hidden) === want) return { changed: false, hidden: want };
  cfg.hidden = want;
  // `mode` 是窗口自己写的最小化标记，优先级高于 `hidden`（见 `window_mode`）：
  // 放出来的时候不清掉它，窗口会"被 show 了还是缩在托盘里"。
  if (!want) delete cfg.mode;
  // 记下是谁藏的：重启后这个字段对不上，`windowHidden()` 就当它没藏过
  if (want) cfg.hiddenBy = SESSION_ID;
  else delete cfg.hiddenBy;
  try {
    writeJsonAtomic(path, cfg);
  } catch (e) {
    const error = String(e?.message ?? e);
    log(`写 ${path} 失败：${error}`);
    return { changed: false, hidden: !want, error };
  }
  return { changed: true, hidden: want };
}

/**
 * 台词是否以弹幕飘过屏幕顶部（`watch-window.json` 的 `danmaku`）。
 *
 * 和可见性**正交**：`hidden + danmaku` 才是"打游戏"那一档 —— 窗口 0 占屏，
 * 但台词还看得见。默认关，别替用户决定。
 */
export function readWindowDanmaku(env = process.env) {
  return readJson(windowConfigPath(env)).danmaku === true;
}

/**
 * 改弹幕开关。和 `setWindowStyle` 同一套写法：读-改-写整份文件、tmp 再 rename。
 * 窗口每 250ms 看一次 mtime，改完当场生效，不用重开窗。
 */
export function setWindowDanmaku(on, { log = () => {}, env = process.env } = {}) {
  const path = windowConfigPath(env);
  const cfg = readJson(path);
  const want = Boolean(on);
  if ((cfg.danmaku === true) === want) return { ok: true, changed: false, danmaku: want };
  cfg.danmaku = want;
  try {
    writeJsonAtomic(path, cfg);
  } catch (e) {
    const error = String(e?.message ?? e);
    log(`写 ${path} 失败：${error}`);
    return { ok: false, changed: false, danmaku: !want, error };
  }
  return { ok: true, changed: true, danmaku: want };
}

/**
 * 窗口的完整状态，一句话能说清"为什么我看不见它"。
 *
 * `status` / `watch` 都把它带给模型 —— 以前模型只能去读 pid 和心跳文件自己猜，
 * 猜错就说"只有读权限"。
 */
/**
 * 心跳内容（新版窗口写 JSON：`{at, visible, hidden, state}`）。
 *
 * 老版本窗口写的是空文件 —— 那时只能看 mtime。所以这里读不到 JSON 就返回 null，
 * 调用方退回"看配置文件"的老行为，不把老窗口判死。
 */
export function readHeartbeat() {
  try {
    const raw = readFileSync(heartbeatPath(), 'utf8').trim();
    if (!raw) return null;
    const o = JSON.parse(raw);
    return typeof o?.visible === 'boolean' ? o : null;
  } catch {
    return null;
  }
}

export function windowReport({ env = process.env } = {}) {
  let pid = null;
  try {
    const n = Number(readFileSync(pidPath(), 'utf8').trim());
    if (Number.isInteger(n) && n > 0) pid = n;
  } catch { /* 没开过 */ }
  let heartbeatAgeSec = null;
  try {
    heartbeatAgeSec = Math.max(0, Math.round((Date.now() - statSync(heartbeatPath()).mtimeMs) / 1000));
  } catch { /* 老窗口不写心跳 */ }
  const intentHidden = windowHidden(env);
  /**
   * **意图和事实要分开**（issue #32 第 3 点）。
   *
   * `intentHidden` 读的是配置文件 —— 它只说明"有人要求藏起来"，不说明窗口现在什么样。
   * 实测过最难查的一种：配置写 `hidden:false`、进程活着、心跳在跳，屏幕上一片空，
   * 而 `status` 说"显示中"（Python 侧 withdraw 了但没写回文件）。
   *
   * 新版窗口每秒钟把 `visible` 写进心跳，那一份就是事实，优先用。
   * 没有心跳内容（老窗口）才退回配置。
   */
  const beat = readHeartbeat();
  const hidden = beat ? !beat.visible : intentHidden;
  return {
    pid,
    alive: windowPidAlive(),
    heartbeatAgeSec,
    heartbeatStale: heartbeatAgeSec === null ? null : heartbeatAgeSec > HEARTBEAT_STALE_SEC,
    hidden,
    /** 窗口自己报的可见性：true/false 是事实，null = 老窗口没报（只能信配置）。 */
    visible: beat ? beat.visible : null,
    /** 配置文件里的意图。和 `hidden` 不一致时说明两边脱节了。 */
    intentHidden,
    /** Tk 的窗口状态：`normal` / `withdrawn` / `iconic` / null（老窗口）。 */
    state: beat?.state ?? null,
    disabled: env.DSH_SEE_NO_WINDOW === '1',
  };
}

/** `windowReport()` → 一句中文。`visible` 优先，说不清才退回配置。 */
function visText(r) {
  if (r.visible === true) return '显示中';
  if (r.visible === false) {
    // `state` 来自心跳，心跳新鲜本身就说明窗口刚活过 —— 比 pid 探测更可信
    if (r.state === 'iconic' || r.state === 'icon') return '**最小化了（用户看不见）**';
    if (r.intentHidden || r.state === 'withdrawn') return '**藏起来的（用户看不见）**';
    if (!r.alive) return '看不见（进程不在了）';
    return '**看不见（窗口没画出来）**';
  }
  return r.hidden ? '**藏起来的（用户看不见）**' : '显示中';
}

/** `windowReport()` → 一行中文。 */
export function windowLine(r = windowReport()) {
  if (r.disabled) return '窗口：被 DSH_SEE_NO_WINDOW=1 关掉了';
  const proc = r.alive ? `进程 ${r.pid} 活着` : r.pid ? `进程 ${r.pid} 已经不在了` : '没开过';
  const hb = r.heartbeatAgeSec === null ? '没心跳'
    : r.heartbeatStale ? `心跳 ${r.heartbeatAgeSec}s 前（过期）`
      : `心跳 ${r.heartbeatAgeSec}s 前`;
  return `窗口：${proc} · ${hb} · ${visText(r)}`;
}

function logPath() {
  return join(dshHome(), 'see-now-window.log');
}

/**
 * 已安装的 `dsh-watch-together` 里那份 window.py（可能有多份）。
 *
 * 坑：以前硬编码 `profiles/desktop`，但 profile 名不止一个（本机有 `desktop` 和 `web`），
 * 而且 npm 还可能把它 hoist 到 `profiles/node_modules`。所以这里**全扫**。
 * 用运行中的那份而不是仓库那份，是因为 DSH 实际加载的就是 profile 里的副本 ——
 * 测仓库版等于没测到真正分发的版本。
 */
function installedCopies(env = process.env) {
  const home = dshHome(env);
  const roots = [join(home, 'node_modules'), join(home, 'profiles', 'node_modules')];
  try {
    for (const name of readdirSync(join(home, 'profiles'))) {
      roots.push(join(home, 'profiles', name, 'node_modules'));
    }
  } catch { /* 没有 profiles 目录 */ }
  const out = [];
  for (const root of roots) {
    const p = join(root, 'dsh-watch-together', REL);
    if (existsSync(p)) out.push(p);
  }
  return out;
}

/**
 * 窗口脚本放哪（按优先级找第一份存在的）。
 *
 * | 顺序 | 来源 | 什么时候用 |
 * |---|---|---|
 * | 1 | `DSH_SEE_WINDOW` | 临时指定、调试 |
 * | 2 | `~/.dsh/see-window.json` 的 `script` | 持久配置 |
 * | 3 | `~/.dsh/watch-window.json` 的 `script` | 用户在陪看那边维护的那份 |
 * | 4 | 已安装的 watch-together | **用户装了就永远是最新的**，零重复 |
 * | 5 | 开发仓库 `../dsh-watch-together` | 一边改一边试 |
 * | 6 | 包内 `examples/floating-chat/window.py` | 用户没装 watch 时的兜底 |
 *
 * 导出是为了让 `--check` 能报清楚究竟用的是哪个。
 *
 * @param {{env?:object}} [o] — 传 env 是为了让测试不用改 process.env
 */
export function resolveScript({ env = process.env } = {}) {
  const explicit = env.DSH_SEE_WINDOW;
  if (explicit && existsSync(explicit)) return { script: explicit, from: 'DSH_SEE_WINDOW' };

  const seen = readJson(join(dshHome(env), 'see-window.json')).script;
  if (seen && existsSync(seen)) return { script: seen, from: '~/.dsh/see-window.json' };

  const watch = readJson(join(dshHome(env), 'watch-window.json')).script;
  if (watch && existsSync(watch)) return { script: watch, from: '~/.dsh/watch-window.json' };

  const installed = installedCopies(env);
  if (installed.length) return { script: installed[0], from: '已安装的 watch-together' };

  const repo = join(HERE, '..', '..', 'dsh-watch-together', REL);
  if (existsSync(repo)) return { script: repo, from: '开发仓库' };

  if (existsSync(PACKAGED)) return { script: PACKAGED, from: '包内' };
  return { script: null, from: null };
}

/**
 * 解释器候选：**必须有 tkinter**。
 *
 * 本机踩过的坑：`PATH` 上的 `pythonw.exe` / `python.exe` 都是 WorkBuddy managed 的，
 * **不带 tkinter**，spawn 之后立刻退（日志里刷了一排 "No module named 'tkinter'"）。
 * 真正能用的是商店版（`WindowsApps/PythonSoftwareFoundation.Python.3.13_.../python.exe`）。
 * 所以这里不能只按名字排，得**真跑一次 import** 验。
 *
 * ## 版本闸要和脚本要求对齐（#45）
 *
 * 原先探针只 `import tkinter`，而脚本里用了 `dataclass(slots=True)` 与 `X | Y` 注解
 * （都是 3.10+）—— 于是 3.9 的解释器**通过了探针、然后崩在 import 里**，用户看到的
 * 是 `code=1`，被引导去装 python，而真因是版本。
 *
 * 现在两头都收到 3.8：脚本侧去掉了 `slots=True`、给带注解的文件加了
 * `from __future__ import annotations`，探针这边也把 3.8 作为地板。**两边改一边就要改另一边**。
 */
const PY_MIN = '3.8';
const TK_PROBE = [
  'import sys',
  `if sys.version_info < (${PY_MIN.split('.').join(', ')}):`,
  '    raise SystemExit(3)',
  'import tkinter',
].join('\n');

/** 取最后 n 行，每行截到 300 字符 —— reason 要能贴进工具返回，不能无限长。 */
function lastLines(text, n = 8, width = 300) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
  return lines.slice(-n).map((l) => (l.length > width ? `${l.slice(0, width)}…` : l)).join('\n');
}

/**
 * 这个解释器能不能跑这颗窗？返回 `{ ok, detail }`。
 *
 * 退出码分工：0 = 能用，3 = 版本太低，其它 = `import tkinter` 没成。
 * `detail` 会原样进 `reason`（`python3（tkinter 不可用：No module named '_tkinter'）`），
 * 比一句"没有能用的解释器"有用得多。
 */
export function pythonProbe(python) {
  const r = spawnSync(python, ['-c', TK_PROBE], {
    timeout: 8000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (r?.error) return { ok: false, detail: `跑不起来：${r.error.code ?? r.error.message}` };
  if (r?.status === 0) return { ok: true, detail: null };
  if (r?.status === 3) return { ok: false, detail: `版本太低（要 ≥ ${PY_MIN}）` };
  const tail = lastLines(r?.stderr, 2);
  return { ok: false, detail: tail ? `tkinter 不可用：${tail}` : 'tkinter 不可用' };
}

/**
 * 这个解释器能不能 `import tkinter`？
 *
 * 导出来是为了可测 —— 本机踩过的坑就是"解释器名字对、但没有 tkinter"，
 * 光看路径判断不出来，只能真跑一次。
 */
export function hasTkinter(python) {
  return pythonProbe(python).ok;
}

/**
 * **不去扫 `%LOCALAPPDATA%\Microsoft\WindowsApps`**（这里以前有一个 `storePython()`）。
 *
 * 那里的 `PythonSoftwareFoundation.Python.*` 是 **App Execution Alias**（重解析点）：
 * `existsSync()` 对它返回 false，`readdirSync()` 却列得出来，而 Store 包没完整注册时
 * spawn 它**会拉起微软商店**——用户眼前突然跳一个窗口，比"找不到 python"糟得多。
 *
 * 更坏的是它不会立刻退出，`openWindow()` 的 `settleMs` 探测会把它当成"窗口起来了"。
 * 社区实测（Win10 19045 / i7-8750H）就是被这条坑到的。
 *
 * 所以候选只留 PATH 和显式配置。Store 版用户请用 `DSH_SEE_PYTHON` 指向真实解释器
 * （`py -0p` 能列出来）。
 */
let pyLauncherCache = null;

/**
 * Windows 的 **`py` 启动器**指向的真解释器：`[pythonw.exe?, python.exe]`（非 Windows 返回空）。
 *
 * python.org 的安装包默认**不勾**"Add to PATH"，PATH 上只有 `C:\Windows\py.exe` ——
 * 只按 `pythonw.exe` / `python.exe` 找，这类用户永远是"没有能用的解释器"。
 * 问一次 `py -3` 它的 `sys.executable` 是谁，把那个绝对路径（和同目录的 pythonw）补进候选。
 * 进程内只问一次。
 */
export function pyLauncherPythons({
  platform = process.platform,
  run = null,
} = {}) {
  if (platform !== 'win32') return [];
  if (!run && pyLauncherCache) return pyLauncherCache;
  const exec = run ?? ((cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000, windowsHide: true }));
  let out = [];
  try {
    const r = exec('py', ['-3', '-c', 'import sys; print(sys.executable)']);
    const exe = r?.status === 0 ? String(r.stdout ?? '').trim().split(/\r?\n/).pop()?.trim() : '';
    if (exe && /\.exe$/i.test(exe)) {
      const w = join(dirname(exe), 'pythonw.exe');
      out = [...(existsSync(w) ? [w] : []), exe];
    }
  } catch { out = []; }
  if (!run) pyLauncherCache = out;
  return out;
}

export function pythonCandidates() {
  const cfg = seeConfig();
  const list = [];
  for (const c of [process.env.DSH_SEE_PYTHON, cfg.python, process.env.DSH_FLOAT_PYTHON]) {
    if (c) list.push(c);
  }
  if (process.platform === 'win32') {
    list.push('pythonw.exe', 'python.exe', ...pyLauncherPythons());
  } else {
    list.push('python3', 'python');
  }
  // 去重但保序
  return [...new Set(list.filter(Boolean))];
}

const PROTOCOL_VERSION = 1;
const MAX_PROTOCOL_LINE = 8192;
const COMMANDS = new Set(['pause', 'resume', 'stop', 'seek', 'watch', 'configure']);
let protocol = null;

function protocolAlive() {
  return Boolean(protocol && !protocol.exited && protocol.state === 'ready');
}

/** 协议窗口的显式状态；旧窗口返回 null，继续走 pid + 心跳。 */
export function windowStatus() {
  if (!protocol) return null;
  return { alive: protocolAlive(), state: protocol.state, reason: protocol.reason,
    owned: true, protocol: true };
}

export function acceptWindowProtocol(record, line) {
  if (line.length > MAX_PROTOCOL_LINE) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message?.version !== PROTOCOL_VERSION || typeof message.state !== 'string') return;
  record.state = message.state;
  record.reason = typeof message.reason === 'string' ? message.reason : null;
  if (message.state === 'ready') record.ready(record);
  if (message.state === 'closed' || message.state === 'failed') {
    record.reason ??= message.state;
    record.ready(record);
  }
  if (message.command && COMMANDS.has(message.command)) {
    const { version, ...command } = message;
    void version;
    queueMicrotask(() => {
      if (protocol === record && !record.exited && record.state === 'ready') record.onCommand?.(command);
    });
  }
}

/** 向协议窗口推送真实播放状态；旧窗口没有这条通道，调用是空操作。 */
export function sendWindowState(state) {
  if (!protocolAlive()) return false;
  const line = JSON.stringify({ version: PROTOCOL_VERSION, state });
  if (Buffer.byteLength(line) > MAX_PROTOCOL_LINE) return false;
  return protocol.child.stdin.write(`${line}\n`);
}

/** pid 文件指向的那个进程还在不在。**不看心跳**，见 `windowPidAlive` 的注释。 */
export function windowPidAlive() {
  if (process.env.DSH_SEE_NO_WINDOW === '1') return false;
  let pid = 0;
  try { pid = Number(readFileSync(pidPath(), 'utf8').trim()); } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch { return false; }
  return true;
}

/**
 * 这个 pid 现在**还是不是我们的窗口进程**（杀之前必须问）。
 *
 * pid 文件在用户点 × 之后不会被删（窗口脚本不知道这个文件），而 Windows 的 pid
 * 回收得很快：几小时后同一个号可能已经是浏览器 / 编辑器。`process.kill(pid)` 在
 * Windows 上是**无条件 TerminateProcess** —— 不验身份，就是替用户杀掉一个无关进程。
 *
 * 判据只看"是不是 python"：窗口一定是我们用某个 python 解释器拉起来的。
 * 查不到（tasklist / ps 不可用）一律当**不是** —— 宁可多留一个卡死的窗，也不误杀。
 *
 * @param {number} pid
 * @param {{platform?: string, run?: (cmd:string, args:string[]) => {status:number|null, stdout?:string}}} [o]
 *   `run` 可注入，测试用
 */
export function pidLooksLikeWindow(pid, {
  platform = process.platform,
  run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000, windowsHide: true }),
} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (platform === 'win32') {
      // 输出形如 `"pythonw.exe","1234","Console","1","45,000 K"`；没这个进程时是一句 INFO
      const r = run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
      if (r?.status !== 0) return false;
      for (const line of String(r.stdout ?? '').split(/\r?\n/)) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (m && Number(m[2]) === pid) return /^pythonw?[\d.]*\.exe$/i.test(m[1]);
      }
      return false;
    }
    // 只看**可执行文件名**（comm），不看整条命令行 —— 后者里随便一个参数带 "python" 就会误判
    const r = run('ps', ['-o', 'comm=', '-p', String(pid)]);
    if (r?.status !== 0) return false;
    const exe = String(r.stdout ?? '').trim().split('/').pop();
    return /^python/i.test(exe);
  } catch {
    return false;
  }
}

/**
 * 上次开的那个还活着吗？（**"这窗还能用吗"**，决定要不要重开）
 *
 * **不能只看 pid**：pid 会被系统复用，进程也可能活着但界面卡死、或者是一张全透明的空窗。
 * 那种情况下这里一直返回 true，于是**再也不重开**，用户体感是"点了没反应"
 * （issue #2 第 3 条）。所以加一层心跳：窗口每秒 touch 一个文件，过期就当它死了。
 *
 * 没有心跳文件时**不判死**：老版本窗口不写心跳，误杀会让它每次都被重开。
 *
 * **别拿它回答"用户是不是不想看了"**：心跳 6 秒过期太容易了（机器睡一觉、
 * 主线程卡一下都算），而那个判断的代价是单向的。那个问题用 `windowPidAlive()` + 拍数，
 * 见 `loop.js` 的 `windowVerdict()`。
 */
export function windowAlive() {
  if (protocol) return protocolAlive();
  if (!windowPidAlive()) return false;
  try {
    const hb = statSync(heartbeatPath());
    if ((Date.now() - hb.mtimeMs) / 1000 > HEARTBEAT_STALE_SEC) return false;
  } catch { /* 没有心跳文件：兼容老窗口，继续信任 pid */ }
  return true;
}

/**
 * 开窗（幂等）。
 *
 * 三步都要做，少一步就会得到一个"看起来成功、其实早就退了"的窗：
 *   1. 真跑一次 `import tkinter` 验解释器（managed python 没有，会立刻退）
 *   2. spawn 之后等 700ms，看它有没有自己退出（脚本报错退出也是退）
 *   3. **确认活着才写 pid** —— 否则 pid 文件指向死进程，`windowAlive()` 永远 false
 *
 * `script` 传了就**跳过 resolveScript()**，测试靠这个把自己钉在一个注定失败的脚本上 ——
 * 否则一旦那个脚本不存在，回退链会摸到真的 window.py，测试当场把窗弹到用户脸上（踩过）。
 *
 * @returns {{ok:boolean, script?:string, python?:string, from?:string, reason?:string, already?:boolean}}
 */
export async function openWindow({ force = false, log = () => {}, settleMs = 700, script: forced = null,
  onCommand = null, signal = null,
} = {}) {
  if (process.env.DSH_SEE_NO_WINDOW === '1') return { ok: false, reason: 'disabled' };
  if (!force && windowAlive()) return { ok: true, already: true };

  // force、或者 pid 还在但心跳过期（进程卡死/是空窗）才会走到这儿：
  // 先把上一次那个进程收掉，否则会叠出两个窗口，而用户只看得见一个。
  // **先验身份**：pid 可能早被系统回收给了别的程序（见 `pidLooksLikeWindow`）。
  try {
    const old = Number(readFileSync(pidPath(), 'utf8').trim());
    if (Number.isInteger(old) && old > 0 && old !== process.pid && pidLooksLikeWindow(old)) {
      try { process.kill(old); } catch { /* 已经没了 */ }
    }
  } catch { /* 没有 pid 文件，正常首次启动 */ }

  const { script, from } = forced
    ? { script: forced, from: '调用方指定' }
    : resolveScript();
  if (!script) {
    return { ok: false, reason: '找不到 window.py（设 DSH_SEE_WINDOW，或写 ~/.dsh/see-window.json）' };
  }
  if (forced && !existsSync(forced)) {
    return { ok: false, reason: `指定的 script 不存在：${forced}`, script: forced, from };
  }

  const tried = [];
  /** 所有候选解释器上缺的包（去重后一次性报出来）—— 必须声明在循环外，否则末尾拼 reason 时看不到 */
  const missing = new Set();
  /** 最后一次启动的 stderr 尾巴。`code=1` 什么都说明不了，死因只在这条通道上（#45）。 */
  let errTail = '';
  for (const python of pythonCandidates()) {
    const probe = pythonProbe(python);
    if (!probe.ok) { tried.push(`${python}（${probe.detail}）`); continue; }

    const useProtocol = Boolean(onCommand || signal);
    /**
     * 非协议模式：stderr **直接给日志文件的 fd**，不走管道。
     *
     * 窗口是 detached 的，活得比我们久（`npx dsh-see-window` 开完就 exit，DSH 也会重启）。
     * 管道的读端一走，Python 再往 stderr 写（Tk 回调里的 Traceback）就是
     * `OSError [Errno 22]`（Windows）/ `BrokenPipeError` —— 异常处理本身再抛异常，
     * 轻则回调死掉，重则弹 Tcl 的 background error 框。
     *
     * `reason` 要的那段尾巴改成**从日志里读回来**：记下开跑前的文件长度，秒退时读增量。
     */
    let logFd = null;
    let logStart = 0;
    if (!useProtocol) {
      try {
        mkdirSync(dirname(logPath()), { recursive: true });
        logFd = openSync(logPath(), 'a');
        logStart = fstatSync(logFd).size;
      } catch {
        if (logFd !== null) { try { closeSync(logFd); } catch { /* 算了 */ } }
        logFd = null;                    // 开不了日志：退回管道（老行为）
      }
    }
    let child;
    try {
      child = spawn(python, [script], {
        // 协议模式我们自己管它的生命周期，stderr 照旧 pipe（日志 + 尾巴）
        stdio: useProtocol ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'ignore', logFd ?? 'pipe'],
        detached: true,
        windowsHide: true,
        env: {
          ...process.env,
          // 关键：窗口按这个目录找 chat.jsonl，指到我们自己的目录，
          // 既不会读到陪看的消息，也不会把我们的消息写进陪看那条流
          DSH_VIDEO_CACHE_DIR: chatDir(),
          // 启动失败时那个 MessageBox 的标题跟着走，否则用户看到
          // "dsh-watch-together" 会以为自己装错了包（issue #32 第 1 条）
          DSH_WINDOW_BRAND: 'dsh-see-now',
        },
      });
    } catch (e) {
      if (logFd !== null) { try { closeSync(logFd); } catch { /* 算了 */ } }
      tried.push(`${python}（spawn 失败：${e?.message ?? e}）`);
      continue;
    }
    // 子进程已经继承了这个 fd，我们这边留着没用
    if (logFd !== null) { try { closeSync(logFd); } catch { /* 算了 */ } }

    errTail = '';
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk);
      errTail = (errTail + text).slice(-4000);
      try { appendFileSync(logPath(), text); } catch { /* 打不开日志就只留内存里这份 */ }
    });
    // 进程退出到 stderr 的 'end' 之间有一点延迟：不等它，"最后一句 Traceback" 会漏。
    // 正常路径（窗口起来了）不受影响，只有失败路径会多等最多 200ms。
    const errClosed = new Promise((resolve) => {
      if (!child.stderr) { resolve(); return; }
      child.stderr.once('end', resolve);
      child.stderr.once('close', resolve);
      setTimeout(resolve, 200).unref?.();
    });

    let record = null;
    if (useProtocol) {
      record = { child, state: 'starting', reason: null, exited: false, onCommand };
      protocol = record;
      let pending = '';
      child.stdout.on('data', (chunk) => {
        pending += chunk.toString();
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) acceptWindowProtocol(record, line);
      });
      child.once('exit', () => { record.exited = true; if (record.state === 'starting' || record.state === 'ready') record.state = 'closed'; });
      if (signal) signal.addEventListener('abort', () => closeWindow(), { once: true });
    }
    const dead = record ? await Promise.race([waitExit(child, settleMs), new Promise((resolve) => { record.ready = resolve; })]) : await waitExit(child, settleMs);
    if (dead) {
      await errClosed;
      if (logFd !== null) errTail = readLogSince(logStart);
      // code=1 且是"立刻退出"：八成是缺包。探测一次，把包名带进错误信息。
      const miss = dead.code === 1 ? missingPkgs(python) : [];
      for (const m of miss) missing.add(m);
      tried.push(`${python}（启动后 ${settleMs}ms 内退出，code=${dead.code}`
        + `${miss.length ? `，缺 ${miss.join('/')}` : ''}）`);
      log(`[window] ${python} 启动后立即退出，换下一个`);
      continue;
    }

    child.unref?.();
    try { writeFileSync(pidPath(), String(child.pid ?? ''), 'utf8'); } catch { /* 写不了只是会多开一次 */ }
    return { ok: true, script, from, python, protocol: Boolean(record), state: record?.state ?? 'legacy' };
  }

  let reason = `没有能用的解释器（要带 tkinter）：${tried.join(' / ') || '一个候选都没有'}`;
  if (missing.size) {
    const pkgs = [...missing].join(' ');
    reason += `\n缺 Python 包：${pkgs}。装一下：`
      + `python -m pip install ${pkgs}`
      + `（用上面那句报错里的那个 python；装完把窗关掉重开）。`;
  }
  // 只报 `code=1` 会把人往"装 python"的方向带，而真因常常是平台专有属性 / 缺 _tkinter。
  // 最后几行 Traceback 比任何一句概括都准（#45）。
  const tail = lastLines(errTail, 8);
  if (tail) reason += `\n最后一次启动的 stderr（最后几行）：\n${tail}`;
  return { ok: false, reason, script, missing: [...missing] };
}

/**
 * 窗口脚本需要这三个包。**缺任何一个都会让 python 在 700ms 内退出、code=1**，
 * 而插件这边只看得到 exit code —— 社区实报"只报 code=1，不知道要装什么"。
 * 所以启动全失败之后跑一次探测，把缺的包名换成 pip 命令一起报出去。
 */
const DEPS_PROBE = [
  'miss = []',
  'for mod, pkg in (("PIL", "Pillow"), ("mss", "mss"), ("numpy", "numpy")):',
  '    try:',
  '        __import__(mod)',
  '    except Exception:',
  '        miss.append(pkg)',
  'print(",".join(miss))',
].join('\n');

function missingPkgs(python) {
  try {
    const r = spawnSync(python, ['-c', DEPS_PROBE], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    const out = String(r.stdout ?? '').trim();
    return out ? out.split(',') : [];
  } catch { return []; }
}

/** 日志文件从 `start` 字节起新增的内容（最多尾部 4000 字节）。读不到就空串。 */
function readLogSince(start) {
  let fd = null;
  try {
    fd = openSync(logPath(), 'r');
    const size = fstatSync(fd).size;
    const from = Math.max(start, size - 4000);
    if (size <= from) return '';
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* 算了 */ } }
  }
}

/** 等最多 `ms`；进程先退出就返回 {code}，否则返回 null（还活着）。 */
function waitExit(child, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => finish(null), ms);
    child.once('exit', (code, signal) => finish({ code: code ?? signal }));
    child.once('error', (e) => finish({ code: `error:${e?.message ?? e}` }));
  });
}

/** 关窗（读 pid 杀掉；用户自己点 × 的话这里什么也不用做） */
export function closeWindow() {
  if (protocol && !protocol.exited) {
    protocol.state = 'closed';
    try { protocol.child.kill(); } catch { /* 已经退出 */ }
    protocol = null;
    try { unlinkSync(pidPath()); } catch { /* 没有 pid 文件 */ }
    return;
  }
  try {
    const pid = Number(readFileSync(pidPath(), 'utf8').trim());
    // pid 文件可能是陈年的（用户点 × 关的窗不删它），号早被回收了：不是 python 就不杀
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidLooksLikeWindow(pid)) process.kill(pid);
  } catch { /* 已经没了 */ }
  try { unlinkSync(pidPath()); } catch { /* 本来就没有 */ }
}
