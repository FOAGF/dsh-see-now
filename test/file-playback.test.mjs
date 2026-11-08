import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-file-playback-'));
process.env.DSH_SEE_NO_WINDOW = '1';

const { FFMPEG } = await import('./ffmpeg.mjs');
// 和其它测试同一套解析（DSH_FFMPEG_PATH / bundled / PATH）：裸 'ffmpeg' 在 Windows CI 上未必在 PATH
const FF = FFMPEG ?? 'ffmpeg';
const { sourceArgs, spawnFrames } = await import('../src/capture.js');
const { createRunner } = await import('../src/runner.js');

const FIXTURE = join(process.env.DSH_HOME, 'clip.mp4');

function makeFixture() {
  if (existsSync(FIXTURE) && statSync(FIXTURE).size > 10_000) return FIXTURE;
  execFileSync(FF, ['-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12', '-t', '20',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', FIXTURE],
  { stdio: 'inherit' });
  return FIXTURE;
}

test('文件源参数支持非负起点并拒绝非法值', () => {
  assert.deepEqual(sourceArgs({ kind: 'file', path: 'a.mp4', seek: 8 }), ['-ss', '8', '-i', 'a.mp4']);
  assert.throws(() => sourceArgs({ kind: 'file', path: 'a.mp4', seek: -1 }), RangeError);
});

test('seek 之后第一帧的时间戳带上起点（否则台词和画面对不上）', async () => {
  const frames = [];
  const run = spawnFrames({
    source: { kind: 'file', path: makeFixture() },
    width: 320, height: 180, fps: 12, ffmpegPath: FF,
    onFrame: (f) => { frames.push(f); },
  });
  await new Promise((resolve) => { run.done.then(resolve).catch(resolve); });
  assert.ok(frames.length > 0, '应该解出帧');
  assert.ok(frames[0].t >= 0, '起点 0 时时间戳从 0 起');

  const seeked = [];
  const run2 = spawnFrames({
    source: { kind: 'file', path: makeFixture(), seek: 10 },
    width: 320, height: 180, fps: 12, ffmpegPath: FF,
    onFrame: (f) => { seeked.push(f); },
  });
  await new Promise((resolve) => { run2.done.then(resolve).catch(resolve); });
  assert.ok(seeked.length > 0, 'seek 后应该解出帧');
  assert.ok(seeked[0].t >= 10, `seek=10 时第一帧 t 应该 >= 10，实际 ${seeked[0].t}`);
});

test('pause 之后不再收到新帧，resume 之后恢复', async () => {
  const clip = makeFixture();
  const frames = [];
  // `realtime: true` 让 ffmpeg 按 1 倍速放：否则解码比实时快得多，
  // 400ms 内整段就放完了，"暂停"根本测不到。
  const run = spawnFrames({
    source: { kind: 'file', path: clip, realtime: true },
    width: 320, height: 180, fps: 12, ffmpegPath: FF,
    onFrame: (f) => { frames.push(f.t); },
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  run.pause();
  const atPause = frames.length;
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(frames.length, atPause, '暂停后帧数不应增长');
  run.resume();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(frames.length > atPause, '继续后应该恢复出帧');
  run.stop();
});

test('非文件源拒绝播放控制，并给出中文说明', async () => {
  const runner = createRunner();
  const paused = await runner.pause();
  assert.equal(paused.ok, false);
  assert.equal(paused.reason, 'not-file');
  assert.match(paused.text, /文件源/, '文案要中文可读，不能只给英文枚举');
  const seeked = await runner.seek(10);
  assert.equal(seeked.ok, false);
  assert.equal(seeked.reason, 'not-file');
  runner.stop();
});

test('seek 拒绝非法位置', async () => {
  const runner = createRunner();
  const r = await runner.seek(-1);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid-position');
  runner.stop();
});
