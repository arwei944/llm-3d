/* 数值微分 dL/dq（含 RoPE 逆旋转 + Wq 投影），验证 dq/dxn1 公式 */
const dh = 8, D = 32, NH = 4, T = 5;
function rnd32(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296}}
const r = rnd32(31);
const INV = []; for (let j = 0; j < dh / 2; j++) INV[j] = 1 / Math.pow(10000, 2 * j / dh);
function rope(row, t) {
  const o = new Float64Array(D);
  for (let h = 0; h < NH; h++) for (let j = 0; j < dh / 2; j++) {
    const ang = t * INV[j], c = Math.cos(ang), s = Math.sin(ang), off = h * dh;
    const a = row[off + 2 * j], b = row[off + 2 * j + 1];
    o[off + 2 * j] = a * c - b * s; o[off + 2 * j + 1] = a * s + b * c;
  }
  return o;
}
const q = new Float64Array(T * D), k = new Float64Array(T * D), v = new Float64Array(T * D);
for (let i = 0; i < T * D; i++) { q[i] = r() * 2 - 1; k[i] = r() * 2 - 1; v[i] = r() * 2 - 1; }
// Wq 随机
const Wq = new Float64Array(D * D);
for (let i = 0; i < Wq.length; i++) Wq[i] = r() * 0.2;
const dcat = new Float64Array(T * D);
for (let i = 0; i < dcat.length; i++) dcat[i] = r() * 2 - 1;

function L(qq) {
  const QR = [], KR = [];
  for (let t = 0; t < T; t++) { QR.push(rope(qq.subarray(t * D, t * D + D), t)); KR.push(rope(k.subarray(t * D, t * D + D), t)); }
  const scale = 1 / Math.sqrt(dh);
  let s = 0;
  for (let h = 0; h < NH; h++) { const off = h * dh;
    for (let t = 0; t < T; t++) {
      const w = [];
      for (let u = 0; u <= t; u++) { let a = 0; for (let j = 0; j < dh; j++) a += QR[t][off + j] * KR[u][off + j]; w.push(a * scale); }
      let mx = -Infinity; for (const x of w) if (x > mx) mx = x;
      let z = 0; const e = w.map(x => { const y = Math.exp(x - mx); z += y; return y; });
      for (let j = 0; j < dh; j++) {
        let acc = 0;
        for (let u = 0; u <= t; u++) acc += (e[u] / z) * v[u * D + off + j];
        s += dcat[t * D + off + j] * acc;
      }
    }
  }
  return s;
}
// 模型公式：dq → RoPE 逆旋转 → dqn → dxn1 = dqn @ Wq
const scale = 1 / Math.sqrt(dh);
const QR = [], KR = [];
for (let t = 0; t < T; t++) { QR.push(rope(q.subarray(t * D, t * D + D), t)); KR.push(rope(k.subarray(t * D, t * D + D), t)); }
const probs = new Float64Array(NH * T * T);
for (let h = 0; h < NH; h++) { const off = h * dh, sb = h * T * T;
  for (let t = 0; t < T; t++) {
    const w = []; for (let u = 0; u <= t; u++) { let a = 0; for (let j = 0; j < dh; j++) a += QR[t][off + j] * KR[u][off + j]; w.push(a * scale); }
    let mx = -Infinity; for (const x of w) if (x > mx) mx = x;
    let z = 0; const e = w.map(x => { const y = Math.exp(x - mx); z += y; return y; });
    for (let u = 0; u <= t; u++) probs[sb + t * T + u] = e[u] / z;
  } }
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
const dqn = new Float64Array(T * D);
for (let h = 0; h < NH; h++) { const off = h * dh;
  for (let t = 0; t < T; t++) for (let j = 0; j < dh / 2; j++) {
    const ang = t * INV[j], c = Math.cos(ang), s = Math.sin(ang);
    const a = dq[t * D + off + 2 * j], b = dq[t * D + off + 2 * j + 1];
    dqn[t * D + off + 2 * j] = a * c + b * s; dqn[t * D + off + 2 * j + 1] = -a * s + b * c;
  } }
const eps = 1e-6;
console.log(' i     numeric dq         模型 dqn@Wq        ratio');
let worst = 0;
for (const i of [0, 3, 17, 40, 79, 120]) {
  const o = q[i]; q[i] = o + eps; const a = L(q); q[i] = o - eps; const b = L(q); q[i] = o;
  const num = (a - b) / (2 * eps);
  let mod = 0;
  for (let d = 0; d < D; d++) mod += dqn[i % D === 0 ? i : (i - (i % D)) + d] * 0; // placeholder
  // dxn1[i] = sum_j dqn[j]*Wq[i*D+j]  (i 是 t*D+d 中的 d=i%D)
  const t0 = Math.floor(i / D), dd = i % D;
  let dxn1i = 0;
  for (let j = 0; j < D; j++) dxn1i += dqn[t0 * D + j] * Wq[dd * D + j];
  void mod;
  const rel = Math.abs(num - dxn1i) / Math.max(1e-9, Math.abs(num) + Math.abs(dxn1i));
  worst = Math.max(worst, rel);
  console.log(String(i).padStart(3), num.toExponential(6).padStart(15), dxn1i.toExponential(6).padStart(16), rel.toExponential(2).padStart(10));
}
console.log('\nworst =', worst.toExponential(3), worst < 1e-5 ? '✅ dq 路径正确' : '❌ dq 路径有误');