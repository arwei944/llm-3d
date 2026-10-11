/* =============================================================================
 * model.js — 一个真实可训练的微型 Transformer（纯 JS，无依赖）
 * 设计目标：让 3D 可视化里的每一个数字都来自真实计算，而不是编出来的动画。
 *
 * 架构（刻意做成"能看清每个原子步骤"的尺寸）：
 *   V=12  D=32  NH=4  dh=8  FF=64  NL=2  ctx=16
 *
 * 词表：0-9 数字 + 空格 + 分隔符，训练数据是"随机块序列"拼接而成，
 * 会自然诱导出 induction head（重复模式头），注意力矩阵出现清晰对角条纹。
 * ========================================================================== */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- RNG
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 高斯随机（Box-Muller）
  function gauss(rnd) {
    let u = 0, v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // ------------------------------------------------------------ 词表
  const VOCAB = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '·', '|'];
  const V = VOCAB.length;          // 12
  const SPACE = 10, SEP = 11;

  function detok(id) { return VOCAB[id] !== undefined ? VOCAB[id] : '?'; }
  function tok(str) {
    const i = VOCAB.indexOf(String(str));
    return i < 0 ? SPACE : i;
  }

  /* 训练语料生成：随机长度的数字块，用 SEP 分隔。
   * 重复出现的"块"结构正是 induction head 的用武之地。 */
  function makeStream(seed, n) {
    const r = mulberry32(seed);
    const out = [];
    while (out.length < n) {
      const L = 3 + Math.floor(r() * 5);      // 3..7
      for (let i = 0; i < L; i++) out.push(Math.floor(r() * 10));
      out.push(SEP);
      if (r() < 0.3) out.push(SPACE);
    }
    return out;
  }

  // ---------------------------------------------------------- 激活函数
  const GELU_C = Math.sqrt(2 / Math.PI);
  function gelu(x) {
    const u = GELU_C * (x + 0.044715 * x * x * x);
    return 0.5 * x * (1 + Math.tanh(u));
  }
  function dgelu(x) {
    const u = GELU_C * (x + 0.044715 * x * x * x);
    const t = Math.tanh(u);
    return 0.5 * (1 + t) + 0.5 * x * (1 - t * t) * GELU_C * (1 + 3 * 0.044715 * x * x);
  }
  function softmax(arr, from, to, T) {
    let mx = -Infinity;
    for (let i = from; i < to; i++) if (arr[i] > mx) mx = arr[i];
    let sum = 0;
    for (let i = from; i < to; i++) { arr[i] = Math.exp((arr[i] - mx) / T); sum += arr[i]; }
    for (let i = from; i < to; i++) arr[i] /= sum;
    return sum;
  }

  // ---------------------------------------------------------- 模型构造
  const CFG = { V, D: 32, NH: 4, FF: 64, NL: 2, CTX: 16, EPS: 1e-6 };
  CFG.dh = CFG.D / CFG.NH;

  function initModel(seed) {
    const { D, FF, NL } = CFG;
    const rnd = mulberry32(seed >>> 0);
    const nrm = (n, s) => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = gauss(rnd) * s; return a; };
    const ones = (n) => { const a = new Float64Array(n); a.fill(1); return a; };

    // RMSNorm 的输出是单位尺度，所以线性层用 1/sqrt(fan_in) 初始化，
    // 否则前向尺度逐层放大、反传梯度爆炸（实测会 NaN）。
    const sD = 1 / Math.sqrt(D), sFF = 1 / Math.sqrt(FF);

    const m = {
      cfg: CFG,
      Wte: nrm(V * D, 0.08),
      blocks: [],
      gF: ones(D),
      Wlm: nrm(V * D, sD),
      blm: new Float64Array(V),
    };
    for (let l = 0; l < NL; l++) {
      m.blocks.push({
        g1: ones(D),
        Wq: nrm(D * D, sD), bq: new Float64Array(D),
        Wk: nrm(D * D, sD), bk: new Float64Array(D),
        Wv: nrm(D * D, sD), bv: new Float64Array(D),
        Wo: nrm(D * D, sD), bo: new Float64Array(D),
        g2: ones(D),
        W1: nrm(FF * D, sFF), b1: new Float64Array(FF),
        W2: nrm(D * FF, sFF), b2: new Float64Array(D),
      });
    }
    m.params = collectParams(m);
    m.grads = zeroGrad(m.params);
    return m;
  }

  // 参数展平（训练用）
  const PARAM_KEYS = (() => {
    const keys = ['Wte', 'gF', 'Wlm', 'blm'];
    const bk = ['g1', 'Wq', 'bq', 'Wk', 'bk', 'Wv', 'bv', 'Wo', 'bo', 'g2', 'W1', 'b1', 'W2', 'b2'];
    return { top: keys, block: bk, NL: CFG.NL };
  })();

  function collectParams(m) {
    const out = {};
    out.Wte = m.Wte; out.gF = m.gF; out.Wlm = m.Wlm; out.blm = m.blm;
    m.blocks.forEach((b, i) => { const o = {}; for (const k of PARAM_KEYS.block) o[k] = b[k]; out['b' + i] = o; });
    return out;
  }
  function zeroGrad(p) {
    const g = {};
    for (const k in p) {
      if (k[0] === 'b' && !isNaN(+k[1])) {
        const o = {}; for (const kk in p[k]) o[kk] = new Float64Array(p[k][kk].length);
        g[k] = o;
      } else g[k] = new Float64Array(p[k].length);
    }
    return g;
  }

  // RoPE 频率（按 dh 计算，两两旋转）
  const ROPE_THETA = 10000;
  const ROPE_INV = (() => {
    const a = new Float64Array(CFG.dh / 2);
    for (let j = 0; j < a.length; j++) a[j] = 1 / Math.pow(ROPE_THETA, (2 * j) / CFG.dh);
    return a;
  })();

  /* ============================================================ 前向传播
   * 返回 logits [T,V] 以及一份完整 cache（可视化直接读它）。
   * cache 里保留了所有"原子步骤"级别的中间量。
   * ================================================================ */
  function forward(m, ids, inject) {
    const { D, NH, dh, FF, NL, EPS } = m.cfg;
    const T = ids.length;

    // --- 1. Token Embedding 查表 ---
    const xin0 = new Float64Array(T * D);
    for (let t = 0; t < T; t++) {
      const id = ids[t] | 0, off = id * D;
      for (let d = 0; d < D; d++) xin0[t * D + d] = m.Wte[off + d];
    }

    const cache = { T, ids: ids.slice(), layers: [], logits: null };
    let x = xin0;

    for (let l = 0; l < NL; l++) {
      const P = m.blocks[l];
      const LC = { P };

      // --- 2. RMSNorm ---
      const r1 = new Float64Array(T);
      const xn1 = new Float64Array(T * D);
      for (let t = 0; t < T; t++) {
        let ss = 0;
        for (let d = 0; d < D; d++) ss += x[t * D + d] * x[t * D + d];
        const r = 1 / Math.sqrt(ss / D + EPS);
        r1[t] = r;
        for (let d = 0; d < D; d++) xn1[t * D + d] = x[t * D + d] * r * P.g1[d];
      }
      LC.r1 = r1; LC.xn1 = xn1;

      // --- 3. QKV 线性投影 ---
      const q = new Float64Array(T * D), k = new Float64Array(T * D), v = new Float64Array(T * D);
      for (let t = 0; t < T; t++) {
        for (let d = 0; d < D; d++) {
          let aq = P.bq[d], ak = P.bk[d], av = P.bv[d];
          const wo = d * D;
          for (let j = 0; j < D; j++) {
            const xv = xn1[t * D + j];
            aq += xv * P.Wq[wo + j];
            ak += xv * P.Wk[wo + j];
            av += xv * P.Wv[wo + j];
          }
          q[t * D + d] = aq; k[t * D + d] = ak; v[t * D + d] = av;
        }
      }
      LC.q = q; LC.k = k; LC.v = v;

      // --- 4. RoPE 位置旋转 ---
      const qr = new Float64Array(T * D), kr = new Float64Array(T * D);
      const ropeAng = new Float64Array(T * (dh / 2));
      qr.set(q); kr.set(k);
      for (let h = 0; h < NH; h++) {
        const off = h * dh;
        for (let t = 0; t < T; t++) {
          for (let j = 0; j < dh / 2; j++) {
            const ang = t * ROPE_INV[j];
            ropeAng[t * (dh / 2) + j] = ang;
            const c = Math.cos(ang), s = Math.sin(ang);
            const a = q[t * D + off + 2 * j], b = q[t * D + off + 2 * j + 1];
            qr[t * D + off + 2 * j] = a * c - b * s;
            qr[t * D + off + 2 * j + 1] = a * s + b * c;
            const a2 = k[t * D + off + 2 * j], b2 = k[t * D + off + 2 * j + 1];
            kr[t * D + off + 2 * j] = a2 * c - b2 * s;
            kr[t * D + off + 2 * j + 1] = a2 * s + b2 * c;
          }
        }
      }
      LC.qr = qr; LC.kr = kr; LC.ropeAng = ropeAng;

      // --- 5. 多头因果注意力 ---
      const scale = 1 / Math.sqrt(dh);
      const scores = new Float64Array(NH * T * T);
      const probs = new Float64Array(NH * T * T);
      const headOut = new Float64Array(NH * T * dh);
      for (let h = 0; h < NH; h++) {
        const off = h * dh, sBase = h * T * T;
        for (let t = 0; t < T; t++) {
          for (let s = 0; s <= t; s++) {
            let acc = 0;
            for (let j = 0; j < dh; j++) acc += qr[t * D + off + j] * kr[s * D + off + j];
            scores[sBase + t * T + s] = acc * scale;
          }
          // 注意：softmax() 是「就地」修改数组的。
          // 若直接 softmax(scores, ...)，scores 会被概率覆盖，
          // 可视化就拿不到原始注意力分数了（表现为"分数"和为 1）。
          // 因此先把原始分数拷进 probs，再对 probs 做 softmax。
          for (let s = 0; s <= t; s++) probs[sBase + t * T + s] = scores[sBase + t * T + s];
          softmax(probs, sBase + t * T, sBase + t * T + t + 1, 1);
        }
        for (let t = 0; t < T; t++) {
          for (let j = 0; j < dh; j++) {
            let acc = 0;
            for (let s = 0; s <= t; s++) acc += probs[sBase + t * T + s] * v[s * D + off + j];
            headOut[(h * T + t) * dh + j] = acc;
          }
        }
      }
      LC.scores = scores; LC.probs = probs; LC.headOut = headOut;

      // 多头拼接 → 输出投影
      const cat = new Float64Array(T * D);
      for (let h = 0; h < NH; h++)
        for (let t = 0; t < T; t++)
          for (let j = 0; j < dh; j++)
            cat[t * D + h * dh + j] = headOut[(h * T + t) * dh + j];
      LC.cat = cat;

      const aout = new Float64Array(T * D);
      for (let t = 0; t < T; t++)
        for (let d = 0; d < D; d++) {
          let acc = P.bo[d];
          const wo = d * D;
          for (let j = 0; j < D; j++) acc += cat[t * D + j] * P.Wo[wo + j];
          aout[t * D + d] = acc;
        }
      LC.aout = aout;

      // 残差连接 1
      const xres = new Float64Array(T * D);
      for (let i = 0; i < T * D; i++) xres[i] = x[i] + aout[i];
      LC.xin = x;          // 本层输入（反传 RMSNorm1 与残差直通用）
      LC.xres = xres;

      // --- 7. RMSNorm 2 ---
      const r2 = new Float64Array(T);
      const xn2 = new Float64Array(T * D);
      for (let t = 0; t < T; t++) {
        let ss = 0;
        for (let d = 0; d < D; d++) ss += xres[t * D + d] * xres[t * D + d];
        const r = 1 / Math.sqrt(ss / D + EPS);
        r2[t] = r;
        for (let d = 0; d < D; d++) xn2[t * D + d] = xres[t * D + d] * r * P.g2[d];
      }
      LC.r2 = r2; LC.xn2 = xn2;

      // --- 8. MLP: 升维 → GELU → 降维 ---
      const hpre = new Float64Array(T * FF);
      for (let t = 0; t < T; t++)
        for (let j = 0; j < FF; j++) {
          let acc = P.b1[j];
          const wo = j * D;
          for (let d = 0; d < D; d++) acc += xn2[t * D + d] * P.W1[wo + d];
          hpre[t * FF + j] = acc;
        }
      const hact = new Float64Array(T * FF);
      for (let i = 0; i < T * FF; i++) hact[i] = gelu(hpre[i]);
      LC.hpre = hpre; LC.hact = hact;

      const mlo = new Float64Array(T * D);
      for (let t = 0; t < T; t++)
        for (let d = 0; d < D; d++) {
          let acc = P.b2[d];
          const wo = d * FF;
          for (let j = 0; j < FF; j++) acc += hact[t * FF + j] * P.W2[wo + j];
          mlo[t * D + d] = acc;
        }
      LC.mlo = mlo;

      // --- 9. 残差连接 2 → 本层输出 ---
      const xout = new Float64Array(T * D);
      for (let i = 0; i < T * D; i++) xout[i] = xres[i] + mlo[i];
      LC.xout = xout;

      cache.layers.push(LC);
      x = xout;
      // 测试钩子：允许外部覆盖某层输出，用于数值微分校验层间梯度
      if (inject && inject[l]) x = inject[l];
    }

    // --- 10. 最终 RMSNorm ---
    const rF = new Float64Array(T);
    const xF = new Float64Array(T * D);
    for (let t = 0; t < T; t++) {
      let ss = 0;
      for (let d = 0; d < D; d++) ss += x[t * D + d] * x[t * D + d];
      const r = 1 / Math.sqrt(ss / D + EPS);
      rF[t] = r;
      for (let d = 0; d < D; d++) xF[t * D + d] = x[t * D + d] * r * m.gF[d];
    }
    cache.rF = rF; cache.xF = xF; cache.xLast = x;

    // --- 11. LM Head → logits ---
    const logits = new Float64Array(T * V);
    for (let t = 0; t < T; t++)
      for (let v = 0; v < V; v++) {
        let acc = m.blm[v];
        const wo = v * D;
        for (let d = 0; d < D; d++) acc += xF[t * D + d] * m.Wlm[wo + d];
        logits[t * V + v] = acc;
      }
    cache.logits = logits;
    return cache;
  }

  // ============================================================ 反向传播
  function zeroGradInto(g) {
    for (const k in g) {
      const val = g[k];
      if (typeof val.fill === 'function') val.fill(0);
      else for (const kk in val) val[kk].fill(0);
    }
  }

  function bwdModel(m, cache, dlogits) {
    const { D, NH, dh, FF, NL, EPS } = m.cfg;
    const T = cache.T, g = m.grads;
    if (!m._accumulate) zeroGradInto(g);

    // ---- LM Head ----
    const dxF = new Float64Array(T * D);
    for (let t = 0; t < T; t++)
      for (let v = 0; v < V; v++) {
        const dl = dlogits[t * V + v];
        if (dl === 0) continue;
        g.blm[v] += dl;
        const wo = v * D;
        for (let d = 0; d < D; d++) {
          g.Wlm[wo + d] += dl * cache.xF[t * D + d];
          dxF[t * D + d] += dl * m.Wlm[wo + d];
        }
      }

    // ---- Final RMSNorm backward ----
    let dx = new Float64Array(T * D);
    {
      const rF = cache.rF, xL = cache.xLast;
      for (let t = 0; t < T; t++) {
        let s = 0;
        for (let d = 0; d < D; d++) s += dxF[t * D + d] * m.gF[d] * xL[t * D + d];
        const r = rF[t], r3 = r * r * r;
        for (let d = 0; d < D; d++) {
          g.gF[d] += dxF[t * D + d] * xL[t * D + d] * rF[t];
          dx[t * D + d] = rF[t] * dxF[t * D + d] * m.gF[d] - r3 * xL[t * D + d] * s / D;
        }
      }
    }

    // ---- 逐层反传 ----
    for (let l = NL - 1; l >= 0; l--) {
      const P = m.blocks[l], GG = g['b' + l], LC = cache.layers[l];
      const dxout = dx;

      // 残差2 → mlo
      const dmlo = dxout;
      // W2 backward
      for (let t = 0; t < T; t++)
        for (let d = 0; d < D; d++) {
          const dl = dmlo[t * D + d];
          if (dl === 0) continue;
          GG.b2[d] += dl;
          const wo = d * FF;
          for (let j = 0; j < FF; j++) {
            GG.W2[wo + j] += dl * LC.hact[t * FF + j];
            // hact grad accumulates into dh
          }
        }
      const dhact = new Float64Array(T * FF);
      for (let t = 0; t < T; t++)
        for (let d = 0; d < D; d++) {
          const dl = dmlo[t * D + d];
          if (dl === 0) continue;
          const wo = d * FF;
          for (let j = 0; j < FF; j++) dhact[t * FF + j] += dl * P.W2[wo + j];
        }
      const dhpre = new Float64Array(T * FF);
      for (let i = 0; i < T * FF; i++) dhpre[i] = dhact[i] * dgelu(LC.hpre[i]);

      // W1 backward → dxn2
      const dxn2 = new Float64Array(T * D);
      for (let t = 0; t < T; t++)
        for (let j = 0; j < FF; j++) {
          const dl = dhpre[t * FF + j];
          if (dl === 0) continue;
          GG.b1[j] += dl;
          const wo = j * D;
          for (let d = 0; d < D; d++) {
            GG.W1[wo + d] += dl * LC.xn2[t * D + d];
            dxn2[t * D + d] += dl * P.W1[wo + d];
          }
        }

      // RMSNorm2 backward → dxres (+ residual 直通)
      // 先记下"干净的"残差直通量：xres = xin + aout，
      // 所以 xin 经残差收到的梯度等于 dL/dxres（尚未叠加 RMSNorm2 的贡献）。
      const dxresPass = new Float64Array(T * D);
      for (let t = 0; t < T; t++) dxresPass.set(dxout.subarray(t * D, t * D + D), t * D);
      const dxres = new Float64Array(T * D);
      for (let t = 0; t < T; t++) dxres.set(dxout.subarray(t * D, t * D + D), t * D);
      {
        const r2 = LC.r2, xr = LC.xres;
        for (let t = 0; t < T; t++) {
          let s = 0;
          for (let d = 0; d < D; d++) s += dxn2[t * D + d] * P.g2[d] * xr[t * D + d];
          const r = r2[t], r3 = r * r * r;
          for (let d = 0; d < D; d++) {
            GG.g2[d] += dxn2[t * D + d] * xr[t * D + d] * r2[t];
            dxres[t * D + d] += r2[t] * dxn2[t * D + d] * P.g2[d] - r3 * xr[t * D + d] * s / D;
          }
        }
      }

      // Out proj backward → dcat
      const dcat = new Float64Array(T * D);
      for (let t = 0; t < T; t++)
        for (let d = 0; d < D; d++) {
          const dl = dxres[t * D + d];
          if (dl === 0) continue;
          GG.bo[d] += dl;
          const wo = d * D;
          for (let j = 0; j < D; j++) {
            GG.Wo[wo + j] += dl * LC.cat[t * D + j];
            dcat[t * D + j] += dl * P.Wo[wo + j];
          }
        }

      // 注意力 backward
      const dq = new Float64Array(T * D), dk = new Float64Array(T * D), dv = new Float64Array(T * D);
      const scale = 1 / Math.sqrt(dh);
      for (let h = 0; h < NH; h++) {
        const off = h * dh, sBase = h * T * T;
        // 多头拼接的转置：dcat[t*D + h*dh + j] 即该头的 dhead[t*dh + j]
        const dhead = new Float64Array(T * dh);
        for (let t = 0; t < T; t++)
          for (let j = 0; j < dh; j++)
            dhead[t * dh + j] = dcat[t * D + off + j];
        // dhead[t][j] = sum_s p * dv[s][j]
        // dv[s][j] += sum_t p * dhead[t][j]
        for (let s = 0; s < T; s++)
          for (let t = s; t < T; t++)
            for (let j = 0; j < dh; j++)
              dv[s * D + off + j] += LC.probs[sBase + t * T + s] * dhead[t * dh + j];
        // softmax backward
        for (let t = 0; t < T; t++) {
          let dot = 0;
          for (let s = 0; s <= t; s++) {
            let a = 0;
            for (let j = 0; j < dh; j++) a += dhead[t * dh + j] * LC.v[s * D + off + j];
            dot += LC.probs[sBase + t * T + s] * a;
          }
          for (let s = 0; s <= t; s++) {
            let a = 0;
            for (let j = 0; j < dh; j++) a += dhead[t * dh + j] * LC.v[s * D + off + j];
            const ds = LC.probs[sBase + t * T + s] * (a - dot) * scale;
            if (ds === 0) continue;
            for (let j = 0; j < dh; j++) {
              dq[t * D + off + j] += ds * LC.kr[s * D + off + j];
              dk[s * D + off + j] += ds * LC.qr[t * D + off + j];
            }
          }
        }
      }

      // RoPE backward（逆旋转）
      const dqn = new Float64Array(T * D), dkn = new Float64Array(T * D);
      for (let h = 0; h < NH; h++) {
        const off = h * dh;
        for (let t = 0; t < T; t++)
          for (let j = 0; j < dh / 2; j++) {
            const ang = t * ROPE_INV[j];
            const c = Math.cos(ang), s = Math.sin(ang);
            const a = dq[t * D + off + 2 * j], b = dq[t * D + off + 2 * j + 1];
            dqn[t * D + off + 2 * j] = a * c + b * s;
            dqn[t * D + off + 2 * j + 1] = -a * s + b * c;
            const a2 = dk[t * D + off + 2 * j], b2 = dk[t * D + off + 2 * j + 1];
            dkn[t * D + off + 2 * j] = a2 * c + b2 * s;
            dkn[t * D + off + 2 * j + 1] = -a2 * s + b2 * c;
          }
      }

      // QKV proj backward → dxn1（单遍同时累加三路）
      const dxn1 = new Float64Array(T * D);
      for (let t = 0; t < T; t++)
        for (let d = 0; d < D; d++) {
          const aq = dqn[t * D + d], ak = dkn[t * D + d], av = dv[t * D + d];
          const wo = d * D;
          for (let j = 0; j < D; j++) {
            const xv = LC.xn1[t * D + j];
            if (aq !== 0) GG.Wq[wo + j] += aq * xv;
            if (ak !== 0) GG.Wk[wo + j] += ak * xv;
            if (av !== 0) GG.Wv[wo + j] += av * xv;
          }
          if (aq !== 0) GG.bq[d] += aq;
          if (ak !== 0) GG.bk[d] += ak;
          if (av !== 0) GG.bv[d] += av;
          let a = 0;
          for (let j = 0; j < D; j++) {
            a += dqn[t * D + j] * P.Wq[wo + j];
            a += dkn[t * D + j] * P.Wk[wo + j];
            a += dv[t * D + j] * P.Wv[wo + j];
          }
          dxn1[t * D + d] = a;
        }

      // RMSNorm1 backward → dxin (+ residual1 直通)
      // xres = xin + aout：xin 经残差直通收到 dxresPass，
      // 而叠加了 RMSNorm2 梯度的 dxres 用于算aout/注意力路径。
      const dxin = new Float64Array(T * D);
      for (let t = 0; t < T; t++) dxin.set(dxresPass.subarray(t * D, t * D + D), t * D);
      {
        const r1 = LC.r1, xin = LC.xin;
        for (let t = 0; t < T; t++) {
          let s = 0;
          for (let d = 0; d < D; d++) s += dxn1[t * D + d] * P.g1[d] * xin[t * D + d];
          const r = r1[t], r3 = r * r * r;
          for (let d = 0; d < D; d++) {
            GG.g1[d] += dxn1[t * D + d] * xin[t * D + d] * r1[t];
            dxin[t * D + d] += r1[t] * dxn1[t * D + d] * P.g1[d] - r3 * xin[t * D + d] * s / D;
          }
        }
      }
      dx = dxin;
    }

    // ---- Embedding backward ----
    for (let t = 0; t < T; t++) {
      const off = (ids2(cache)[t]) * D;
      for (let d = 0; d < D; d++) g.Wte[off + d] += dx[t * D + d];
    }
  }
  function ids2(cache) { return cache.ids; }

  // ============================================================ 训练
  function crossEntropy(m, cache) {
    const T = cache.T, L = cache.logits;
    const p = new Float64Array(T * V);
    let loss = 0;
    for (let t = 0; t < T - 1; t++) {
      softmax(L, t * V, t * V + V, 1); // 原地 softmax（仅训练用）
      for (let v = 0; v < V; v++) p[t * V + v] = L[t * V + v];
      const tgt = cache.ids[t + 1];
      loss += -Math.log(Math.max(p[t * V + tgt], 1e-12));
    }
    return { loss: loss / Math.max(1, T - 1), probs: p };
  }

  /* 单步训练：可视化训练模式直接驱动它，所有返回值都是真实计算量。
 * Adam 状态持久化在 model._adam，因此可以逐帧调用而不丢动量。
 * 返回 { loss, gnorm, clipScale, lr, ids, target, predProb, step } */
  function trainStep(model, o) {
    const opt = Object.assign({ batch: 4, lr: 3e-3, seed: 7, clip: 0.5, ctx: CFG.CTX, warmup: 20 }, o || {});
    if (!model._adam) {
      model._adam = { mom: zeroGrad(model.params), vAcc: zeroGrad(model.params), t: 0, rnd: mulberry32(opt.seed >>> 0), stream: makeStream(opt.seed + 1000, 20000) };
    }
    const A = model._adam;
    const g = model.grads;
    const beta1 = 0.9, beta2 = 0.999, epsA = 1e-8;

    // ---- 1. 采样训练窗口 ----
    const s = Math.floor(A.rnd() * (A.stream.length - opt.ctx - 1));
    const ids = A.stream.slice(s, s + opt.ctx);

    // ---- 2. 前向 + 交叉熵 ----
    zeroGradInto(g);
    const cache = forward(model, ids);
    const ce = crossEntropy(model, cache);

    // ---- 3. 反向传播 ----
    const T = cache.T;
    const dl = new Float64Array(T * V);
    for (let t = 0; t < T - 1; t++)
      for (let v = 0; v < V; v++)
        dl[t * V + v] = (ce.probs[t * V + v] - (cache.ids[t + 1] === v ? 1 : 0)) / (T - 1);
    bwdModel(model, cache, dl);

    // ---- 4. 统计全局梯度范数 + 梯度裁剪 ----
    let gnorm2 = 0;
    const cnt = (arr) => { for (let j = 0; j < arr.length; j++) gnorm2 += arr[j] * arr[j]; };
    for (const k in g) {
      const gv = g[k];
      if (typeof gv.fill === 'function') cnt(gv);
      else for (const kk in gv) cnt(gv[kk]);
    }
    const gnorm = Math.sqrt(gnorm2);
    const clipScale = gnorm > opt.clip ? opt.clip / (gnorm + 1e-12) : 1;

    // ---- 5. AdamW 更新 ----
    A.t++;
    const lr = opt.lr * Math.min(1, A.t / opt.warmup);
    const apply = (arrP, arrG, momA, vA) => {
      for (let j = 0; j < arrP.length; j++) {
        const gi = arrG[j] * clipScale;
        if (!isFinite(gi)) continue;
        momA[j] = beta1 * momA[j] + (1 - beta1) * gi;
        vA[j] = beta2 * vA[j] + (1 - beta2) * gi * gi;
        const mh = momA[j] / (1 - Math.pow(beta1, A.t));
        const vh = vA[j] / (1 - Math.pow(beta2, A.t));
        arrP[j] -= lr * (mh / (Math.sqrt(vh) + epsA) + 1e-4 * arrP[j]);
      }
    };
    for (const k in model.params) {
      const pk = model.params[k];
      if (typeof pk.fill === 'function') apply(pk, g[k], A.mom[k], A.vAcc[k]);
      else for (const kk in pk) apply(pk[kk], g[k][kk], A.mom[k][kk], A.vAcc[k][kk]);
    }

    // 预测最后一个位置的真实概率（用于展示"模型有多确信"）
    let predProb = 0;
    {
      const t = T - 2;
      if (t >= 0) predProb = ce.probs[t * V + cache.ids[t + 1]] || 0;
    }
    return {
      loss: ce.loss, gnorm, clipScale, lr, step: A.t,
      ids: ids.slice(), predProb, cache,
    };
  }

  // 统计各参数块的梯度范数（可视化"梯度往哪流"）
  function gradNormPerBlock(model) {
    const out = [];
    const g = model.grads;
    const nrm = (arr) => { let s = 0; for (let j = 0; j < arr.length; j++) s += arr[j] * arr[j]; return Math.sqrt(s); };
    if (g.Wte) out.unshift({ name: 'Embedding', v: nrm(g.Wte) });
    for (let i = model.blocks.length - 1; i >= 0; i--) {
      const b = g['b' + i];
      if (!b) continue;
      out.unshift({
        name: `L${i + 1}`,
        v: Math.sqrt(nrm(b.Wq) ** 2 + nrm(b.Wk) ** 2 + nrm(b.Wv) ** 2 + nrm(b.Wo) ** 2),
        mlp: Math.sqrt(nrm(b.W1) ** 2 + nrm(b.W2) ** 2),
      });
    }
    if (g.Wlm) out.push({ name: 'LM Head', v: nrm(g.Wlm) });
    return out;
  }

  function train(model, opts) {
    const o = Object.assign({ steps: 400, batch: 8, lr: 3e-3, seed: 7, ctx: CFG.CTX, log: null }, opts || {});
    const rnd = mulberry32(o.seed);
    const stream = makeStream(o.seed + 1000, o.steps * o.batch * (o.ctx + 1) + 64);
    const g = model.grads;
    const mom = zeroGrad(model.params);   // Adam 一阶矩
    const vAcc = zeroGrad(model.params);  // Adam 二阶矩
    const beta1 = 0.9, beta2 = 0.999, epsA = 1e-8;
    const lossHist = [];

    for (let step = 0; step < o.steps; step++) {
      zeroGradInto(g);
      let totLoss = 0;
      const lr = o.lr * Math.min(1, (step + 1) / 20);

      // bwdModel 内部会 zeroGradInto(g)，所以这里先清零，
      // 再让每个 batch 样本"累加"梯度（而不是互相覆盖）。
      model._accumulate = true;
      for (let b = 0; b < o.batch; b++) {
        const s = Math.floor(rnd() * (stream.length - o.ctx - 1));
        const ids = stream.slice(s, s + o.ctx);
        const cache = forward(model, ids);
        const ce = crossEntropy(model, cache);
        totLoss += ce.loss;
        const dl = new Float64Array(cache.T * V);
        for (let t = 0; t < cache.T - 1; t++)
          for (let v = 0; v < V; v++)
            dl[t * V + v] = (ce.probs[t * V + v] - (cache.ids[t + 1] === v ? 1 : 0)) / (cache.T - 1) / o.batch;
        bwdModel(model, cache, dl);
      }
      model._accumulate = false;

      // 梯度裁剪：抑制 RMSNorm 放大后的梯度尖峰
      let gnorm2 = 0, gn = 0;
      const countG = (arr) => { for (let j = 0; j < arr.length; j++) { gnorm2 += arr[j] * arr[j]; gn++; } };
      for (const k in g) {
        const gv = g[k];
        if (typeof gv.fill === 'function') countG(gv);
        else for (const kk in gv) countG(gv[kk]);
      }
      const gnorm = Math.sqrt(gnorm2);
      const clip = o.clip || 1.0;
      const scale = gnorm > clip ? clip / (gnorm + 1e-6) : 1;

      // AdamW（逐张量独立索引）
      const apply = (arrP, arrG, momA, vA) => {
        for (let j = 0; j < arrP.length; j++) {
          const gi = arrG[j] * scale;
          if (!isFinite(gi)) continue;
          momA[j] = beta1 * momA[j] + (1 - beta1) * gi;
          vA[j] = beta2 * vA[j] + (1 - beta2) * gi * gi;
          const mh = momA[j] / (1 - Math.pow(beta1, step + 1));
          const vh = vA[j] / (1 - Math.pow(beta2, step + 1));
          arrP[j] -= lr * (mh / (Math.sqrt(vh) + epsA) + 1e-4 * arrP[j]);
        }
      };
      for (const k in model.params) {
        const pk = model.params[k];
        if (typeof pk.fill === 'function') apply(pk, g[k], mom[k], vAcc[k]);
        else for (const kk in pk) apply(pk[kk], g[k][kk], mom[k][kk], vAcc[k][kk]);
      }

      const L = totLoss / o.batch;
      lossHist.push(L);
      if (o.log && step % 20 === 0) o.log(L, step);
    }
    return lossHist;
  }

  // ============================================================ 采样
  /* 带完整"可观测中间态"的采样：温度 → softmax → top-p 累积 → 抽样。
   * 返回的 trace 就是 3D 里那一段动画的脚本。 */
  function sample(model, cache, lastIdx, opts) {
    const o = Object.assign({ temp: 0.85, topP: 0.92, topK: 8, seed: 1 }, opts || {});
    const rnd = mulberry32(o.seed >>> 0);
    const D = V, T = cache.T;
    const base = cache.logits.slice((lastIdx) * D, (lastIdx + 1) * D); // [V]

    const scaled = new Float64Array(D);
    let mx = -Infinity;
    for (let v = 0; v < D; v++) { scaled[v] = base[v] / o.temp; if (scaled[v] > mx) mx = scaled[v]; }
    const exp = new Float64Array(D);
    let z = 0;
    for (let v = 0; v < D; v++) { exp[v] = Math.exp(scaled[v] - mx); z += exp[v]; }
    const probs = new Float64Array(D);
    for (let v = 0; v < D; v++) probs[v] = exp[v] / z;

    // 按概率排序
    const order = Array.from({ length: D }, (_, v) => v).sort((a, b) => probs[b] - probs[a]);

    // top-k 截断
    const k = Math.min(o.topK, D);
    let mass = 0;
    for (let i = 0; i < k; i++) mass += probs[order[i]];
    const renorm = new Float64Array(k);
    for (let i = 0; i < k; i++) renorm[i] = probs[order[i]] / mass;

    // top-p 累积
    const kept = [];
    let cum = 0;
    for (let i = 0; i < k; i++) {
      kept.push({ id: order[i], p: renorm[i], cum: cum + renorm[i] });
      cum += renorm[i];
      if (cum >= o.topP && i > 0) break;
    }
    const keptMass = kept[kept.length - 1].cum;
    for (const it of kept) it.p = it.p / keptMass;

    const u = rnd();
    let pick = kept[kept.length - 1].id, acc = 0;
    for (const it of kept) { acc += it.p; if (u <= acc) { pick = it.id; break; } }

    return { logits: base, probs, order, kept, u, pick, topP: o.topP, topK: o.topK, temp: o.temp };
  }

  const API = {
    CFG, VOCAB, detok, tok, mulberry32, gauss, makeStream,
    initModel, forward, bwdModel, train, trainStep, gradNormPerBlock,
    sample, collectParams, zeroGradInto,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.TinyLM = API;

})(typeof window !== 'undefined' ? window : globalThis);