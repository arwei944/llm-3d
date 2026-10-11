/* 用一份完全独立、写得最朴素的参考实现校验 forward（NL=1）。
 * 如果 forward 本身有错，反传再对也没意义。 */
const LM = require('./src/model.js');
const { D, NH, dh, FF, EPS, V } = LM.CFG;
const NL = 1;

LM.CFG.NL = NL;
const m = LM.initModel(42);
const ids = [1, 5, 9, 2, 0, 7, 3, 4, 8, 6];
const T = ids.length;
const P = m.blocks[0];

// ---- 朴素参考实现 ----
function naive(xin) {
  const X = [];
  for (let t = 0; t < T; t++) X.push(Float64Array.from(xin.subarray(t * D, t * D + D)));
  let H = [];
  for (let t = 0; t < T; t++) {
    let ss = 0; for (let d = 0; d < D; d++) ss += X[t][d] * X[t][d];
    const r = 1 / Math.sqrt(ss / D + EPS);
    const o = new Float64Array(D);
    for (let d = 0; d < D; d++) o[d] = X[t][d] * r * P.g1[d];
    H.push(o);
  }
  const Q = [], K = [], Vv = [];
  for (let t = 0; t < T; t++) {
    const q = new Float64Array(D), k = new Float64Array(D), v = new Float64Array(D);
    for (let d = 0; d < D; d++) {
      let a = P.bq[d], b = P.bk[d], c = P.bv[d];
      for (let j = 0; j < D; j++) { a += H[t][j] * P.Wq[d * D + j]; b += H[t][j] * P.Wk[d * D + j]; c += H[t][j] * P.Wv[d * D + j]; }
      q[d] = a; k[d] = b; v[d] = c;
    }
    Q.push(q); K.push(k); Vv.push(v);
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
  const cat = [];
  for (let t = 0; t < T; t++) {
    const o = new Float64Array(D);
    for (let h = 0; h < NH; h++) {
      const sc = 1 / Math.sqrt(dh);
      const w = [];
      let mx = -Infinity;
      for (let s = 0; s <= t; s++) {
        let a = 0;
        for (let j = 0; j < dh; j++) a += QR[t][h * dh + j] * KR[s][h * dh + j];
        a *= sc; w.push(a); if (a > mx) mx = a;
      }
      let z = 0; const e = w.map(a => { const r = Math.exp(a - mx); z += r; return r; });
      for (let j = 0; j < dh; j++) {
        let acc = 0;
        for (let s = 0; s <= t; s++) acc += (e[s] / z) * Vv[s][h * dh + j];
        o[h * dh + j] = acc;
      }
    }
    cat.push(o);
  }
  const xres = [];
  for (let t = 0; t < T; t++) {
    const o = new Float64Array(D);
    for (let d = 0; d < D; d++) {
      let a = P.bo[d];
      for (let j = 0; j < D; j++) a += cat[t][j] * P.Wo[d * D + j];
      o[d] = a + X[t][d];
    }
    xres.push(o);
  }
  const H2 = [];
  for (let t = 0; t < T; t++) {
    let ss = 0; for (let d = 0; d < D; d++) ss += xres[t][d] * xres[t][d];
    const r = 1 / Math.sqrt(ss / D + EPS);
    const o = new Float64Array(D);
    for (let d = 0; d < D; d++) o[d] = xres[t][d] * r * P.g2[d];
    H2.push(o);
  }
  const XO = [];
  for (let t = 0; t < T; t++) {
    const act = new Float64Array(FF);
    for (let j = 0; j < FF; j++) {
      let a = P.b1[j];
      for (let d = 0; d < D; d++) a += H2[t][d] * P.W1[j * D + d];
      const x0 = a, u = Math.sqrt(2 / Math.PI) * (x0 + 0.044715 * x0 ** 3);
      act[j] = 0.5 * x0 * (1 + Math.tanh(u));
    }
    const o = new Float64Array(D);
    for (let d = 0; d < D; d++) {
      let a = P.b2[d];
      for (let j = 0; j < FF; j++) a += act[j] * P.W2[d * FF + j];
      o[d] = a + xres[t][d];
    }
    XO.push(o);
  }
  const XF = [];
  for (let t = 0; t < T; t++) {
    let ss = 0; for (let d = 0; d < D; d++) ss += XO[t][d] * XO[t][d];
    const r = 1 / Math.sqrt(ss / D + EPS);
    const o = new Float64Array(D);
    for (let d = 0; d < D; d++) o[d] = XO[t][d] * r * m.gF[d];
    XF.push(o);
  }
  const lg = [];
  for (let t = 0; t < T; t++) {
    const o = new Float64Array(V);
    for (let v = 0; v < V; v++) { let a = m.blm[v]; for (let d = 0; d < D; d++) a += XF[t][d] * m.Wlm[v * D + d]; o[v] = a; }
    lg.push(o);
  }
  return { lg, XO, XF };
}

// 对比
const xin0 = new Float64Array(T * D);
for (let t = 0; t < T; t++) for (let d = 0; d < D; d++) xin0[t * D + d] = m.Wte[ids[t] * D + d];
const ref = naive(xin0);
const got = LM.forward(m, ids, { 0: xin0 });

let worst = 0;
for (let t = 0; t < T; t++) for (let v = 0; v < V; v++) {
  const a = ref.lg[t][v], b = got.logits[t * V + v];
  worst = Math.max(worst, Math.abs(a - b) / Math.max(1e-9, Math.abs(a)));
}
console.log('forward vs naive reference (NL=1): worst rel =', worst.toExponential(3), worst < 1e-10 ? '✅ forward 正确' : '❌ forward 有误');

// Layer0 输入也对比
const cache = LM.forward(m, ids);
console.log('embedding cache sample:', cache.layers[0].xin[0].toFixed(6), 'vs', xin0[0].toFixed(6));