/* 在真实模型内注入已知 dcat，检查注意力反传得到的 dxn1。
 * 方法：把 dcat 覆盖进 bwdModel（通过临时 hook），对比数值微分。
 */
const LM = require('./src/model.js');
const { D, V, NH, dh } = LM.CFG;
const ids = [1, 5, 9, 2, 0, 7, 3, 4, 8, 6];
const T = ids.length;

function rnd32(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296}}

LM.CFG.NL = 1;
const m = LM.initModel(42);
const c0 = LM.forward(m, ids);
const LC = c0.layers[0];
const scale = 1 / Math.sqrt(dh);
const INV = [];
for (let j = 0; j < dh / 2; j++) INV[j] = 1 / Math.pow(10000, 2 * j / dh);

const r = rnd32(77);
const dcat = new Float64Array(T * D);
for (let i = 0; i < dcat.length; i++) dcat[i] = r() * 2 - 1;

// 数值微分：L(xn1) = Σ dcat * cat(xn1)，cat 由 attention 从 xn1 算出
function catFromXn1(xn1v) {
  const T2 = T;
  const q = new Float64Array(T2 * D), k = new Float64Array(T2 * D), v = new Float64Array(T2 * D);
  const P = m.blocks[0];
  for (let t = 0; t < T2; t++) for (let d = 0; d < D; d++) {
    let a = P.bq[d], b = P.bk[d], cc = P.bv[d];
    for (let j = 0; j < D; j++) { const xv = xn1v[t * D + j]; a += xv * P.Wq[d * D + j]; b += xv * P.Wk[d * D + j]; cc += xv * P.Wv[d * D + j]; }
    q[t * D + d] = a; k[t * D + d] = b; v[t * D + d] = cc;
  }
  const qr = Float64Array.from(q), kr = Float64Array.from(k);
  for (let h = 0; h < NH; h++) { const off = h * dh;
    for (let t = 0; t < T2; t++) for (let j = 0; j < dh / 2; j++) {
      const ang = t * INV[j], cc = Math.cos(ang), s = Math.sin(ang);
      const a = q[t * D + off + 2 * j], b = q[t * D + off + 2 * j + 1];
      qr[t * D + off + 2 * j] = a * cc - b * s; qr[t * D + off + 2 * j + 1] = a * s + b * cc;
      const a2 = k[t * D + off + 2 * j], b2 = k[t * D + off + 2 * j + 1];
      kr[t * D + off + 2 * j] = a2 * cc - b2 * s; kr[t * D + off + 2 * j + 1] = a2 * s + b2 * cc;
    } }
  const cat = new Float64Array(T2 * D);
  for (let h = 0; h < NH; h++) { const sb = h * T2 * T2, off = h * dh;
    for (let t = 0; t < T2; t++) {
      const w = [];
      for (let u = 0; u <= t; u++) { let a = 0; for (let j = 0; j < dh; j++) a += qr[t * D + off + j] * kr[u * D + off + j]; w.push(a * scale); }
      let mx = -Infinity; for (const x of w) if (x > mx) mx = x;
      let z = 0; const e = w.map(x => { const y = Math.exp(x - mx); z += y; return y; });
      for (let j = 0; j < dh; j++) { let a = 0; for (let u = 0; u <= t; u++) a += (e[u] / z) * v[u * D + off + j]; cat[t * D + off + j] = a; }
    } }
  return cat;
}
function Lof(xn1v) { const cat = catFromXn1(xn1v); let s = 0; for (let i = 0; i < T * D; i++) s += dcat[i] * cat[i]; return s; }

// 模型公式（照抄 bwdModel 注意力段）
const dq = new Float64Array(T * D), dk = new Float64Array(T * D), dv = new Float64Array(T * D);
for (let h = 0; h < NH; h++) {
  const off = h * dh, sb = h * T * T;
  const dhead = new Float64Array(T * dh);
  for (let t = 0; t < T; t++) for (let j = 0; j < dh; j++) dhead[t * dh + j] = dcat[t * D + off + j];
  for (let s = 0; s < T; s++) for (let t = s; t < T; t++) for (let j = 0; j < dh; j++)
    dv[s * D + off + j] += LC.probs[sb + t * T + s] * dhead[t * dh + j];
  for (let t = 0; t < T; t++) {
    let dot = 0;
    for (let s = 0; s <= t; s++) { let a = 0; for (let j = 0; j < dh; j++) a += dhead[t * dh + j] * LC.v[s * D + off + j]; dot += LC.probs[sb + t * T + s] * a; }
    for (let s = 0; s <= t; s++) {
      let a = 0; for (let j = 0; j < dh; j++) a += dhead[t * dh + j] * LC.v[s * D + off + j];
      const ds = LC.probs[sb + t * T + s] * (a - dot) * scale;
      if (ds === 0) continue;
      for (let j = 0; j < dh; j++) { dq[t * D + off + j] += ds * LC.kr[s * D + off + j]; dk[s * D + off + j] += ds * LC.qr[t * D + off + j]; }
    }
  }
}
const dqn = new Float64Array(T * D);
for (let h = 0; h < NH; h++) { const off = h * dh;
  for (let t = 0; t < T; t++) for (let j = 0; j < dh / 2; j++) {
    const ang = t * INV[j], cc = Math.cos(ang), s = Math.sin(ang);
    const a = dq[t * D + off + 2 * j], b = dq[t * D + off + 2 * j + 1];
    dqn[t * D + off + 2 * j] = a * cc + b * s; dqn[t * D + off + 2 * j + 1] = -a * s + b * cc;
  } }
const Wq = m.blocks[0].Wq;
function modelDxn1(ti, di) { let a = 0; for (let j = 0; j < D; j++) a += dqn[ti * D + j] * Wq[di * D + j]; return a; }

const xn1 = Float64Array.from(LC.xn1);
const eps = 1e-6;
console.log(' i     numeric           model            ratio');
let worst = 0;
for (const i of [0, 3, 17, 40, 79, 120]) {
  const t0 = Math.floor(i / D), d0 = i % D;
  const o = xn1[i]; xn1[i] = o + eps; const a = Lof(xn1); xn1[i] = o - eps; const b = Lof(xn1); xn1[i] = o;
  const num = (a - b) / (2 * eps);
  const mod = modelDxn1(t0, d0);
  const rel = Math.abs(num - mod) / Math.max(1e-9, Math.abs(num) + Math.abs(mod));
  worst = Math.max(worst, rel);
  console.log(String(i).padStart(3), num.toExponential(6).padStart(15), mod.toExponential(6).padStart(15), rel.toExponential(2).padStart(10));
}
console.log('\nworst =', worst.toExponential(3), worst < 1e-6 ? '✅ 注意力反传整体正确' : '❌ 注意力反传有误');