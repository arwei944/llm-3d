/* =============================================================================
 * trace.js —— 「真实运算示例」面板
 * 在浏览器里对固定输入真实跑一遍前向，把逐步数值摊开显示；
 * 并与 tools/trace.js 在 Node 端算出的参考值逐项比对，显示最大绝对误差。
 * 这样"页面里的数是真算的"这件事是可验证的，而不是自称的。
 * ========================================================================== */
(function () {
  'use strict';

  const LM = window.TinyLM;
  const CFG = LM.CFG;
  const { V, D, NH, dh, FF, NL } = CFG;
  const EXAMPLE = [1, 5, 9, 2];     // 固定示例输入： "1 5 9 2"

  const f4 = (a, from, n) => Array.from(a.slice(from, from + n)).map(x => +x.toFixed(4));

  /* 真实计算：返回一份逐步展开的数值报告 */
  function compute(model) {
    const ids = EXAMPLE.slice();
    const c = LM.forward(model, ids);
    const T = c.T;
    const R = { ids, steps: [] };
    const S = (title, formula, detail, arr) => R.steps.push({ title, formula, detail, arr });

    // 1. Embedding
    S('① Embedding 查表', 'x[t] = E[id]',
      `取第 0 个 token (id=${ids[0]}) 的前 4 维`, f4(c.layers[0].xin, 0, 4));

    // 2. RMSNorm
    const L0 = c.layers[0];
    S('② RMSNorm', 'r = 1/√(mean(x²)+ε)',
      `r = ${L0.r1[0].toFixed(4)}，归一化后前 4 维`, f4(L0.xn1, 0, 4));

    // 3. QKV
    S('③ Q/K/V 投影', 'q = x̂·W_Qᵀ',
      '第 0 个 token 的 Q 前 4 维', f4(L0.q, 0, 4));
    S('③′ RoPE 旋转后 Q', "q' = q·cos(tθ) - q_⊥·sin(tθ)",
      '第 0 个 token（t=0 时旋转角为 0，值不变）', f4(L0.qr, 0, 4));

    // 4. 注意力：完整展开 softmax 的手算过程
    const t = Math.min(2, T - 1);
    const head = 0;
    const sb = head * T * T;
    const scores = [];
    for (let s = 0; s <= t; s++) scores.push(+L0.scores[sb + t * T + s].toFixed(4));
    const mx = Math.max(...scores);
    const ex = scores.map(x => +Math.exp(x - mx).toFixed(4));
    const z = +ex.reduce((a, b) => a + b, 0).toFixed(4);
    const pr = ex.map(x => +(x / z).toFixed(4));
    S('④ 注意力分数', 'score = q·k / √d_h',
      `head ${head} 的第 ${t} 行（缩放后）`, scores);
    S('④′ 减最大值（数值稳定）', 'e = exp(score - max)',
      `max = ${mx.toFixed(4)}`, ex);
    S('④″ 归一化', 'p = e / Σe',
      `Σe = ${z.toFixed(4)}`, pr);
    // 校验：与模型内部 probs 一致
    const inner = f4(L0.probs, sb + t * T, t + 1).map(x => +x.toFixed(4));
    S('④‴ softmax 结果（模型内部值）', 'p = softmax(score)',
      '面板手算值与模型内部张量应完全一致', inner);
    // 注意：判定要用「未舍入」的全精度值重算一遍。
    // 上面显示用的 scores/ex/pr 都做了 4 位舍入（与 Node 端参考值保持同一路径），
    // 若直接拿舍入值比对，累计误差可达 ~2e-4，会误报不一致。
    const rScores = [];
    for (let s = 0; s <= t; s++) rScores.push(L0.scores[sb + t * T + s]);
    const rMx = Math.max(...rScores);
    const rEx = rScores.map(x => Math.exp(x - rMx));
    const rZ = rEx.reduce((a, b) => a + b, 0);
    const rPr = rEx.map(x => x / rZ);
    const innerRaw = Array.from(L0.probs.subarray(sb + t * T, sb + t * T + t + 1));

    // 5. 加权求和
    S('⑤ 加权求和 V', 'ctx = Σ p·v',
      `head ${head} 第 ${t} 行的输出前 4 维`, f4(L0.headOut, (head * T + t) * dh, 4));

    // 6. MLP
    const row = T - 1;
    const hpre = Array.from(L0.hpre.subarray(row * FF, row * FF + 6)).map(x => +x.toFixed(4));
    const hact = Array.from(L0.hact.subarray(row * FF, row * FF + 6)).map(x => +x.toFixed(4));
    S('⑥ MLP 升维', 'h = x̂·W₁ᵀ',
      `最后位置前 6 个神经元的预激活值`, hpre);
    S('⑥′ GELU 激活', 'GELU(h) = 0.5h(1+tanh(√(2/π)(h+0.044715h³)))',
      '激活后', hact);

    // 7. logits → softmax
    const lg = Array.from(c.logits.subarray((T - 1) * V, T * V)).map(x => +x.toFixed(4));
    S('⑦ 输出 logits', 'logits = x̂_F·W_lmᵀ',
      `最后位置对全部 ${V} 个 token 的分数`, lg);
    let m2 = Math.max(...lg);
    const e2 = lg.map(x => +Math.exp(x - m2).toFixed(5));
    const z2 = +e2.reduce((a, b) => a + b, 0).toFixed(5);
    const p2 = e2.map(x => +(x / z2).toFixed(5));
    S('⑦′ Softmax 概率', 'p = softmax(logits)',
      `Σ = ${z2.toFixed(5)}（概率之和应为 1）`, p2);

    R.tokens = ids.map(i => LM.detok(i));
    R.top = p2.indexOf(Math.max(...p2));
    R.pSum = +p2.reduce((a, b) => a + b, 0).toFixed(6);
    R.attnConsistent = rPr.length === innerRaw.length && rPr.every((v, i) => Math.abs(v - innerRaw[i]) < 1e-6);
    R.raw = R.steps.map(s => s.arr);
    return R;
  }

  /* 与 Node 端参考值比对 */
  function compare(report, ref) {
    if (!ref) return { ok: false, msg: '未加载参考值 (data/trace.json)' };
    let maxErr = 0;
    const n = Math.min(ref.length, report.raw.length);
    for (let i = 0; i < n; i++) {
      const a = ref[i], b = report.raw[i];
      const m = Math.min(a.length, b.length);
      for (let j = 0; j < m; j++) maxErr = Math.max(maxErr, Math.abs(a[j] - b[j]));
    }
    return {
      ok: maxErr < 1e-3 && n === ref.length,
      maxErr, n, refLen: ref.length,
      msg: `比对 ${n}/${ref.length} 组张量，最大绝对误差 ${maxErr.toExponential(2)}`,
    };
  }

  /* 渲染到 DOM */
  function render(el, model, ref) {
    if (!model) { el.innerHTML = '<div class="muted">模型尚未训练完成。</div>'; return; }
    const R = compute(model);
    const cmp = compare(R, ref);
    let html = '';
    html += `<div class="ex-head">
        <span class="ex-chip">${R.tokens.join('')}</span>
        <span class="muted">固定示例输入，逐层展开真实数值</span>
      </div>`;
    html += `<div class="${cmp.ok ? 'ex-ok' : 'ex-warn'}">
        ${cmp.ok ? '✓ 与 Node 端参考值一致' : '⚠ ' + (cmp.msg || '')}
      </div>`;
    for (const s of R.steps) {
      html += `<div class="ex-step">
          <div class="ex-t">${s.title}</div>
          <div class="ex-f">${s.formula}</div>
          <div class="ex-d">${s.detail}</div>
          <div class="ex-nums">${s.arr.map(v => `<span>${v}</span>`).join('')}</div>
        </div>`;
    }
    html += `<div class="ex-foot">
        概率和 Σp = ${R.pSum} &nbsp;·&nbsp; 预测 top-1 = <b>${LM.detok(R.top)}</b>
        &nbsp;·&nbsp; softmax 手算一致性 ${R.attnConsistent ? '✓' : '✗'}
      </div>`;
    el.innerHTML = html;
  }

  window.LLMTrace = { EXAMPLE, compute, compare, render };
})();