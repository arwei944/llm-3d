/* 决定性测试：数值微分 dL/d(layer0 的 xout)，与反传传下去的 dx_boundary[0] 逐元素对比。 */
const LM = require('./src/model.js');
const { D, V } = LM.CFG;
const ids = [1, 5, 9, 2, 0, 7, 3, 4, 8, 6];

function lossFrom(cache) {
  const T = cache.T;
  const p = new Float64Array(cache.logits.length);
  let mx = -Infinity;
  for (let t = 0; t < T - 1; t++) for (let v = 0; v < V; v++) if (cache.logits[t * V + v] > mx) mx = cache.logits[t * V + v];
  let loss = 0;
  for (let t = 0; t < T - 1; t++) {
    let z = 0;
    for (let v = 0; v < V; v++) { p[t * V + v] = Math.exp(cache.logits[t * V + v] - mx); z += p[t * V + v]; }
    for (let v = 0; v < V; v++) p[t * V + v] /= z;
    loss += -Math.log(Math.max(p[t * V + cache.ids[t + 1]], 1e-12));
  }
  return loss / (T - 1);
}

LM.CFG.NL = 2;
const m = LM.initModel(42);
const base = LM.forward(m, ids);

// 反传一次，拿到 dx_boundary
const cache = LM.forward(m, ids);
const T = cache.T;
const p = new Float64Array(cache.logits.length);
let mx = -Infinity;
for (let t = 0; t < T - 1; t++) for (let v = 0; v < V; v++) if (cache.logits[t * V + v] > mx) mx = cache.logits[t * V + v];
for (let t = 0; t < T - 1; t++) { let z = 0; for (let v = 0; v < V; v++) { p[t * V + v] = Math.exp(cache.logits[t * V + v] - mx); z += p[t * V + v]; } for (let v = 0; v < V; v++) p[t * V + v] /= z; }
const dl = new Float64Array(T * V);
for (let t = 0; t < T - 1; t++) for (let v = 0; v < V; v++) dl[t * V + v] = (p[t * V + v] - (ids[t + 1] === v ? 1 : 0)) / (T - 1);
LM.bwdModel(m, cache, dl);
const ana = m._dxBoundary[0];

// 数值微分：扰动 layer0 的输出
const xout0 = Float32Array.from(base.layers[0].xout);
const eps = 1e-3;
let worst = 0;
console.log('  i    analytic      numeric      ratio');
for (const i of [0, 1, 5, 33, 64, 129, 200, 311]) {
  const old = xout0[i];
  const a = Float32Array.from(xout0); a[i] = old + eps;
  const l1 = lossFrom(LM.forward(m, ids, { 0: a }));
  const b = Float32Array.from(xout0); b[i] = old - eps;
  const l2 = lossFrom(LM.forward(m, ids, { 0: b }));
  xout0[i] = old;
  const num = (l1 - l2) / (2 * eps);
  const A = ana[i];
  const ratio = Math.abs(num - A) / Math.max(1e-9, Math.abs(num) + Math.abs(A));
  worst = Math.max(worst, ratio);
  console.log(String(i).padStart(4), A.toExponential(4).padStart(13), num.toExponential(4).padStart(13), ratio.toExponential(2).padStart(11));
}
console.log('\nworst ratio =', worst.toExponential(3), worst < 1e-2 ? '  ✅ 层间梯度传递正确' : '  ❌ 层间梯度传递有误');