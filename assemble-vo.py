# -*- coding: utf-8 -*-
"""把逐行 TTS 音频装配成 373s 完整解说音轨，并与无声 MP4 合流。

流程：
  1) ffprobe 实测每行 mp3 时长
  2) 模拟顺序铺轨（start_i = max(字幕t_i, 上一行结束+0.3s)），
     漂移超过阈值的行用 edge-tts 提速重合成（保留自然度上限）
  3) numpy 装配 24kHz 单声道缓冲（10ms 淡入淡出防咔哒）
  4) 与视频合流 → out/llm-narration.mp4（无声原片备份为 out/llm-narration-novoice.mp4）

用法: python assemble-vo.py
"""
import json, os, subprocess, sys

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, 'out')
TTS = os.path.join(OUT, 'tts20')   # 与 retime-film.py 同一批音频（时间轴按它求解）
SR = 24000
TOTAL = 0.0           # 0 = 从视频实测（main() 里 probe VIDEO）
PAUSE = 0.30          # 行间呼吸
DRIFT_MAX = 2.5       # 语音落后字幕的容忍秒数
VIDEO = os.path.join(OUT, 'llm-narration.mp4')
NOVOICE = os.path.join(OUT, 'llm-narration-novoice.mp4')
WAV = os.path.join(OUT, 'llm-narration-vo.wav')

sys.path.insert(0, r'C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Lib\site-packages')
try:
    import numpy as np
except ImportError:
    print('需要 numpy', flush=True); sys.exit(1)

VOICE = 'zh-CN-XiaoxiaoNeural'


def prep(text: str) -> str:
    """给 TTS 的读法微调（字幕原文不动），与 tts-lines.py 保持一致"""
    t = text
    t = t.replace('"1592"', '一五九二')
    t = t.replace('——', '，')
    t = t.replace('「', '"').replace('」', '"')
    t = t.replace('·', '，')
    return t

data = json.load(open(os.path.join(OUT, '_lines.json'), encoding='utf-8'))
LINES = data['lines']

MP3_CACHE = {}  # i -> (dur, path)


def measure(i):
    mp3 = os.path.join(TTS, f'line-{i:03d}.mp3')
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                        '-of', 'csv=p=0', mp3], capture_output=True, text=True)
    return float(r.stdout.strip()), mp3


def measure_all():
    for ln in LINES:
        MP3_CACHE[ln['i']] = measure(ln['i'])


def resynth(i, rate_pct):
    """按指定语速%重合成第 i 行"""
    mp3 = os.path.join(TTS, f'line-{i:03d}.mp3')
    if os.path.exists(mp3):
        os.remove(mp3)
    import asyncio, edge_tts
    text = prep(next(l for l in LINES if l['i'] == i)['text'])
    async def go():
        com = edge_tts.Communicate(text, VOICE, rate=f'{rate_pct:+d}%')
        await com.save(mp3)
    asyncio.run(go())
    MP3_CACHE[i] = measure(i)


def simulate():
    """返回 per-line [start, drift], 总结束"""
    placed = []
    prev_end = 0.0
    for ln in LINES:
        i = ln['i']
        dur = MP3_CACHE[i][0]
        start = max(ln['t'], prev_end + PAUSE)
        placed.append((i, start, start - ln['t'], dur))
        prev_end = start + dur
    return placed, prev_end


def decode(mp3):
    r = subprocess.run(['ffmpeg', '-v', 'error', '-i', mp3, '-f', 'f32le',
                        '-ac', '1', '-ar', str(SR), '-'], capture_output=True)
    a = np.frombuffer(r.stdout, dtype=np.float32).copy()
    return a


def main():
    global TOTAL
    print('== 0) 实测视频时长', flush=True)
    rv = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                         '-of', 'csv=p=0', VIDEO], capture_output=True, text=True)
    TOTAL = float(rv.stdout.strip())
    print(f'   视频 {TOTAL:.1f}s', flush=True)
    print('== 1) 测量全部时长', flush=True)
    measure_all()
    durs = {i: round(d, 2) for i, (d, _) in MP3_CACHE.items()}
    total_chars = sum(l['chars'] for l in LINES)
    print(f'   语音总长 {sum(durs.values()):.0f}s / 视频 {TOTAL}s，总字数 {total_chars}', flush=True)

    print('== 2) 模拟铺轨 + 必要时提速', flush=True)
    adjusted = {}   # i -> 已重合成次数
    for wave in range(3):
        placed, end = simulate()
        over = [(i, st, dr, d) for (i, st, dr, d) in placed
                if dr > DRIFT_MAX and adjusted.get(i, 0) <= wave]
        print(f'   第{wave+1}轮: 结束 {end:.1f}s, 漂移>2.5s 的行 {len(over)}', flush=True)
        if not over:
            break
        cap = 40 if wave == 0 else 70
        for (i, st, dr, d) in over:
            ln = next(l for l in LINES if l['i'] == i)
            allowed = max(2.0, ln['gap'] - 0.15)
            pct = int(min(cap, max(10, (d / allowed - 1) * 100)))
            resynth(i, pct)
            adjusted[i] = adjusted.get(i, 0) + 1
            print(f'   line {i}: {d:.1f}s>{allowed:.1f}s 窗口 → 提速{pct}% (新 {MP3_CACHE[i][0]:.1f}s)', flush=True)
    placed, end = simulate()
    drifts = [dr for (_, _, dr, _) in placed]
    print(f'   最终: 语音结束 {end:.1f}s, 最大漂移 {max(drifts):.2f}s, 平均 {sum(drifts)/len(drifts):.2f}s', flush=True)
    json.dump({'placed': [{'i': i, 't': ln_t, 'start': round(st, 3), 'drift': round(dr, 3), 'dur': round(d, 3)}
                           for (i, st, dr, d), ln_t in zip(placed, [l['t'] for l in LINES])],
               'end': round(end, 2)},
              open(os.path.join(OUT, '_vo_report.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    if end > TOTAL:
        print(f'!! 语音结束 {end:.1f}s 超出视频 {TOTAL}s，将截断尾部', flush=True)

    print('== 3) 装配音轨', flush=True)
    buf = np.zeros(int(TOTAL * SR), dtype=np.float32)
    fade = np.linspace(0, 1, 240).astype(np.float32)
    for (i, st, dr, d) in placed:
        a = decode(MP3_CACHE[i][1])
        if a.size < 480:
            continue
        a[:240] *= fade
        a[-240:] *= fade[::-1]
        s = int(st * SR)
        e = min(s + a.size, buf.size)
        if e > s:
            buf[s:e] += a[:e - s]
    peak = float(np.abs(buf).max()) if buf.size else 0.0
    if peak > 0.97:
        buf *= 0.97 / peak
    print(f'   峰值 {peak:.3f}', flush=True)
    pcm = (np.clip(buf, -1, 1) * 32767).astype('<i2').tobytes()
    import wave as wavemod
    with wavemod.open(WAV, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(pcm)
    print(f'   已写 {WAV}', flush=True)

    print('== 4) 合流', flush=True)
    os.replace(VIDEO, NOVOICE)   # 无条件备份当前母版（可能刚重渲染过）
    r = subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', NOVOICE, '-i', WAV,
                        '-map', '0:v:0', '-map', '1:a:0',
                        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
                        '-movflags', '+faststart', '-shortest', VIDEO],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print('合流失败:', r.stderr[-600:], flush=True); sys.exit(1)
    r2 = subprocess.run(['ffprobe', '-v', 'error', '-show_entries',
                         'format=duration,size', '-of', 'csv=p=0', VIDEO],
                        capture_output=True, text=True)
    print('   成片:', r2.stdout.strip(), flush=True)


if __name__ == '__main__':
    main()
