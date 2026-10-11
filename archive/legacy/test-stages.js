/* 逐 t 定位：哪个 token 位置开始分歧 */
const LM = require('./src/model.js');
const { D, NH, dh, FF, EPS, V } = LM.CFG;
LM.CFG.NL = 1;
const m = LM.initModel(42);
const ids = [1, 5, 9, 2, 0, 7, 3, 4, 8, 6];
const T = ids.length, P = m.blocks[0];

const xin0 = new Float64Array(T * D);
for (let t = 0; t < T; t++) for (let d = 0; d < D; d++) xin0[t * D + d] = m.Wte[ids[t] * D + d];
const cache = LM.forward(m, ids, { 0: xin0 });
const LC = cache.layers[0];

// 完整参考（与 test-forward 的 naive 相同）
function naiveAll() {
  const X = [];
  for (let t = 0; t < T; t++) X.push(Float64Array.from(xin0.subarray(t * D, t * D + D)));
  const H = [], Q = [], K = [], VV = [];
  for (let t = 0; t < T; t++) {
    let ss = 0; for (let d = 0; d < D; d++) ss += X[t][d] ** 2;
    const r = 1 / Math.sqrt(ss / D + EPS);
    const h = new Float64Array(D);
    for (let d = 0; d < D; d++) h[d] = X[t][d] * r * P.g1[d];
    H.push(h);
    const q = new Float64Array(D), k = new Float64Array(D), v = new Float64Array(D);
    for (let d = 0; d < D; d++) {
      let a = P.bq[d], b = P.bk[d], c = P.bv[d];
      for (let j = 0; j < D; j++) { a += h[j] * P.Wq[d * D + j]; b += h[j] * P.Wk[d * D + j]; c += h[j] * P.Wv[d * D + j]; }
      q[d] = a; k[d] = b; v[d] = c;
    }
    Q.push(q); K.push(k); VV.push(v);
  }
  const QR = [], KR = [];
  for (let t = 0; t < T; t++) {
    const q = Float64Array.from(Q[t]), k = Float64Array.from(K[t]);
    for (let h = 0; h < NH; h++) for (let j = 0; j < dh / 2; j++) {
      const ang = t * Math.pow(10000, -2 * j / dh), c = Math.cos(ang), s = Math.sin(ang), o = h * dh;
      const a = q[o + 2 * j], b = q[o + 2 * j + 1];
      q[o + 2 * j] = a * c - b * s; q[o + 2 * j + 1] = a * s + b * c;
      const a2 = k[o + 2 * j], b2 = k[o + 2 * j + 1];
      k[o + 2 * j] = a2 * c - b2 * s; k[o + 2 * j + 1] = a2 * s + b2 * c;
    }
    QR.push(q); KR.push(k);
  }
  const cat = [], PR = [];
  for (let t = 0; t < T; t++) {
    const o = new Float64Array(D);
    for (let h = 0; h < NH; h++) {
      const sc = 1 / Math.sqrt(dh);
      const w = []; let mx = -Infinity;
      for (let s = 0; s <= t; s++) {
        let a = 0;
        for (let j = 0; j < dh; j++) a += QR[t][h * dh + j] * KR[s][h * dh + j];
        a *= sc; w.push(a); if (a > mx) mx = a;
      }
      let z = 0; const e = w.map(a => { const r = Math.exp(a - mx); z += r; return r; });
      const pp = e.map(a => a / z);
      PR.push({ t, h, p: pp });
      for (let j = 0; j < dh; j++) {
        let acc = 0;
        for (let s = 0; s <= t; s++) acc += pp[s] * VV[s][h * dh + j];
        o[h * dh + j] = acc;
      }
    }
    cat.push(o);
  }
  return { cat, PR, X };
}
const R = naiveAll();

console.log('t   cat worst      probs worst (head0)');
for (let t = 0; t < T; t++) {
  const mine = LC.cat.subarray(t * D, t * D + D);
  let w = 0;
  for (let i = 0; i < D; i++) w = Math.max(w, Math.abs(mine[i] - R.cat[t][i]) / Math.max(1e-9, Math.abs(R.cat[t][i])));
  // head0 probs
  let pw = 0;
  const refPR = R.PR.find(x => x.t === t && x.h === 0);
  for (let s = 0; s <= t; s++) {
    const mp = LC.probs[0 * T * T + t * T + s];
    pw = Math.max(pw, Math.abs(mp - refPR.p[s]) / Math.max(1e-9, Math.abs(refPR.p[s])));
  }
  console.log(String(t).padStart(2), w.toExponential(2).padStart(12), pw.toExponential(2).padStart(16));
}

// 详细看 t=1 head0 的 probs
console.log('\nt=1, head0 probs:');
const refPR1 = R.PR.find(x => x.t === 1 && x.h === 0);
for (let s = 0; s <= 1; s++) {
  console.log('  s=' + s, 'mine=' + LC.probs[1 * T + s].toExponential(6), 'ref=' + refPR1.p[s].toExponential(6));
}
console.log('\nt=1 head0 raw scores mine:', LC.scores[1 * T + 0].toExponential(6), LC.scores[1 * T + 1].toExponential(6));