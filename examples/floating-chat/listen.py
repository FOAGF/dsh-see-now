#!/usr/bin/env python3
"""listen.py — 听"电脑正在放什么"，断句，落成 16k 单声道 WAV。

## 它解决什么

see-now 抓的是**屏幕**（ddagrab / gdigrab），那条管道 `-an`，**没有音频轨**。
所以"视频里的人在说什么"必须另外抓一路 —— 抓系统输出的回环（WASAPI loopback），
不是麦克风（那是用户自己在说话，见 `mic.py`，两条流互不相干）。

## 为什么是 pyaudiowpatch，不是 sounddevice / soundcard

实测（Win11 + Realtek，2026-11-04）：

  · `soundcard` 的 loopback 两个端点、四组采样率**恒返回 0**（物理麦克风同库正常）；
  · `sounddevice`（PortAudio 原生）的 WASAPI host API 里**根本没有 loopback 设备**
    —— 官方 PortAudio 不暴露，只有 pyaudiowpatch 那个 fork 打了补丁；
  · `pyaudiowpatch` 直接列出 `扬声器/耳机 (...) [Loopback]`，不需要装任何虚拟声卡。

ffmpeg 的 dshow 也走不通：这台机器 dshow 枚举不到"立体声混音"（注册表里有、设备管理器
也显示启用，但 dshow 就是看不到）。

## 三个必须守住的点（都是踩过的）

1. **静音段 WASAPI loopback 不推送数据**（实测 3 秒静音 callback 触发 0 次）。
   所以时间码只能来自**每块到达的 wall clock**，绝不能拿样本数累加 —— 否则静音 10 秒后
   一开口，字幕整体漂 10 秒。
2. **先混单声道再降采样**。把 `reshape(-1, 3).mean()` 一步做完会因双声道相位抵消，
   ASR 只认出"嗯。"。顺序必须是 `reshape(-1, ch).mean(1)` → 3 点箱式平均。
3. **它听得见自己**。AI 用 TTS 念台词 → 音箱出声音 → 回环收回去 → 转成"视频里的台词"。
   所以每段落盘前查一次 `quiet-until.json`（`say` / `cue` 念之前会占住这个窗口）。

## 用法

    python listen.py --out ~/.dsh/see-now/audio
    python listen.py --out ... --device "耳机 (Realtek(R) Audio) [Loopback]"
    python listen.py --out ... --list-devices
    python listen.py --out ... --silence 0.35 --max-seg 8

依赖：`pip install pyaudiowpatch numpy`。装不上就退出码 2，上层据此静默降级（只看图，无字幕）。

输出：每句话一个 `seg-<epochMs>.wav`（16k 单声道 PCM16），`epochMs` 是**这句话开头**的
墙上时间 —— 这是全链路唯一的时间码来源，Node 侧靠它把台词对到画面帧上。
"""

import argparse
import collections
import json
import os
import queue
import signal
import sys
import threading
import time
import wave

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

try:
    import numpy as np
except ImportError:
    sys.stderr.write("缺 numpy：pip install numpy\n")
    raise SystemExit(2)

try:
    import pyaudiowpatch as pa
except ImportError:
    sys.stderr.write("缺 pyaudiowpatch：pip install pyaudiowpatch\n")
    raise SystemExit(2)


# 目标格式。16k 单声道是 ASR（paraformer / SenseVoice）的标准输入。
SR = 16000


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def emit(obj):
    """给 Node 侧的一行 JSON（诊断用；真正的产物是磁盘上的 wav）。"""
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def watch_out_dir():
    explicit = os.environ.get("WATCH_OUT") or os.environ.get("DSH_WATCH_OUT")
    if explicit:
        return explicit
    home = os.environ.get("DSH_HOME") or os.path.join(os.path.expanduser("~"), ".dsh")
    return os.path.join(home, "watch", "out")


QUIET_FILE = os.environ.get("DSH_QUIET_FILE") or os.path.join(watch_out_dir(), "quiet-until.json")


def quiet_until_ms():
    """静音窗口到什么时候（epoch ms）。0 = 没有窗口。"""
    try:
        with open(QUIET_FILE, "r", encoding="utf-8") as f:
            return float(json.load(f).get("until") or 0)
    except Exception:
        return 0.0


def tts_busy(at_ms=None):
    """这一段里有没有 AI 自己的声音。

    `at_ms` 给了就按**段的时间窗**判（起点落在窗口内 = 这段被污染），
    不给就按"此刻"判。**为什么不能只看此刻**：段落盘发生在说完之后，
    一句话正好跨过窗口末尾时，"此刻"已经出了窗口，但它的前半段还是 AI 的声音
    （实测：窗口还剩 0.25 秒时落盘，整段被当成视频台词收了进去）。
    """
    until = quiet_until_ms()
    if not until:
        return False
    if at_ms is None:
        return time.time() * 1000 < until
    return at_ms < until


def list_devices():
    p = pa.PyAudio()
    try:
        rows = []
        try:
            default = p.get_default_wasapi_loopback()
        except Exception:
            default = None
        for d in p.get_loopback_device_info_generator():
            rows.append({
                "name": d["name"],
                "rate": int(d["defaultSampleRate"]),
                "channels": int(d["maxInputChannels"]),
                "default": bool(default and d["name"] == default["name"]),
            })
        print(json.dumps(rows, ensure_ascii=False, indent=1))
    finally:
        p.terminate()


def pick_device(p, want=None):
    """选回环设备。`want` 给了就按名字子串找（用户可能有多块声卡）。"""
    if want:
        for d in p.get_loopback_device_info_generator():
            if want.lower() in d["name"].lower():
                return d
        raise SystemExit(f"找不到名字含「{want}」的回环设备（用 --list-devices 看看有哪些）")
    try:
        return p.get_default_wasapi_loopback()
    except Exception:
        for d in p.get_loopback_device_info_generator():
            return d
        raise SystemExit("这台机器没有可用的回环设备（WASAPI loopback 一个都没列出来）")


class Segmenter:
    """能量 VAD 断句器。输入是 16k 单声道 float 块，输出是"一段话"。

    为什么不用固定窗：固定 3 秒会把词切在两半（"第一个维" / "度是技术"），
    ASR 两边都识别成残句。按静音断句，一段就是一个完整的句子或一口气。

    为什么保留预卷：人开口的第一个字音量往往还没起来，纯按阈值切会把首字削掉。
    预卷 `pre` 秒是"从判定有声往前多拿一点"。
    """

    def __init__(self, silence=0.35, max_seg=3.0, pre=0.25, min_seg=0.5, thr=0.0035,
                 live_min=1.8, live_step=1.2):
        self.silence = silence
        self.max_seg = max_seg
        self.pre = pre
        self.min_seg = min_seg
        self.thr = thr
        # 「边说边出字幕」：说满 live_min 秒先给一版快照，之后每 live_step 秒刷新。
        # live_min <= 0 = 关掉（只用整句）。
        self.live_min = live_min
        self.live_step = live_step
        self.last_live_span = 0.0
        self.pre_buf = collections.deque()     # (wall, block)，只留 pre 秒
        self.in_speech = False
        self.cur = []                          # [(wall, block)]
        self.start_wall = 0.0
        self.silence_run = 0.0
        self.last_loud_wall = 0.0

    def _pre_len(self):
        return sum(len(b) for _, b in self.pre_buf) / SR

    def push(self, wall, block):
        """喂一块（约 21ms）。返回要落盘的 [(t0, np.ndarray)]（通常是 0 或 1 个）。"""
        n = len(block)
        if n == 0:
            return []
        dur = n / SR
        rms = float(np.sqrt(np.mean(block.astype(np.float32) ** 2)))
        loud = rms > self.thr

        if not self.in_speech:
            self.pre_buf.append((wall, block))
            while self._pre_len() > self.pre:
                self.pre_buf.popleft()
            if not loud:
                return []
            # 开口：把预卷一起收进来，起点按预卷第一块的时刻算
            self.in_speech = True
            self.cur = list(self.pre_buf)
            self.start_wall = self.cur[0][0] if self.cur else wall
            self.pre_buf.clear()
            self.silence_run = 0.0
            self.last_loud_wall = wall
            return []

        self.cur.append((wall, block))
        if loud:
            self.silence_run = 0.0
            self.last_loud_wall = wall
        else:
            self.silence_run += dur

        span = wall - self.start_wall
        if self.silence_run >= self.silence or span >= self.max_seg:
            return self._close()
        return []

    def tick(self, now):
        """静音期**没有数据块**（WASAPI loopback 不推送），只能靠墙上时间判"说完了"。

        没有这个 tick，一句话会一直挂到 `max_seg` 强切 —— 实测 12 秒连续语音只出
        1 段 6 秒的，后 6 秒要等下一次开口才补出来。
        """
        if not self.in_speech:
            return []
        if now - self.last_loud_wall >= self.silence:
            return self._close()
        return []

    def snapshot(self):
        """**这句说到目前的音频**（「边说边出字幕」用）。

        为什么要有：长句要等 `max_seg`（3 秒）强切才送去转写，而本地 paraformer
        转 1.8 秒音频只要 150ms —— **等断句的时间是转写本身的 20 倍**。
        说满 `live_min` 秒就先给一版，让字幕早几秒出现；整句落盘后 Node 侧会用
        准确结果把它覆盖掉（`upsert`），所以这一版**永远只是临时的**。

        节流在内部，调用方可以每块都调。`live_min <= 0` 直接关掉。
        """
        if not self.in_speech or self.live_min <= 0 or self.live_step <= 0:
            return []
        if not self.cur:
            return []
        # 用"最后一块的到达时刻 + 块时长"算，不用 time.time() —— 主循环调度抖动不该算进来
        wall, block = self.cur[-1]
        span = wall + len(block) / SR - self.start_wall
        if span < self.live_min:
            return []
        if self.last_live_span > 0 and span - self.last_live_span < self.live_step:
            return []
        self.last_live_span = span
        # 尾部静音**不 trim**：这句还没说完，trim 会把正在说的字削掉
        audio = np.concatenate([b for _, b in self.cur])
        return [(self.start_wall, audio)]

    def flush(self):
        """退出时把没说完的那半句也交出来（够长才要）。"""
        if self.in_speech:
            return self._close()
        return []

    def _close(self):
        frames = self.cur
        self.cur = []
        self.in_speech = False
        self.silence_run = 0.0
        self.last_live_span = 0.0
        self.pre_buf.clear()
        if not frames:
            return []
        # 尾巴的静音不要（ASR 对纯静音会吐"嗯。"这种幻觉）
        keep_until = self.last_loud_wall + 0.12
        trimmed = [(w, b) for w, b in frames if w <= keep_until]
        if not trimmed:
            return []
        audio = np.concatenate([b for _, b in trimmed])
        if len(audio) / SR < self.min_seg:
            return []
        return [(self.start_wall, audio)]


def write_wav(path, audio):
    """**先写 .tmp 再 rename**：Node 侧是扫目录取文件的，读到写了一半的 wav 会让
    转写服务直接报错（host 那边只认完整长度）。rename 在同一个盘上是原子的。"""
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
    tmp = f"{path}.tmp"
    with wave.open(tmp, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    os.replace(tmp, path)


class LevelMeter:
    """每 `step` 秒一个格子的响度（dBFS），给图底下的音量条用。

    **按时间格子存，不按"有数据才写"**：WASAPI loopback 静音时一个字节都不推，
    照数据写出来的序列在时间轴上是断的 —— 画成条就是"柱子之间一片黑"。
    所以静音格子显式补 -120dB，时间轴才连续。

    顺手做的理由：这段音频**本来就要过一遍**（算 RMS 断句），
    再加一次 `20log10` 几乎没有成本。不用像 storyboard 那样再开一次 ffmpeg 跑 ebur128。
    """

    def __init__(self, step=0.1, keep=180.0):
        self.step = step
        self.keep = keep
        self.t0 = None
        self.grid = {}

    def push(self, wall, block):
        if self.t0 is None:
            self.t0 = wall
        if len(block) == 0:
            return
        idx = int((wall - self.t0) / self.step)
        peak = float(np.sqrt(np.mean(block.astype(np.float32) ** 2)))
        if peak > self.grid.get(idx, 0.0):
            self.grid[idx] = peak
        # 修剪：只留 keep 秒
        span = int(self.keep / self.step)
        if len(self.grid) > span + 40:
            cut = idx - span
            for k in [k for k in list(self.grid) if k < cut]:
                del self.grid[k]

    def snapshot(self):
        if self.t0 is None or not self.grid:
            return None
        lo, hi = min(self.grid), max(self.grid)
        db = []
        for i in range(lo, hi + 1):
            v = self.grid.get(i)
            db.append(-120.0 if v is None else round(20.0 * np.log10(max(v, 1e-6)), 1))
        return {"step": self.step, "from": int((self.t0 + lo * self.step) * 1000), "db": db}


def write_levels(path, meter):
    """原子写。读的一方（Node）随时可能在读，不能让它看到半个 JSON。"""
    snap = meter.snapshot()
    if not snap:
        return
    tmp = f"{path}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(snap, f, separators=(",", ":"))
        os.replace(tmp, path)
    except Exception:
        pass


def main():
    ap = argparse.ArgumentParser(description="抓系统回环声音，按静音断句落成 16k wav")
    ap.add_argument("--out", required=False, help="wav 输出目录（seg-<epochMs>.wav）")
    ap.add_argument("--device", default=None, help="回环设备名的一部分（默认：系统默认输出的回环）")
    ap.add_argument("--silence", type=float, default=0.35, help="静音多久算一句说完（秒）")
    ap.add_argument("--max-seg", type=float, default=3.0, help="一句话最长多少秒，超了强切")
    ap.add_argument("--pre", type=float, default=0.25, help="预卷：开口前多收多少秒")
    ap.add_argument("--min-seg", type=float, default=0.5, help="短于这个长度的段不发")
    ap.add_argument("--thr", type=float, default=0.0035, help="能量阈值（0~1，默认约 -49dB）")
    ap.add_argument("--live", type=float, default=1.0, help="长句边说边出字幕：1 开 / 0 关")
    ap.add_argument("--live-min", type=float, default=1.8, help="说满这么多秒才给第一版临时字幕")
    ap.add_argument("--live-step", type=float, default=1.2, help="之后每这么多秒刷新一版")
    ap.add_argument("--list-devices", action="store_true", help="列出回环设备后退出")
    ap.add_argument("--stop-on-eof", action="store_true",
                    help="stdin 读到 EOF 就正常收工（上层关 stdin = 优雅停止）")
    args = ap.parse_args()

    if args.list_devices:
        list_devices()
        return
    if not args.out:
        raise SystemExit("要 --out DIR（或者 --list-devices）")
    os.makedirs(args.out, exist_ok=True)

    # 上层是 SIGTERM 收工的：不接这个信号的话 finally 不会跑，正在说的那半句就丢了
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    # **Windows 上没有 SIGTERM 这回事**：Node 的 `child.kill()` 是 TerminateProcess，
    # 上面那个 handler 永远不会跑，finally 里的"交出半句 / 关设备"全丢。
    # 所以上层改成先关 stdin：这里读到 EOF 就让主循环自己走到 finally。
    # 必须显式开（--stop-on-eof）：stdin 是 /dev/null 时 read() 立刻 EOF，默认开会秒退。
    stop_evt = threading.Event()
    if args.stop_on_eof:
        def _watch_stdin():
            try:
                while sys.stdin.buffer.read(4096):
                    pass
            except Exception:
                pass
            stop_evt.set()
        threading.Thread(target=_watch_stdin, name="stdin-eof", daemon=True).start()

    p = pa.PyAudio()
    try:
        dev = pick_device(p, args.device)
        sr = int(dev["defaultSampleRate"])
        ch = int(dev["maxInputChannels"])
        emit({"event": "device", "name": dev["name"], "rate": sr, "channels": ch})

        # 设备原生格式打开（WASAPI 共享模式不接受别的采样率），降采样自己做。
        #
        # **必须用回调 + 队列，不能用阻塞 read**：静音段 loopback 一个字节都不推，
        # `stream.read()` 会一直挂着（实测想读 4 秒、实际卡了 19 秒才返回），
        # 主循环没有机会跑 tick，那"说完了"就永远判不出来。
        q = queue.Queue()
        ratio = max(1, int(round(sr / SR)))

        def on_audio(in_data, frame_count, time_info, status):
            raw = np.frombuffer(in_data, dtype=np.float32).copy()
            q.put((time.time(), raw))
            return (None, pa.paContinue)

        stream = p.open(format=pa.paFloat32, channels=ch, rate=sr, input=True,
                        input_device_index=dev["index"], frames_per_buffer=1024,
                        stream_callback=on_audio)
        seg = Segmenter(silence=args.silence, max_seg=args.max_seg,
                        pre=args.pre, min_seg=args.min_seg, thr=args.thr,
                        live_min=(args.live_min if args.live else 0.0),
                        live_step=(args.live_step if args.live else 0.0))

        carry = np.zeros(0, dtype=np.float32)   # 48k → 16k 的余数（3 个凑 1 个）
        meter = LevelMeter()
        levels_path = os.path.join(args.out, "levels.json")
        last_beat = time.time()
        last_levels = 0.0
        dropped = 0
        written = 0

        def drop_ratio(x):
            nonlocal carry
            cat = np.concatenate([carry, x]) if carry.size else x
            n = len(cat) // ratio * ratio
            if n == 0:
                carry = cat
                return np.zeros(0, dtype=np.float32)
            out = cat[:n].reshape(-1, ratio).mean(axis=1).astype(np.float32)
            carry = cat[n:]
            return out

        def land(pieces):
            nonlocal dropped, written
            for t0, audio in pieces:
                if tts_busy(t0 * 1000):
                    dropped += 1
                    emit({"event": "skip", "reason": "tts", "at": round(t0, 3)})
                    continue
                name = f"seg-{int(t0 * 1000)}.wav"
                write_wav(os.path.join(args.out, name), audio)
                # 这句已经有整句了，临时快照作废（Node 侧不必再转一次）
                try:
                    os.remove(os.path.join(args.out, f"live-{int(t0 * 1000)}.wav"))
                except OSError:
                    pass
                written += 1
                emit({"event": "seg", "name": name, "at": round(t0, 3),
                      "dur": round(len(audio) / SR, 2)})

        def land_live(pieces):
            """临时快照：**同名覆盖**（一句话只有一个 live 文件），Node 侧按 size/mtime 判新。"""
            for t0, audio in pieces:
                if tts_busy(t0 * 1000):
                    continue
                name = f"live-{int(t0 * 1000)}.wav"
                write_wav(os.path.join(args.out, name), audio)
                emit({"event": "live", "at": round(t0, 3), "dur": round(len(audio) / SR, 2)})

        stream.start_stream()
        while not stop_evt.is_set():
            try:
                # 20ms 而不是 50：静音期没有数据块，`tick()` 的粒度就是这个超时 ——
                # 它直接计进"说完 → 判定说完"的延迟里。
                wall, raw = q.get(timeout=0.02)
            except queue.Empty:
                wall, raw = None, None
            if raw is not None:
                x = raw.reshape(-1, ch).mean(axis=1) if ch > 1 else raw
                block = drop_ratio(x)
                meter.push(wall, block)          # 音量条：顺手记，不额外解码
                land(seg.push(wall, block))
                land_live(seg.snapshot())        # 长句：不等断句，先给一版
            # 静音期没有数据，靠这里把"说完了"判出来
            land(seg.tick(time.time()))
            if time.time() - last_levels > 1.0:
                last_levels = time.time()
                write_levels(levels_path, meter)
            if time.time() - last_beat > 30:
                last_beat = time.time()
                emit({"event": "beat", "written": written, "skipped": dropped})
    except KeyboardInterrupt:
        pass
    finally:
        try:
            land(seg.flush())      # 退出时把没说完的半句也交出去（够长才要）
        except Exception:
            pass
        try:
            write_levels(levels_path, meter)   # 最后一帧音量条也要落下去
        except Exception:
            pass
        try:
            stream.stop_stream(); stream.close()
        except Exception:
            pass
        p.terminate()


if __name__ == "__main__":
    main()
