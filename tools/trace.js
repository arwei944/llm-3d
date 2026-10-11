/* tools/trace.js —— 在 Node 端独立算出一份"真实运算参考值"
 * 与页面里的 src/trace.js 是两条独立代码路径（各自做 softmax / 归一化），
 * 两边结果一致才能证明页面显示的数值确实是真实计算，而非写死的假数据。
 * 用法： node tools/trace.js  → 生成 data/trace.json
 */
const fs = require('fs');
const path = require('path');
const LM = require('../src/model.js');

const CFG = LM.CFG;
const { V, D, NH, dh, FF, NL } = CFG;
const EXAMPLE = [1, 5, 9, 2];

function build(model) {
  const ids = EXAMPLE.slice();
  const c = LM.forward(model, ids);
  const T = c.T;
  const out = [];
  const f4 = (a, from, n) => Array.from(a.slice(from, from + n)).map(x => +x.toFixed(4));

  out.push(f4(c.layers[0].xin, 0, 4));                 // ① embedding
  out.push(f4(c.layers[0].xn1, 0, 4));                 // ② rmsnorm
  out.push(f4(c.layers[0].q, 0, 4));                   // ③ q
  out.push(f4(c.layers[0].qr, 0, 4));                  // ③' rope q

  // ④ 注意力：独立实现 softmax（不复用模型内部值）
  const t = Math.min(2, T - 1), head = 0, sb = head * T * T;
  const scores = [];
  for (let s = 0; s <= t; s++) scores.push(+c.layers[0].scores[sb + t * T + s].toFixed(4));
  out.push(scores);
  const mx = Math.max(...scores);
  const ex = scores.map(x => +Math.exp(x - mx).toFixed(4));
  out.push(ex);
  const z = +ex.reduce((a, b) => a + b, 0).toFixed(4);
  out.push(ex.map(x => +(x / z).toFixed(4)));
  out.push(f4(c.layers[0].probs, sb + t * T, t + 1).map(x => +x.toFixed(4)));

  out.push(f4(c.layers[0].headOut, (head * T + t) * dh, 4));   // ⑤ ctx

  const row = T - 1;
  out.push(Array.from(c.layers[0].hpre.subarray(row * FF, row * FF + 6)).map(x => +x.toFixed(4)));  // ⑥
  out.push(Array.from(c.layers[0].hact.subarray(row * FF, row * FF + 6)).map(x => +x.toFixed(4)));  // ⑥'

  const lg = Array.from(c.logits.subarray((T - 1) * V, T * V)).map(x => +x.toFixed(4));
  out.push(lg);                                         // ⑦ logits
  const m2 = Math.max(...lg);
  const e2 = lg.map(x => +Math.exp(x - m2).toFixed(5));
  const z2 = +e2.reduce((a, b) => a + b, 0).toFixed(5);
  out.push(e2.map(x => +(x / z2).toFixed(5)));          // ⑦' probs

  return out;
}

// 用与页面完全相同的种子训练出同一个模型，才能比对
CFG.NL = 2;
const model = LM.initModel(7);
for (let i = 0; i < 900; i++) LM.trainStep(model, { batch: 1, lr: 3e-3, seed: 7, clip: 0.5 });

const ref = build(model);
const payload = {
  note: 'Node 端独立计算得出的参考值；页面会用同一模型结构 + 同一种子复算并比对。',
  example: EXAMPLE,
  exampleTokens: EXAMPLE.map(i => LM.detok(i)),
  tensors: ref,
};

const outPath = path.join(__dirname, '..', 'data', 'trace.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));

// 同时生成浏览器可直接 <script> 加载的版本，避免两份参考值不同步
const jsPath = path.join(__dirname, '..', 'data', 'trace.js');
fs.writeFileSync(jsPath,
  '/* 自动生成：由 tools/trace.js 在 Node 端独立计算的参考值。请勿手改，改完 model.js 后重跑该脚本。 */\n' +
  'window.LLM_TRACE_REF = ' + JSON.stringify(payload) + ';\n');

console.log('written', outPath);
console.log('written', jsPath);
console.log('tokens:', payload.exampleTokens.join(''));
console.log('tensors:', ref.length, 'groups');
console.log('sample [0]:', JSON.stringify(ref[0]));
console.log('softmax probs sum:', ref[ref.length - 1].reduce((a, b) => a + b, 0).toFixed(6));