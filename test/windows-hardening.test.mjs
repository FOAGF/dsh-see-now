/**
 * windows-hardening.test.mjs — 几处"在 Windows 上才会出事"的路径。
 *
 *   1. pid 文件是陈年的、号被系统回收 → 不许把无关进程杀掉（`pidLooksLikeWindow`）
 *   2. `watch-window.json` 被对面开着时 rename 会 EPERM → 要重试、要兜底、不留 .tmp
 *   3. `manage.start` 的 exe 不存在 → spawn 的 'error' 是异步的，不能把宿主带崩
 *   4. 停听音不能直接 TerminateProcess → 先关 stdin，让子进程自己走 finally
 *   5. 窗口是 detached 的：stderr 给日志 fd，秒退时的尾巴从日志里读回来
 *
 * 这些用例在 Linux 上也跑：逻辑是跨平台的，平台相关的那一步（tasklist / ps）用注入。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 必须在 import window.js 之前设好 DSH_HOME
const home = mkdtempSync(join(tmpdir(), 'dsh-see-winhard-'));
process.env.DSH_HOME = home;
delete process.env.DSH_SEE_NO_WINDOW;
delete process.env.DSH_SEE_WINDOW;
delete process.env.DSH_SEE_PYTHON;
delete process.env.DSH_FLOAT_PYTHON;

const {
  pidLooksLikeWindow, closeWindow, pidPath, writeJsonAtomic, pyLauncherPythons, openWindow,
} = await import('../src/window.js');
const { ensureService, createListener } = await import('../src/listen.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ 1. pid 身份 */

const tasklist = (line, status = 0) => () => ({ status, stdout: `${line}\r\n` });

test('pidLooksLikeWindow（win32）：只认 python / pythonw', () => {
  const win = (line, pid = 1234, status = 0) => pidLooksLikeWindow(pid, { platform: 'win32', run: tasklist(line, status) });
  assert.equal(win('"pythonw.exe","1234","Console","1","45,000 K"'), true);
  assert.equal(win('"python.exe","1234","Console","1","45,000 K"'), true);
  assert.equal(win('"python3.12.exe","1234","Console","1","45,000 K"'), true);
  assert.equal(win('"chrome.exe","1234","Console","1","245,000 K"'), false, 'pid 被回收给浏览器了');
  assert.equal(win('"pythonw.exe","5678","Console","1","45,000 K"'), false, 'pid 对不上不算');
  assert.equal(win('INFO: No tasks are running which match the specified criteria.'), false);
  assert.equal(win('"pythonw.exe","1234","Console","1","45,000 K"', 1234, 1), false, 'tasklist 失败就不杀');
  assert.equal(pidLooksLikeWindow(1234, { platform: 'win32', run: () => { throw new Error('boom'); } }), false);
});

test('pidLooksLikeWindow（posix）：看可执行文件名，不看命令行参数', () => {
  const nix = (out, status = 0) => pidLooksLikeWindow(42, { platform: 'linux', run: () => ({ status, stdout: out }) });
  assert.equal(nix('python3\n'), true);
  assert.equal(nix('/Library/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python\n'), true);
  assert.equal(nix('node\n'), false);
  assert.equal(nix('python3\n', 1), false);
  assert.equal(pidLooksLikeWindow(0), false);
  assert.equal(pidLooksLikeWindow(Number.NaN), false);
  // 真进程：本测试是 node，不是窗口
  assert.equal(pidLooksLikeWindow(process.pid), false);
});

test('closeWindow：pid 文件指向无关进程时不杀，只清掉陈年 pid 文件', async () => {
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    await sleep(100);
    writeFileSync(pidPath(), String(bystander.pid), 'utf8');
    closeWindow();
    await sleep(300);
    assert.equal(bystander.exitCode, null, '无关进程被杀了');
    assert.equal(bystander.signalCode, null, '无关进程被杀了');
    assert.equal(existsSync(pidPath()), false, '陈年 pid 文件应该被清掉');
  } finally {
    bystander.kill();
  }
});

/* ------------------------------------------------------------ 2. 原子写 */

const tmpLeft = (dir) => readdirSync(dir).filter((n) => n.endsWith('.tmp'));
const eperm = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });

test('writeJsonAtomic：rename 暂时 EPERM 会重试，最后落盘、不留 .tmp', () => {
  const dir = mkdtempSync(join(home, 'atomic-'));
  const path = join(dir, 'watch-window.json');
  let calls = 0;
  const flaky = (a, b) => { calls += 1; if (calls <= 2) throw eperm(); renameSync(a, b); };
  writeJsonAtomic(path, { hidden: false, name: '窗' }, { rename: flaky });
  assert.equal(calls, 3);
  assert.equal(readFileSync(path, 'utf8'), JSON.stringify({ hidden: false, name: '窗' }, null, 2));
  assert.deepEqual(tmpLeft(dir), []);
});

test('writeJsonAtomic：rename 一直被挡就直接覆盖写，仍不留 .tmp', () => {
  const dir = mkdtempSync(join(home, 'atomic-'));
  const path = join(dir, 'watch-window.json');
  writeFileSync(path, '{"hidden":true}', 'utf8');
  writeJsonAtomic(path, { hidden: false }, { rename: () => { throw eperm(); }, retries: 3 });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { hidden: false });
  assert.deepEqual(tmpLeft(dir), []);
});

test('writeJsonAtomic：不是暂时性错误就照实抛，不偷偷覆盖', () => {
  const dir = mkdtempSync(join(home, 'atomic-'));
  const path = join(dir, 'watch-window.json');
  writeFileSync(path, '{"hidden":true}', 'utf8');
  const exdev = () => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }); };
  assert.throws(() => writeJsonAtomic(path, { hidden: false }, { rename: exdev }), /EXDEV/);
  assert.equal(readFileSync(path, 'utf8'), '{"hidden":true}');
  assert.deepEqual(tmpLeft(dir), []);
});

/* ------------------------------------------------------------ py 启动器 */

test('pyLauncherPythons：非 Windows 为空；Windows 上把 py -3 指向的解释器补进来', () => {
  assert.deepEqual(pyLauncherPythons({ platform: 'linux' }), []);
  const exe = 'C:\\Users\\u\\AppData\\Local\\Programs\\Python\\Python313\\python.exe';
  const got = pyLauncherPythons({ platform: 'win32', run: () => ({ status: 0, stdout: `${exe}\r\n` }) });
  assert.ok(got.includes(exe), JSON.stringify(got));
  assert.deepEqual(pyLauncherPythons({ platform: 'win32', run: () => ({ status: 1, stdout: '' }) }), []);
  assert.deepEqual(pyLauncherPythons({ platform: 'win32', run: () => { throw new Error('no py'); } }), []);
});

/* ------------------------------------------------------------ 3. spawn 失败不崩 */

test('ensureService：manage.start 的 exe 不存在 → 很快返回 ok:false，宿主不崩', async () => {
  const t0 = Date.now();
  const r = await ensureService(
    { baseUrl: 'http://127.0.0.1:9/v1', manage: { start: ['definitely-not-here-xyz-see-now'] } },
    { waitMs: 10_000 },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /ENOENT/);
  assert.ok(Date.now() - t0 < 5000, `不该等满 waitMs：${Date.now() - t0}ms`);
});

/* ------------------------------------------------------------ 4. 优雅停止 */

test('listener.stop()：先关 stdin，子进程自己收尾（不是被硬杀）', async () => {
  const dir = mkdtempSync(join(home, 'listen-'));
  const marker = join(dir, 'graceful-exit');
  // 冒充 listen.py：报一个 device 事件，然后等 stdin EOF 再写标记退出
  const fake = join(dir, 'fake-listen.mjs');
  writeFileSync(fake, [
    `import { writeFileSync } from 'node:fs';`,
    `if (!process.argv.includes('--stop-on-eof')) process.exit(9);`,
    `console.log(JSON.stringify({ event: 'device', name: 'fake' }, null, 1).replace(/\\n\\s*/g, ' '));`,
    `process.stdin.resume();`,
    `process.stdin.on('end', () => { writeFileSync(${JSON.stringify(marker)}, 'ok'); process.exit(0); });`,
    `setTimeout(() => {}, 60000);`,
  ].join('\n'), 'utf8');

  const listener = createListener({
    dir: join(dir, 'audio'), python: process.execPath, script: fake,
    transcriber: { kind: 'test', transcribe: async () => '', label: 'test' },
    env: { ...process.env, DSH_SEE_AUDIO: '1' },
  });
  const st = await listener.start();
  assert.equal(st.ok, true, JSON.stringify(st));
  listener.stop();
  for (let i = 0; i < 40 && !existsSync(marker); i += 1) await sleep(25);
  assert.equal(existsSync(marker), true, '子进程没收到 EOF —— 被硬杀了，finally 不会跑');
});

/* ------------------------------------------------------------ 5. stderr → 日志 */

test('openWindow：秒退时 reason 带 stderr 尾巴（从日志 fd 读回）', { skip: process.platform === 'win32' && '要 /bin/sh 冒充解释器' }, async () => {
  const bin = mkdtempSync(join(home, 'bin-'));
  // 冒充 python：`-c <探针>` 一律成功，跑脚本时交给 /bin/sh
  const shim = join(bin, 'fakepy');
  writeFileSync(shim, '#!/bin/sh\nif [ "$1" = "-c" ]; then exit 0; fi\nexec /bin/sh "$@"\n', 'utf8');
  chmodSync(shim, 0o755);
  const boom = join(bin, 'boom.sh');
  writeFileSync(boom, 'echo "_tkinter.TclError: bad attribute -transparentcolor" >&2\nexit 1\n', 'utf8');

  const savedPath = process.env.PATH;
  process.env.DSH_SEE_PYTHON = shim;
  process.env.PATH = bin;               // PATH 上的真 python 不许插进来覆盖尾巴
  try {
    const st = await openWindow({ script: boom, settleMs: 1500 });
    assert.equal(st.ok, false, JSON.stringify(st));
    assert.match(st.reason, /bad attribute/, st.reason);
    const logged = readFileSync(join(home, 'see-now-window.log'), 'utf8');
    assert.match(logged, /bad attribute/, '日志里也要有');
    assert.equal(existsSync(pidPath()), false);
  } finally {
    process.env.PATH = savedPath;
    delete process.env.DSH_SEE_PYTHON;
    rmSync(bin, { recursive: true, force: true });
  }
});
