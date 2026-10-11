/* 隔离注意力反传：给定 q,k,v,probs 与上游梯度 gcat，
 * 数值微分得到 dL/dv，再与模型公式比较。
 * 模型里 dv 通过 "多头拼接" 得到：dhead[t,j] = dcat[t, h*dh+j]
 */
const dh = 4, D = 16, NH = 4, T = 5;

function rnd32(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296}}
const r = rnd32(11);
const qr = new Float64Array(T * D), kr = new Float64Array(T * D), v = new Float64Array(T * D);
for (let i = 0; i < v.length; i++) { qr[i] = r() * 2 - 1; kr[i] = r() * 2 - 1; v[i] = r() * 2 - 1; }

// probs 固定（视为常数）
const probs = new Float64Array(NH * T * T);
const scale = 1 / Math.sqrt(dh);
for (let h = 0; h < NH; h++) {
  const sb = h * T * T;
  for (let t = 0; t < T; t++) {
    const s = new Float64Array(t + 1);
    for (let u = 0; u <= t; u++) {
      let a = 0;
      for (let j = 0; j < dh; j++) a += qr[t * D + h * dh + j] * kr[u * D + h * dh + j];
      s[u] = a * scale;
    }
    let mx = -Infinity; for (let u = 0; u <= t; u++) if (s[u] > mx) mx = s[u];
    let z = 0; for (let u = 0; u <= t; u++) { s[u] = Math.exp(s[u] - mx); z += s[u]; }
    for (let u = 0; u <= t; u++) probs[sb + t * T + u] = s[u] / z;
  }
}

// 上游梯度 dcat（拼接后的）
const dcat = new Float64Array(T * D);
for (let i = 0; i < dcat.length; i++) dcat[i] = r() * 2 - 1;

// L(v) = sum_{h,t,j} dcat[t, h*dh+j] * (sum_s p[t,s] * v[s, h*dh+j])
function L(vv) {
  let s = 0;
  for (let h = 0; h < NH; h++) {
    const sb = h * T * T, off = h * dh;
    for (let t = 0; t < T; t++)
      for (let j = 0; j < dh; j++) {
        let acc = 0;
        for (let u = 0; u <= t; u++) acc += probs[sb + t * T + u] * vv[u * D + off + j];
        s += dcat[t * D + off + j] * acc;
      }
  }
  return s;
}

// 模型公式
const dv = new Float64Array(T * D);
for (let h = 0; h < NH; h++) {
  const off = h * dh, sb = h * T * T;
  const dhead = new Float64Array(T * dh);
  for (let t = 0; t < T; t++) for (let j = 0; j < dh; j++) dhead[t * dh + j] = dcat[t * D + off + j];
  for (let s2 = 0; s2 < T; s2++)
    for (let t = s2; t < T; t++)
      for (let j = 0; j < dh; j++)
        dv[s2 * D + off + j] += probs[sb + t * T + s2] * dhead[t * dh + j];
}

const eps = 1e-6;
let worst = 0;
console.log(' i      numeric            model');
const probes = [0, 2, 9, 17, 33, 51, 70, 79];
for (const i of probes) {
  const o = v[i];
  v[i] = o + eps; const a = L(v);
  v[i] = o - eps; const b = L(v);
  v[i] = o;
  const num = (a - b) / (2 * eps);
  const rel = Math.abs(num - dv[i]) / Math.max(1e-9, Math.abs(num) + Math.abs(dv[i]));
  worst = Math.max(worst, rel);
  console.log(String(i).padStart(3), num.toFixed(8).padStart(15), dv[i].toFixed(8).padStart(15), rel.toExponential(2).padStart(10));
}
console.log('\nworst =', worst.toExponential(3), worst < 1e-6 ? '✅ dv 公式正确' : '❌ dv 公式有误');