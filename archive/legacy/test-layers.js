/* 定位：单层 vs 双层。用 CFG 覆盖 NL，观察各层梯度是否正确。 */
const LM = require('./src/model.js');

function ceGrad(m, ids) {
  const cache = LM.forward(m, ids);
  const T = cache.T, V = LM.CFG.V;
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
  const dl = new Float64Array(T * V);
  for (let t = 0; t < T - 1; t++) for (let v = 0; v < V; v++)
    dl[t * V + v] = (p[t * V + v] - (ids[t + 1] === v ? 1 : 0)) / (T - 1);
  return { loss: loss / (T - 1), cache, dl };
}

const ids = [1, 5, 9, 2, 0, 7, 3, 4, 8, 6];
const eps = 1e-3;

function test(nl, names) {
  LM.CFG.NL = nl;
  const m = LM.initModel(42);
  const { cache, dl } = ceGrad(m, ids);
  LM.bwdModel(m, cache, dl);
  console.log(`\n--- NL=${nl} ---`);
  let worst = 0;
  for (const nm of names) {
    const [a, b] = nm.split('.');
    const P = b === undefined ? m.params[a] : m.blocks[+a.slice(1)][b];
    const G = b === undefined ? m.grads[a] : m.grads['b' + a.slice(1)][b];
    let num = 0, ana = 0;
    const idxs = [0, 5, 11];
    for (const i of idxs) {
      const old = P[i];
      P[i] = old + eps; const l1 = ceGrad(m, ids).loss;
      P[i] = old - eps; const l2 = ceGrad(m, ids).loss;
      P[i] = old;
      num += (l1 - l2) / (2 * eps); ana += G[i];
    }
    num /= idxs.length; ana /= idxs.length;
    const rel = Math.abs(num - ana) / Math.max(1e-7, Math.abs(num) + Math.abs(ana));
    worst = Math.max(worst, rel);
    console.log(nm.padEnd(9), ana.toFixed(7).padStart(12), num.toFixed(7).padStart(12), rel.toExponential(2).padStart(10));
  }
  console.log('worst:', worst.toExponential(2), worst < 5e-2 ? 'OK' : 'BAD');
}

test(1, ['Wte', 'b0.Wq', 'b0.Wk', 'b0.Wv', 'b0.Wo', 'b0.W1', 'b0.W2', 'b0.g1', 'b0.g2']);
test(2, ['Wte', 'b0.Wq', 'b0.Wo', 'b0.W2', 'b1.Wq', 'b1.Wo', 'b1.W2']);