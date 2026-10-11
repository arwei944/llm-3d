# -*- coding: utf-8 -*-
"""批量 TTS：把 81 行解说词用 edge-tts 合成 mp3 并实测时长。
输出: out/tts/line-XXX.mp3 + out/_durs.json
断点续跑：已存在的 mp3 跳过（除非 --force）。
用法: python tts-lines.py [--rate +0%] [--force]
"""
import asyncio, json, os, sys, re

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, 'out')
TTS = os.path.join(OUT, 'tts')
os.makedirs(TTS, exist_ok=True)

RATE = '+0%'
FORCE = False
args = sys.argv[1:]
if '--rate' in args:
    RATE = args[args.index('--rate') + 1]
FORCE = '--force' in args

VOICE = 'zh-CN-XiaoxiaoNeural'


def prep(text: str) -> str:
    """给 TTS 的读法微调（字幕原文不动）"""
    t = text
    t = t.replace('"1592"', '一五九二')          # 示例输入按数字逐位读
    t = t.replace('——', '，')
    t = t.replace('「', '"').replace('」', '"')
    t = t.replace('·', '，')
    return t


async def synth(idx: int, text: str):
    import edge_tts
    mp3 = os.path.join(TTS, f'line-{idx:03d}.mp3')
    if os.path.exists(mp3) and os.path.getsize(mp3) > 1000 and not FORCE:
        return
    for attempt in range(4):
        try:
            com = edge_tts.Communicate(text, VOICE, rate=RATE)
            await com.save(mp3)
            if os.path.getsize(mp3) > 1000:
                return
        except Exception as e:
            if attempt == 3:
                print(f'line {idx} FAILED: {e}', flush=True)
                raise
            await asyncio.sleep(2 + attempt * 2)


async def main():
    data = json.load(open(os.path.join(OUT, '_lines.json'), encoding='utf-8'))
    lines = data['lines']
    for ln in lines:
        await synth(ln['i'], prep(ln['text']))
    print('synth done', flush=True)


asyncio.run(main())
