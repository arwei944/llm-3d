/* 决定性：直接数值微分 dL/dxn1（注入 RMSNorm1 之后），与 bwdModel 的 dxn1 对比。 */
const LM = require('./src/model.js');
const { D, V } = LM.CFG;
const ids = [1, 5, 9, 2, 0, 7, 3, 4, 8, 6];
const T = ids.length;

function lossWith(inject) {
  const c = LM.forward(m, ids, inject);
  const p = new Float64Array(c.logits.length);
  let mx = -Infinity;
  for (let t = 0; t < T - 1; t++) for (let v = 0; v < V; v++) if (c.logits[t * V + v] > mx) mx = c.logits[t * V + v];
  let L = 0;
  for (let t = 0; t < T - 1; t++) {
    let z = 0;
    for (let v = 0; v < V; v++) { p[t * V + v] = Math.exp(c.logits[t * V + v] - mx); z += p[t * V + v]; }
    for (let v = 0; v < V; v++) p[t * V + v] /= z;
    L += -Math.log(Math.max(p[t * V + c.ids[t + 1]], 1e-12));
  }
  return L / (T - 1);
}

LM.CFG.NL = 1;
const m = LM.initModel(42);
const c0 = LM.forward(m, ids);
const p0 = new Float64Array(c0.logits.length);
let mx0 = -Infinity;
for (let t = 0; t < T - 1; t++) for (let v = 0; v < V; v++) if (c0.logits[t * V + v] > mx0) mx0 = c0.logits[t * V + v];
for (let t = 0; t < T - 1; t++) { let z = 0; for (let v = 0; v < V; v++) { p0[t * V + v] = Math.exp(c0.logits[t * V + v] - mx0); z += p0[t * V + v]; } for (let v = 0; v < V; v++) p0[t * V + v] /= z; }
const dl = new Float64Array(T * V);
for (let t = 0; t < T - 1; t++) for (let v = 0; v < V; v++) dl[t * V + v] = (p0[t * V + v] - (ids[t + 1] === v ? 1 : 0)) / (T - 1);
LM.bwdModel(m, c0, dl);
const dxn1 = m._dbg.dxn1_0;

const eps = 1e-6;
console.log(' i     numeric dL/dxn1     bwdModel dxn1      ratio');
let worst = 0;
for (const i of [0, 1, 5, 17, 40, 79, 120, 200]) {
  const inj = new Float64Array(T * D);
  inj[i] = eps;
  const a = lossWith({ xn1_0: inj });
  inj[i] = -eps;
  const b = lossWith({ xn1_0: inj });
  const num = (a - b) / (2 * eps);
  const rel = Math.abs(num - dxn1[i]) / Math.max(1e-9, Math.abs(num) + Math.abs(dxn1[i]));
  worst = Math.max(worst, rel);
  console.log(String(i).padStart(3), num.toExponential(6).padStart(16), dxn1[i].toExponential(6).padStart(16), rel.toExponential(2).padStart(10));
}
console.log('\nworst =', worst.toExponential(3), worst < 1e-5 ? '✅ dxn1 正确 → 问题在 g1 公式' : '❌ dxn1 本身错误 → 注意力反传有缺陷');