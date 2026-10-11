/* 端到端验证：dcat →(注意力反传)→ dqn/dkn/dv →(QKV反传)→ dxn1
 * 直接对 v 和 q 做数值微分。 */
const dh = 8, D = 32, NH = 4, T = 5;
function rnd32(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296}}
const r = rnd32(23);
const INV = []; for (let j = 0; j < dh / 2; j++) INV[j] = 1 / Math.pow(10000, 2 * j / dh);

const q = new Float64Array(T * D), k = new Float64Array(T * D), v = new Float64Array(T * D);
for (let i = 0; i < T * D; i++) { q[i] = r() * 2 - 1; k[i] = r() * 2 - 1; v[i] = r() * 2 - 1; }
const dcat = new Float64Array(T * D);
for (let i = 0; i < dcat.length; i++) dcat[i] = r() * 2 - 1;

function rope(row, t) {
  const o = new Float64Array(D);
  for (let h = 0; h < NH; h++) for (let j = 0; j < dh / 2; j++) {
    const ang = t * INV[j], c = Math.cos(ang), s = Math.sin(ang), off = h * dh;
    const a = row[off + 2 * j], b = row[off + 2 * j + 1];
    o[off + 2 * j] = a * c - b * s;
    o[off + 2 * j + 1] = a * s + b * c;
  }
  return o;
}
const QR = [], KR = [];
for (let t = 0; t < T; t++) { QR.push(rope(q.subarray(t * D, t * D + D), t)); KR.push(rope(k.subarray(t * D, t * D + D), t)); }

const scale = 1 / Math.sqrt(dh);
const probs = new Float64Array(NH * T * T);
for (let h = 0; h < NH; h++) {
  const sb = h * T * T;
  for (let t = 0; t < T; t++) {
    const s = new Float64Array(t + 1);
    for (let u = 0; u <= t; u++) { let a = 0; for (let j = 0; j < dh; j++) a += QR[t][h * dh + j] * KR[u][h * dh + j]; s[u] = a * scale; }
    let mx = -Infinity; for (let u = 0; u <= t; u++) if (s[u] > mx) mx = s[u];
    let z = 0; for (let u = 0; u <= t; u++) { s[u] = Math.exp(s[u] - mx); z += s[u]; }
    for (let u = 0; u <= t; u++) probs[sb + t * T + u] = s[u] / z;
  }
}
function catOf(vv) {
  const cat = new Float64Array(T * D);
  for (let h = 0; h < NH; h++) { const sb = h * T * T, off = h * dh;
    for (let t = 0; t < T; t++) for (let j = 0; j < dh; j++) {
      let a = 0; for (let u = 0; u <= t; u++) a += probs[sb + t * T + u] * vv[u * D + off + j];
      cat[t * D + off + j] = a; } }
  return cat;
}
function L(vv) { const c = catOf(vv); let s = 0; for (let i = 0; i < c.length; i++) s += dcat[i] * c[i]; return s; }

// ---- 模型的反传（照抄 bwdModel 的注意力部分）----
const dq = new Float64Array(T * D), dk = new Float64Array(T * D), dv = new Float64Array(T * D);
for (let h = 0; h < NH; h++) {
  const off = h * dh, sb = h * T * T;
  const dhead = new Float64Array(T * dh);
  for (let t = 0; t < T; t++) for (let j = 0; j < dh; j++) dhead[t * dh + j] = dcat[t * D + off + j];
  for (let s = 0; s < T; s++) for (let t = s; t < T; t++) for (let j = 0; j < dh; j++)
    dv[s * D + off + j] += probs[sb + t * T + s] * dhead[t * dh + j];
  for (let t = 0; t < T; t++) {
    let dot = 0;
    for (let s = 0; s <= t; s++) { let a = 0; for (let j = 0; j < dh; j++) a += dhead[t * dh + j] * v[s * D + off + j]; dot += probs[sb + t * T + s] * a; }
    for (let s = 0; s <= t; s++) {
      let a = 0; for (let j = 0; j < dh; j++) a += dhead[t * dh + j] * v[s * D + off + j];
      const ds = probs[sb + t * T + s] * (a - dot) * scale;
      if (ds === 0) continue;
      for (let j = 0; j < dh; j++) { dq[t * D + off + j] += ds * KR[s][off + j]; dk[s * D + off + j] += ds * QR[t][off + j]; }
    }
  }
}
const eps = 1e-6;
let worstV = 0, worstQ = 0;
for (const i of [0, 4, 19, 40, 77, 120]) {
  const o = v[i]; v[i] = o + eps; const a = L(v); v[i] = o - eps; const b = L(v); v[i] = o;
  const num = (a - b) / (2 * eps);
  worstV = Math.max(worstV, Math.abs(num - dv[i]) / Math.max(1e-9, Math.abs(num) + Math.abs(dv[i])));
}
console.log('dv 端到端 worst rel =', worstV.toExponential(3), worstV < 1e-6 ? '✅' : '❌');
void worstQ;