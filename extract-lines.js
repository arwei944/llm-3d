/* 从讲解脚本提取台词行（与 make-subs.js 同一时间换算），供配音流程使用。
 * 输出 out/_lines.json: [{i, t, end, gap, text, chars, scene}]
 *   t    台词绝对开始时间(s)
 *   gap  到下一行开始的可用秒数
 * 用法: node extract-lines.js
 */
const fs = require('fs'), path = require('path'), vm = require('vm');

const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'src', 'narration.js'), 'utf8'), sandbox, { filename: 'narration.js' });
const C = sandbox.window.LLMCine;
if (!C || !C.scenes) throw new Error('没能从 narration.js 取到 SCRIPT');
const SCRIPT = C.scenes, CUM = C.cum, TOTAL = C.total;

const lines = [];
SCRIPT.forEach((sc, i) => {
  (sc.talk || []).forEach(([p, text]) => {
    lines.push({ t: CUM[i] + sc.dur * p, text: String(text), scene: i });
  });
});
lines.sort((a, b) => a.t - b.t);

// 可读性评估字符数：去掉标点（TTS 停顿不占太多时间）后按汉字计
const speakable = (s) => s.replace(/[，。；：、？！,.:;?!"'（）()【】\[\]—…·“”‘’\s]/g, '').length;

// 先统一换算成秒，再算间隔
lines.forEach(ln => { ln.t = +(ln.t / 1000).toFixed(3); });
lines.forEach((ln, i) => {
  const next = i + 1 < lines.length ? lines[i + 1].t : TOTAL / 1000;
  ln.i = i;
  ln.gap = +(next - ln.t).toFixed(3);
  ln.chars = speakable(ln.text);
});

fs.writeFileSync(path.join(__dirname, 'out', '_lines.json'), JSON.stringify({ total: TOTAL, lines }, null, 1));

// 统计：按默认语速 4.5 字/秒，多少行会超时
const bad = lines.filter(l => l.chars / 4.5 > l.gap);
console.log(`行数 ${lines.length}，总长 ${TOTAL}s`);
console.log(`默认语速(4.5字/s)超时行数: ${bad.length}`);
if (bad.length) {
  const worst = bad.slice().sort((a, b) => b.chars / b.gap - a.chars / a.gap).slice(0, 10);
  for (const w of worst) console.log(`  t=${w.t}s gap=${w.gap}s chars=${w.chars} 需语速+${Math.round((w.chars / w.gap / 4.5 - 1) * 100)}% 「${w.text.slice(0, 16)}…」`);
}
