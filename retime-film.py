# -*- coding: utf-8 -*-
"""重定时求解器：
  1) 以目标语速重合成 81 行 → out/tts20/（断点续跑）
  2) 逐场景求解最小 dur：每行语音(+GAP 呼吸)必须装进「本行开始 → 下一行开始/场景末尾」窗口
  3) patch src/narration.js 的 dur（只增不减），输出 out/_retime.json

用法: python retime-film.py [--rate +20%]
"""
import asyncio, json, os, re, subprocess, sys

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, 'out')
TTS = os.path.join(OUT, 'tts20')
os.makedirs(TTS, exist_ok=True)
GAP = 0.40
LEAD = 0.25
NARR = os.path.join(BASE, 'src', 'narration.js')

args = sys.argv[1:]
RATE = args[args.index('--rate') + 1] if '--rate' in args else '+20%'
VOICE = 'zh-CN-XiaoxiaoNeural'

sys.path.insert(0, r'C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Lib\site-packages')

meta = json.load(open(os.path.join(OUT, '_scenes.json'), encoding='utf-8'))
SCENES = meta['scenes']
_lines = json.load(open(os.path.join(OUT, '_lines.json'), encoding='utf-8'))
LINES = _lines['lines']


def prep(text: str) -> str:
    t = text
    t = t.replace('"1592"', '一五九二')
    t = t.replace('——', '，')
    t = t.replace('「', '"').replace('」', '"')
    t = t.replace('·', '，')
    return t


def synth_all():
    import edge_tts
    async def one(idx, text):
        mp3 = os.path.join(TTS, f'line-{idx:03d}.mp3')
        if os.path.exists(mp3) and os.path.getsize(mp3) > 1000:
            return
        for attempt in range(4):
            try:
                com = edge_tts.Communicate(text, VOICE, rate=RATE)
                await com.save(mp3)
                if os.path.getsize(mp3) > 1000:
                    return
            except Exception:
                if attempt == 3:
                    raise
                await asyncio.sleep(2 + attempt * 2)

    async def go():
        for ln in LINES:
            await one(ln['i'], prep(ln['text']))
    asyncio.run(go())


def measure(i):
    mp3 = os.path.join(TTS, f'line-{i:03d}.mp3')
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                        '-of', 'csv=p=0', mp3], capture_output=True, text=True)
    return float(r.stdout.strip())


def main():
    print(f'== 1) 以语速 {RATE} 合成 81 行 → {TTS}', flush=True)
    synth_all()
    durs = {ln['i']: measure(ln['i']) for ln in LINES}
    tot = sum(durs.values())
    print(f'   语音总长 {tot:.1f}s（原默认语速 498s）', flush=True)

    print('== 2) 逐场景求解最小 dur', flush=True)
    results = []
    new_total = 0.0
    for sc in SCENES:
        talk = sc['talk']
        old = sc['dur'] / 1000.0
        need = old
        if talk:
            # 该场景的行（_lines.json 里按 scene 字段过滤，且行内顺序 = talk 顺序）
            ls = [ln for ln in LINES if ln['scene'] == sc['i']]
            ps = [p for p, _ in talk]
            for k in range(len(ls)):
                s = durs[ls[k]['i']]
                if k + 1 < len(ls):
                    dp = ps[k + 1] - ps[k]
                    if dp > 1e-6:
                        need = max(need, (s + GAP) / dp)
                else:
                    need = max(need, (s + GAP) / max(0.05, 1.0 - ps[k]))
                if k == 0:
                    need = max(need, LEAD / max(0.02, ps[0]))
        new_ms = int(max(sc['dur'], need * 1000 + 199) // 100 * 100)  # 向上取整到 0.1s
        new_total += new_ms
        results.append({'scene': sc['i'], 'old_ms': sc['dur'], 'new_ms': new_ms,
                        'talk': len(talk)})
        if new_ms != sc['dur']:
            print(f'   场景 {sc["i"]:2d}: {sc["dur"]/1000:5.1f}s → {new_ms/1000:5.1f}s'
                  f'  ({len(talk)} 行台词)', flush=True)
    print(f'   新总时长 {new_total/1000:.1f}s（原 {meta["total"]/1000:.1f}s）', flush=True)
    json.dump({'rate': RATE, 'total_old': meta['total'], 'total_new': new_total,
               'line_durs': durs, 'scenes': results},
              open(os.path.join(OUT, '_retime.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)

    print('== 3) patch narration.js dur 字段', flush=True)
    src = open(NARR, encoding='utf-8').read()
    marker = '/* ---------------- 时间轴累计 ----------------'
    head, tail = src.split(marker, 1)
    durs_map = {r['scene']: r['new_ms'] for r in results}
    count = [0]

    def sub_dur(m):
        idx = count[0]
        count[0] += 1
        if idx in durs_map and durs_map[idx] != int(m.group(1)):
            return f'dur: {durs_map[idx]},'
        return m.group(0)

    head2 = re.sub(r'\bdur: (\d+),', sub_dur, head)
    print(f'   命中 {count[0]} 个 dur 字段（应为 28）', flush=True)
    if count[0] != len(SCENES):
        print('!! dur 数量与场景数不符，放弃写入', flush=True)
        sys.exit(1)
    open(NARR, 'w', encoding='utf-8', newline='').write(head2 + marker + tail)
    print('   已写回 narration.js', flush=True)


if __name__ == '__main__':
    main()
