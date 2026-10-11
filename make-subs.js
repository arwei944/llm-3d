/* 从讲解脚本生成字幕：out/llm-narration.srt（通用）与 out/llm-narration.vtt（网页 <track> 用）。
 *
 * 脚本里每句台词的触发点是「场景内进度 0~1」，这里换算成绝对时间。
 * 一条字幕持续到下一句开始（同一场景末尾则持续到下一场景的第一句）。
 *
 * 用法： node make-subs.js
 */
const fs = require('fs'), path = require('path'), vm = require('vm');

const OUTDIR = path.join(__dirname, 'out');
fs.mkdirSync(OUTDIR, { recursive: true });

// 在沙箱里跑 narration.js，只为拿到它的 SCRIPT（不调用 attach，不碰 DOM）
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'src', 'narration.js'), 'utf8'), sandbox, { filename: 'narration.js' });
const C = sandbox.window.LLMCine;
if (!C || !C.scenes) throw new Error('没能从 narration.js 取到 SCRIPT');
const SCRIPT = C.scenes, CUM = C.cum, TOTAL = C.total;

// 摊平所有台词 → [{t, text, scene}]
const lines = [];
SCRIPT.forEach((sc, i) => {
  (sc.talk || []).forEach(([p, text]) => {
    lines.push({ t: CUM[i] + sc.dur * p, text: String(text), scene: i });
  });
});
lines.sort((a, b) => a.t - b.t);

const stamp = (ms, comma) => {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, x = ms % 1000;
  const p = (n, w) => String(n).padStart(w, '0');
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)}${comma ? ',' : '.'}${p(x, 3)}`;
};

// ---- SRT ----
let srt = '';
lines.forEach((ln, i) => {
  const end = i + 1 < lines.length ? lines[i + 1].t - 30 : TOTAL;
  srt += `${i + 1}\n${stamp(ln.t, true)} --> ${stamp(end, true)}\n${ln.text}\n\n`;
});
fs.writeFileSync(path.join(OUTDIR, 'llm-narration.srt'), srt, 'utf8');

// ---- VTT（可带场景名，B 站/播放器也能直接吃 SRT，但网页 <track> 只认 VTT）----
let vtt = 'WEBVTT\n\n';
lines.forEach((ln, i) => {
  const end = i + 1 < lines.length ? lines[i + 1].t - 30 : TOTAL;
  const sc = SCRIPT[ln.scene];
  vtt += `${i + 1}\n${stamp(ln.t, false)} --> ${stamp(end, false)}\n`;
  vtt += `<v ${sc.act}>${ln.text}\n\n`;
});
fs.writeFileSync(path.join(OUTDIR, 'llm-narration.vtt'), vtt, 'utf8');

// ---- 章节（给回放页做导航）----
const chapters = SCRIPT.map((sc, i) => ({
  i, t: +(CUM[i] / 1000).toFixed(2), dur: +(sc.dur / 1000).toFixed(2),
  act: sc.act, title: sc.title,
}));
fs.writeFileSync(path.join(OUTDIR, 'chapters.json'), JSON.stringify({ total: +(TOTAL / 1000).toFixed(2), chapters }, null, 2));

console.log('总时长', (TOTAL / 1000).toFixed(1) + 's', '| 台词', lines.length, '条 | 场景', chapters.length, '个');
console.log('写出 out/llm-narration.srt / out/llm-narration.vtt / out/chapters.json');
console.log('首条:', stamp(lines[0].t, true), '「' + lines[0].text.slice(0, 30) + '…」');
console.log('末条:', stamp(lines[lines.length - 1].t, true), '「' + lines[lines.length - 1].text.slice(0, 30) + '…」');
