/* 梯度检验：验证反传是否正确。不通过则可视化里的"学习"全是假的。 */
const LM = require('./src/model.js');

function lossOf(m, ids) {
  const cache = LM.forward(m, ids);
  const T = cache.T, L = cache.logits;
  const p = new Float64Array(L.length);
  let loss = 0;
  for (let t = 0; t < T - 1; t++) {
    let mx = -Infinity;
    for (let v = 0; v < LM.CFG.V; v++) if (L[t * LM.CFG.V + v] > mx) mx = L[t * LM.CFG.V + v];
    let z = 0;
    for (let v = 0; v < LM.CFG.V; v++) { p[t * LM.CFG.V + v] = Math.exp(L[t * LM.CFG.V + v] - mx); z += p[t * LM.CFG.V + v]; }
    for (let v = 0; v < LM.CFG.V; v++) p[t * LM.CFG.V + v] /= z;
    loss += -Math.log(Math.max(p[t * LM.CFG.V + cache.ids[t + 1]], 1e-12));
  }
  return loss / (T - 1);
}

const m = LM.initModel(42);
const ids = [1, 5, 9, 2, 0, 7, 3, 4, 8, 6];

// 取一个窗口做 CE + 反传
const cache = LM.forward(m, ids);
const T = cache.T;
const p = new Float64Array(T * LM.CFG.V);
let mx = -Infinity;
for (let t = 0; t < T - 1; t++) for (let v = 0; v < LM.CFG.V; v++) if (cache.logits[t * LM.CFG.V + v] > mx) mx = cache.logits[t * LM.CFG.V + v];
for (let t = 0; t < T - 1; t++) {
  let z = 0;
  for (let v = 0; v < LM.CFG.V; v++) { p[t * LM.CFG.V + v] = Math.exp(cache.logits[t * LM.CFG.V + v] - mx); z += p[t * LM.CFG.V + v]; }
  for (let v = 0; v < LM.CFG.V; v++) p[t * LM.CFG.V + v] /= z;
}
const dl = new Float64Array(T * LM.CFG.V);
for (let t = 0; t < T - 1; t++) for (let v = 0; v < LM.CFG.V; v++)
  dl[t * LM.CFG.V + v] = (p[t * LM.CFG.V + v] - (ids[t + 1] === v ? 1 : 0)) / (T - 1);
LM.bwdModel(m, cache, dl);

const eps = 1e-3;
const check = [
  ['Wte', null], ['Wlm', null], ['blm', null], ['gF', null],
  ['b0.Wq', 0], ['b0.Wk', 3], ['b0.Wv', 7], ['b0.Wo', 1],
  ['b0.W1', 5], ['b0.W2', 2], ['b0.g1', 0], ['b0.g2', 4],
  ['b1.Wq', 9], ['b1.Wk', 1], ['b1.Wv', 4], ['b1.Wo', 6],
  ['b1.W1', 3], ['b1.W2', 8],
];

function getP(path) {
  const [a, b] = path.split('.');
  return b === undefined ? m.params[a] : m.blocks[+a.slice(1)][b];
}
function getG(path) {
  const [a, b] = path.split('.');
  return b === undefined ? m.grads[a] : m.grads['b' + a.slice(1)][b];
}

console.log('param'.padEnd(10), 'analytic'.padStart(12), 'numeric'.padStart(12), 'relerr'.padStart(12));
let worst = 0;
for (const [path, fixedIdx] of check) {
  const P = getP(path), G = getG(path);
  const rnd = LM.mulberry32(1234);
  const idxs = fixedIdx !== null ? [fixedIdx] : Array.from({ length: 8 }, () => Math.floor(rnd() * P.length));
  let num = 0, ana = 0;
  for (const i of idxs) {
    const old = P[i];
    P[i] = old + eps; const l1 = lossOf(m, ids);
    P[i] = old - eps; const l2 = lossOf(m, ids);
    P[i] = old;
    num += (l1 - l2) / (2 * eps);
    ana += G[i];
  }
  num /= idxs.length; ana /= idxs.length;
  const rel = Math.abs(num - ana) / Math.max(1e-6, Math.abs(num) + Math.abs(ana));
  worst = Math.max(worst, rel);
  console.log(path.padEnd(10), ana.toFixed(8).padStart(12), num.toFixed(8).padStart(12), rel.toExponential(2).padStart(12));
}
console.log('\nworst rel err =', worst.toExponential(3), worst < 2e-2 ? '  ✅ PASS' : '  ❌ FAIL');