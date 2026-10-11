/* 隔离测试：把 bwdModel 末尾的 dxin 组装块单独拎出来，用合成数据做数值微分。
 * L = <dxn1, rmsnorm(xin)*g> + <dxres, xin>
 * 解析解应为 dxin = dxres + r*dxn1*g - r^3*xin*s/D,  s = sum_d(dxn1*g*xin)
 */
const D = 6, T = 4;
function mulberry32(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296}}
const rnd = mulberry32(9);
const xin = new Float64Array(T * D), g1 = new Float64Array(D), dxn1 = new Float64Array(T * D), dxres = new Float64Array(T * D);
for (let i = 0; i < xin.length; i++) xin[i] = rnd() * 2 - 1;
for (let i = 0; i < D; i++) g1[i] = rnd() * 2 - 1;
for (let i = 0; i < dxn1.length; i++) { dxn1[i] = rnd() * 2 - 1; dxres[i] = rnd() * 2 - 1; }
const EPS = 1e-6;

function loss(x) {
  let L = 0;
  for (let t = 0; t < T; t++) {
    let ss = 0;
    for (let d = 0; d < D; d++) ss += x[t * D + d] * x[t * D + d];
    const r = 1 / Math.sqrt(ss / D + EPS);
    for (let d = 0; d < D; d++) {
      L += dxn1[t * D + d] * (x[t * D + d] * r * g1[d]);
      L += dxres[t * D + d] * x[t * D + d];
    }
  }
  return L;
}

// 模型里的组装逻辑（原样照抄）
const r1 = new Float64Array(T);
for (let t = 0; t < T; t++) {
  let ss = 0;
  for (let d = 0; d < D; d++) ss += xin[t * D + d] * xin[t * D + d];
  r1[t] = 1 / Math.sqrt(ss / D + EPS);
}
const dxin = new Float64Array(T * D);
for (let t = 0; t < T; t++) dxin.set(dxres.subarray(t * D, t * D + D), t * D);
for (let t = 0; t < T; t++) {
  let s = 0;
  for (let d = 0; d < D; d++) s += dxn1[t * D + d] * g1[d] * xin[t * D + d];
  const r = r1[t], r3 = r * r * r;
  for (let d = 0; d < D; d++) {
    dxin[t * D + d] += r1[t] * dxn1[t * D + d] * g1[d] - r3 * xin[t * D + d] * s / D;
  }
}

const eps = 1e-6;
let worst = 0;
console.log(' i     analytic        numeric        ratio');
for (const i of [0, 3, 7, 11, 15, 20]) {
  const old = xin[i];
  xin[i] = old + eps; const l1 = loss(xin);
  xin[i] = old - eps; const l2 = loss(xin);
  xin[i] = old;
  const num = (l1 - l2) / (2 * eps);
  const ratio = Math.abs(num - dxin[i]) / Math.max(1e-9, Math.abs(num) + Math.abs(dxin[i]));
  worst = Math.max(worst, ratio);
  console.log(String(i).padStart(2), dxin[i].toFixed(8).padStart(15), num.toFixed(8).padStart(15), ratio.toExponential(2).padStart(10));
}
console.log('\nworst =', worst.toExponential(3), worst < 1e-5 ? '✅ dxin 组装逻辑正确' : '❌ dxin 组装逻辑有误');
console.log('r1 =', Array.from(r1).map(x => x.toFixed(3)).join(', '));