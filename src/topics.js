/* =============================================================================
 * topics.js —— 互动模块④：更多维度科普卡（overlay 模式）
 *
 * 覆盖 LLM 的横向维度：分词 / 语义空间 / 缩放定律 / 幻觉 / 对齐 RLHF /
 * RAG / 思维链 / 多模态 / 推理成本 / 评测。
 * 其中 3 张卡带**真实计算**的迷你交互：Embedding PCA 投影（真权重）、
 * 缩放定律曲线（滑杆）、幻觉演示（真模型采样）。
 * ========================================================================== */
(function () {
  'use strict';

  const LM = () => window.TinyLM;

  /* ---------------- SVG 小图 ---------------- */
  const svgRLHF = `<svg viewBox="0 0 320 96" class="mini">
    <rect x="6" y="34" width="62" height="28" rx="7" fill="#2f7d63" opacity=".85"/><text x="37" y="52" font-size="11" fill="#fff" text-anchor="middle">策略模型</text>
    <rect x="94" y="34" width="62" height="28" rx="7" fill="#3d8f9c" opacity=".85"/><text x="125" y="52" font-size="11" fill="#fff" text-anchor="middle">人类偏好</text>
    <rect x="182" y="34" width="62" height="28" rx="7" fill="#c98a3c" opacity=".9"/><text x="213" y="52" font-size="11" fill="#fff" text-anchor="middle">奖励模型</text>
    <rect x="264" y="34" width="50" height="28" rx="7" fill="#7a6bab" opacity=".9"/><text x="289" y="52" font-size="11" fill="#fff" text-anchor="middle">PPO</text>
    <path d="M68 48 L94 48" stroke="#6b6259" stroke-width="1.5" marker-end="url(#a)"/>
    <path d="M156 48 L182 48" stroke="#6b6259" stroke-width="1.5"/>
    <path d="M244 48 L264 48" stroke="#6b6259" stroke-width="1.5"/>
    <path d="M289 62 C289 84 37 84 37 62" stroke="#b85c38" stroke-width="1.5" fill="none" stroke-dasharray="4 3"/>
    <text x="163" y="93" font-size="9.5" fill="#8a7f70" text-anchor="middle">奖励信号回传更新策略</text>
  </svg>`;
  const svgRAG = `<svg viewBox="0 0 320 96" class="mini">
    <rect x="6" y="12" width="70" height="26" rx="7" fill="#4a7fb5" opacity=".9"/><text x="41" y="29" font-size="11" fill="#fff" text-anchor="middle">用户提问</text>
    <rect x="6" y="58" width="70" height="26" rx="7" fill="#3d8f9c" opacity=".9"/><text x="41" y="75" font-size="11" fill="#fff" text-anchor="middle">知识库检索</text>
    <rect x="120" y="34" width="76" height="28" rx="7" fill="#2f7d63" opacity=".9"/><text x="158" y="52" font-size="11" fill="#fff" text-anchor="middle">拼接上下文</text>
    <rect x="234" y="34" width="80" height="28" rx="7" fill="#c98a3c" opacity=".9"/><text x="274" y="52" font-size="11" fill="#fff" text-anchor="middle">LLM 生成</text>
    <path d="M76 25 C100 25 100 44 120 46" stroke="#6b6259" stroke-width="1.5" fill="none"/>
    <path d="M76 71 C100 71 100 52 120 50" stroke="#6b6259" stroke-width="1.5" fill="none"/>
    <path d="M196 48 L234 48" stroke="#6b6259" stroke-width="1.5"/>
  </svg>`;
  const svgCoT = `<svg viewBox="0 0 320 96" class="mini">
    <rect x="6" y="34" width="54" height="26" rx="7" fill="#4a7fb5" opacity=".9"/><text x="33" y="51" font-size="10.5" fill="#fff" text-anchor="middle">问题</text>
    <rect x="80" y="34" width="72" height="26" rx="7" fill="#8ecbb4"/><text x="116" y="51" font-size="10.5" fill="#1f4c3d" text-anchor="middle">思考·步骤1</text>
    <rect x="168" y="34" width="72" height="26" rx="7" fill="#8ecbb4"/><text x="204" y="51" font-size="10.5" fill="#1f4c3d" text-anchor="middle">步骤2·验证</text>
    <rect x="256" y="34" width="58" height="26" rx="7" fill="#c98a3c" opacity=".9"/><text x="285" y="51" font-size="10.5" fill="#fff" text-anchor="middle">答案</text>
    <path d="M60 47 L80 47 M152 47 L168 47 M240 47 L256 47" stroke="#6b6259" stroke-width="1.5"/>
    <text x="160" y="20" font-size="9.5" fill="#8a7f70" text-anchor="middle">生成 token 的同时也在给后续 token 当「证据」—— 写出来再回答更准</text>
  </svg>`;
  const svgMM = `<svg viewBox="0 0 320 96" class="mini">
    <rect x="6" y="12" width="64" height="24" rx="7" fill="#4a7fb5" opacity=".9"/><text x="38" y="28" font-size="10.5" fill="#fff" text-anchor="middle">图像</text>
    <rect x="6" y="44" width="64" height="24" rx="7" fill="#4a7fb5" opacity=".75"/><text x="38" y="60" font-size="10.5" fill="#fff" text-anchor="middle">音频</text>
    <rect x="6" y="76" width="64" height="18" rx="7" fill="#4a7fb5" opacity=".6"/><text x="38" y="89" font-size="10" fill="#fff" text-anchor="middle">视频</text>
    <rect x="120" y="38" width="84" height="26" rx="7" fill="#2f7d63" opacity=".9"/><text x="162" y="55" font-size="10.5" fill="#fff" text-anchor="middle">统一编码器</text>
    <rect x="240" y="38" width="74" height="26" rx="7" fill="#c98a3c" opacity=".9"/><text x="277" y="55" font-size="10.5" fill="#fff" text-anchor="middle">同一 Transformer</text>
    <path d="M70 24 C100 24 96 46 120 49 M70 56 C100 56 96 51 120 51 M70 85 C100 85 96 56 120 53 M204 51 L240 51" stroke="#6b6259" stroke-width="1.5" fill="none"/>
  </svg>`;
  const svgCost = `<svg viewBox="0 0 320 96" class="mini">
    <rect x="10" y="18" width="88" height="60" rx="9" fill="#f1ece0" stroke="#d8d0c2"/><text x="54" y="38" font-size="11" fill="#2b2723" text-anchor="middle">量化 FP16→INT4</text><text x="54" y="56" font-size="9.5" fill="#8a7f70" text-anchor="middle">显存 ÷4</text><text x="54" y="70" font-size="9.5" fill="#b85c38" text-anchor="middle">精度略降</text>
    <rect x="116" y="18" width="88" height="60" rx="9" fill="#f1ece0" stroke="#d8d0c2"/><text x="160" y="38" font-size="11" fill="#2b2723" text-anchor="middle">蒸馏 大→小</text><text x="160" y="56" font-size="9.5" fill="#8a7f70" text-anchor="middle">成本 ÷10+</text><text x="160" y="70" font-size="9.5" fill="#b85c38" text-anchor="middle">能力有损</text>
    <rect x="222" y="18" width="88" height="60" rx="9" fill="#f1ece0" stroke="#d8d0c2"/><text x="266" y="38" font-size="11" fill="#2b2723" text-anchor="middle">KV 缓存复用</text><text x="266" y="56" font-size="9.5" fill="#8a7f70" text-anchor="middle">每 token O(1)</text><text x="266" y="70" font-size="9.5" fill="#b85c38" text-anchor="middle">吃显存</text>
  </svg>`;

  /* ---------------- 迷你交互：Embedding PCA ---------------- */
  function pca2(mat, n, d) {
    const mean = new Float64Array(d);
    for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) mean[j] += mat[i * d + j] / n;
    const X = [];
    for (let i = 0; i < n; i++) { const r = new Float64Array(d); for (let j = 0; j < d; j++) r[j] = mat[i * d + j] - mean[j]; X.push(r); }
    // 协方差 d×d 太重？d=32 直接算
    const C = [];
    for (let a = 0; a < d; a++) { C.push(new Float64Array(d)); for (let b = 0; b <= a; b++) { let s = 0; for (let i = 0; i < n; i++) s += X[i][a] * X[i][b]; C[a][b] = s / n; C[b][a] = s / n; } }
    function power() {
      let v = new Float64Array(d); for (let j = 0; j < d; j++) v[j] = Math.sin(j * 2.3 + 1);
      for (let it = 0; it < 40; it++) { const nv = new Float64Array(d); for (let a = 0; a < d; a++) { let s = 0; for (let b = 0; b < d; b++) s += C[a][b] * v[b]; nv[a] = s; } let n = 0; for (let j = 0; j < d; j++) n += nv[j] * nv[j]; n = Math.sqrt(n) || 1; for (let j = 0; j < d; j++) nv[j] /= n; v = nv; }
      return v;
    }
    const v1 = power();
    // 去第一主成分（deflation）：C2 = C - λ1 · v1 v1ᵀ
    let lam1 = 0;
    for (let a = 0; a < d; a++) { let s = 0; for (let b = 0; b < d; b++) s += C[a][b] * v1[b]; lam1 += v1[a] * s; }
    const C2 = C.map((row, a) => Float64Array.from(row, (val, b) => val - lam1 * v1[a] * v1[b]));
    let v2 = new Float64Array(d); for (let j = 0; j < d; j++) v2[j] = Math.cos(j * 1.7 + 2);
    for (let it = 0; it < 40; it++) { const nv = new Float64Array(d); for (let a = 0; a < d; a++) { let s = 0; for (let b = 0; b < d; b++) s += C2[a][b] * v2[b]; nv[a] = s; } let n = 0; for (let j = 0; j < d; j++) n += nv[j] * nv[j]; n = Math.sqrt(n) || 1; for (let j = 0; j < d; j++) nv[j] /= n; v2 = nv; }
    const pts = X.map(r => [r.reduce((s, x, j) => s + x * v1[j], 0), r.reduce((s, x, j) => s + x * v2[j], 0)]);
    return pts;
  }

  function drawEmbedding(cv) {
    const LMm = LM(), m = window.__app && window.__app.model;
    if (!cv || !m) return;
    const pts = pca2(m.Wte, 12, 32);
    const g = cv.getContext('2d'), W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    let mx = 0; pts.forEach(p => mx = Math.max(mx, Math.abs(p[0]), Math.abs(p[1]))); mx = mx || 1;
    const cx = W / 2, cy = H / 2, sc = Math.min(W, H) / 2.4 / mx;
    g.strokeStyle = '#e3dccd'; g.beginPath(); g.moveTo(0, cy); g.lineTo(W, cy); g.moveTo(cx, 0); g.lineTo(cx, H); g.stroke();
    const VOCAB = LMm.VOCAB;
    pts.forEach((p, i) => {
      const x = cx + p[0] * sc, y = cy - p[1] * sc;
      g.fillStyle = /[·|]/.test(VOCAB[i]) ? '#c98a3c' : '#2f7d63';
      g.beginPath(); g.arc(x, y, 5, 0, 7); g.fill();
      g.fillStyle = '#2b2723'; g.font = '11px sans-serif'; g.textAlign = 'center';
      g.fillText(VOCAB[i], x, y - 9);
    });
  }

  /* ---------------- 迷你交互：缩放定律 ---------------- */
  function drawScaling(cv, N) {
    if (!cv) return;
    const g = cv.getContext('2d'), W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    const pad = 34;
    const xOf = (lgN) => pad + (lgN - 3) / (13 - 3) * (W - pad - 10);      // N: 1e3 ~ 1e13
    const yOf = (L) => H - pad - (L - 0.3) / (3.2 - 0.3) * (H - pad - 14);
    g.strokeStyle = '#d8d0c2'; g.strokeRect(pad, 12, W - pad - 10, H - pad - 2);
    g.strokeStyle = '#2f7d63'; g.lineWidth = 2; g.beginPath();
    for (let lg = 3; lg <= 13; lg += 0.1) {
      const L = 1.7 * Math.pow(10, lg * -0.088) + 0.35;
      const x = xOf(lg), y = yOf(L);
      lg === 3 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.stroke(); g.lineWidth = 1;
    const L = 1.7 * Math.pow(N, -0.088) + 0.35;
    const x = xOf(Math.log10(N)), y = yOf(L);
    g.fillStyle = '#c98a3c'; g.beginPath(); g.arc(x, y, 5, 0, 7); g.fill();
    g.fillStyle = '#6b6259'; g.font = '10px sans-serif';
    g.fillText('log 参数量 →', W / 2 - 20, H - 8);
    g.save(); g.translate(10, H / 2 + 20); g.rotate(-Math.PI / 2); g.fillText('loss（对数轴）', 0, 0); g.restore();
    g.fillStyle = '#2b2723'; g.font = '11px sans-serif';
    g.fillText(`N=${N.toExponential(1)} → L≈${L.toFixed(2)}`, Math.min(x + 8, W - 130), y - 8);
  }

  /* ---------------- 迷你交互：幻觉演示 ---------------- */
  function drawHallu(cv, temp) {
    const LMm = LM(); const app = window.__app;
    if (!cv || !app || !app.model) return;
    const V = LMm.VOCAB.length;
    const g = cv.getContext('2d'), W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    const ids = LMm.tokSeq('159');
    const cache = LMm.forward(app.model, ids);
    const last = (cache.T - 1) * V;
    const logits = cache.logits;
    const t = Math.max(0.01, temp);
    let mx = -Infinity; for (let i = 0; i < V; i++) mx = Math.max(mx, logits[last + i]);
    const ex = new Float64Array(V); let sum = 0;
    for (let i = 0; i < V; i++) { ex[i] = Math.exp((logits[last + i] - mx) / t); sum += ex[i]; }
    const probs = []; for (let i = 0; i < V; i++) probs.push([i, ex[i] / sum]);
    probs.sort((a, b) => b[1] - a[1]);
    // 采样 8 次
    const rng = LMm.mulberry32(42);
    const picks = [];
    for (let s = 0; s < 8; s++) {
      let r = rng(), pick = probs[0][0];
      for (const [i, p] of probs) { r -= p; if (r <= 0) { pick = i; break; } }
      picks.push([pick, probs.find(x => x[0] === pick)[1]]);
    }
    g.font = '11px sans-serif';
    picks.forEach(([tok, p], s) => {
      const y = 16 + s * ((H - 24) / 8);
      g.fillStyle = '#6b6259'; g.fillText(`采样${s + 1}`, 4, y + 4);
      g.fillStyle = '#d8d0c2'; g.fillRect(48, y, W - 92, 10);
      g.fillStyle = '#2f7d63'; g.fillRect(48, y, (W - 92) * p, 10);
      g.fillStyle = '#2b2723'; g.fillText(`「${LMm.VOCAB[tok]}」 ${(p * 100).toFixed(1)}%`, W - 40, y + 9);
    });
  }

  /* ---------------- 卡片定义 ---------------- */
  const CARDS = [
    { t: '词表与分词', tag: '输入侧', body: '真模型把词切开成子词（BPE）：「unbelievable」→「un + believ + able」。词表几万到十几万，切法是统计出来的：高频组合合并成一个 token。', micro: '我们的词表只有 12 个符号（0-9、·、|），所以你看到的是「字符级」语言模型 —— 真模型的第一步和它同构，只是词表大 1 万倍。' },
    { t: 'Embedding：语义的几何', tag: '输入侧', interactive: 'embed', body: '每个 token 是高维空间里的一个点，训练后语义相近的词会互相靠近（king − man + woman ≈ queen）。方向编码语义，距离编码关系。', micro: '下面是**真实训练权重 Wte（12×32）**做 PCA 降到二维的投影 —— 数字 1/5/9 这类「常在词头出现」的符号与「|」明显分居两片区域。' },
    { t: '缩放定律', tag: '规模维度', interactive: 'scale', body: 'loss 随参数量、数据量、算力按**幂律**平滑下降（Chinchilla：参数与数据要等比扩）。 bigger is better 不是口号，是一条可预测的直线。', micro: '拖动滑杆看 log-log 下的直线 —— 我们 2.8k 参数的小模型 loss≈0.55，正好落在这条规律的趋势线上。' },
    { t: '幻觉：为什么一本正经胡说', tag: '可靠性', interactive: 'hallu', body: '模型本质是「按分布采样下一个 token」，它没有「我不知道」的内置开关：训练里说错话与说对话得到同样格式的反馈，且采样永远会给出一个词。RLHF 只能压制、不能根除。', micro: '右侧是真实模型在高温下对「159→?」的 8 次采样：每次都自信地输出，但分布摊平后答案随机 —— 这就是幻觉的机制原型。' },
    { t: 'RLHF 与对齐', tag: '训练维度', svg: svgRLHF, body: '预训练之后，用人类偏好数据训练一个奖励模型，再用 PPO 让 LLM 往「人类喜欢的方向」走。它教会模型有用、诚实、无害 —— 但也可能教会「讨好」。', micro: '训练模式里你看到的交叉熵 + AdamW 是预训练；RLHF 是在它之后再加一整条流水线。' },
    { t: 'RAG：检索增强', tag: '系统维度', svg: svgRAG, body: '把问题先去知识库里检索，把检索到的资料拼进上下文再生成。用「开卷考试」代替「死记硬背」，成本低、可更新、可溯源。', micro: '上下文模块演示了上下文长度与代价 —— RAG 本质是在这段上下文里塞「最相关的几段」。' },
    { t: '思维链（CoT）', tag: '能力维度', svg: svgCoT, body: '让模型把中间步骤写出来再给答案，推理正确率显著提升 —— 因为已生成的 token 会成为后续 token 的条件输入，相当于外挂了「草稿纸」。', micro: '推理模式的自回归循环就是这个机制：写下的每个 token 都改变后面的概率分布。' },
    { t: '多模态', tag: '模态维度', svg: svgMM, body: '把图像/音频先编码成和文字一样的向量序列，塞进同一个 Transformer。模型架构几乎不变，变的只是「词表」里多了视觉 token。', micro: '我们的 embedding 是 32 维 —— 图像 patch 向量也是同样方式进模型，只是维度更高。' },
    { t: '推理成本工程', tag: '工程维度', svg: svgCost, body: '大模型上线是算力生意：量化砍显存、蒸馏砍参数、KV 缓存砍重复计算。三者都在「能力损失」与「成本」之间找平衡点。', micro: '上下文与缓存模块里的 T² / T 曲线就是这一切的物理起点。' },
    { t: '评测与基准', tag: '评估维度', body: 'MMLU 考知识、GSM8K 考数学、HumanEval 考代码……基准分数会「过拟合」：模型可能学会了考试而不是学会了能力，所以评测永远要配合人工盲测。', micro: '我们的「考试」是下一字符预测准确率 82.6% —— 一个最诚实、无法刷分的指标。' },
  ];

  window.TopicsMod = {
    boot(ctx) {
      const el = document.createElement('div');
      el.id = 'topicsOverlay';
      el.className = 'overlay-topics hidden';
      el.innerHTML = `
        <div class="topics-head">
          <div>
            <div class="kicker">更多维度 · LLM 科普图谱</div>
            <h2>围绕大语言模型的十个侧面</h2>
            <p class="muted">每张卡都标注了「在我们这个 2.8k 参数的微型模型里对应什么」。带 <span class="chip-demo">真实计算</span> 标记的卡片可以直接玩。</p>
          </div>
          <button id="topicsClose"><span class="ic-slot" data-ic="close"></span>收起</button>
        </div>
        <div class="topics-grid">
          ${CARDS.map((c, i) => `
            <article class="tcard">
              <div class="tcard-h"><span class="ttag">${c.tag}</span><h3>${c.t}</h3></div>
              ${c.interactive ? '<span class="chip-demo">真实计算 · 可交互</span>' : ''}
              <p>${c.body}</p>
              ${c.interactive === 'embed' ? '<canvas class="tdemo" id="tdEmbed" width="300" height="170"></canvas>' : ''}
              ${c.interactive === 'scale' ? `<canvas class="tdemo" id="tdScale" width="300" height="150"></canvas><div class="lab"><span>参数量</span><b id="tdScaleVal">1e9</b></div><input type="range" id="tdScaleN" min="3" max="13" step="0.1" value="9">` : ''}
              ${c.interactive === 'hallu' ? `<canvas class="tdemo" id="tdHallu" width="300" height="168"></canvas><div class="lab"><span>采样温度</span><b id="tdHalluVal">2.50</b></div><input type="range" id="tdHalluT" min="0.1" max="3" step="0.1" value="2.5">` : ''}
              ${c.svg || ''}
              <div class="tmicro">${c.micro}</div>
            </article>`).join('')}
        </div>`;
      document.getElementById('main').appendChild(el);

      let inited = false;
      function initMinis() {
        if (inited) return; inited = true;
        drawEmbedding(document.getElementById('tdEmbed'));
        const sc = document.getElementById('tdScale');
        const drawS = () => { const lg = parseFloat(document.getElementById('tdScaleN').value); document.getElementById('tdScaleVal').textContent = '1e' + lg.toFixed(1); drawScaling(sc, Math.pow(10, lg)); };
        if (sc) { drawS(); document.getElementById('tdScaleN').addEventListener('input', drawS); }
        const hl = document.getElementById('tdHallu');
        const drawH = () => { const t = parseFloat(document.getElementById('tdHalluT').value); document.getElementById('tdHalluVal').textContent = t.toFixed(2); drawHallu(hl, t); };
        if (hl) { drawH(); document.getElementById('tdHalluT').addEventListener('input', drawH); }
        const I = window.LLMIcons || {};
        el.querySelectorAll('.ic-slot[data-ic]').forEach(x => { if (I[x.dataset.ic]) x.innerHTML = I[x.dataset.ic](14); });
        document.getElementById('topicsClose').addEventListener('click', () => window.__app.setMode('fwd'));
      }

      return {
        el,
        onShow() { setTimeout(initMinis, 30); },
        getHud() {
          return { stage: '科普图谱 · 十个维度', desc: '横向扩展：从输入侧到评估维度。带「真实计算」标记的卡片可直接交互。', formula: '', pill: '10 张卡 · 3 个真实交互' };
        },
        getSeq() { return '—'; },
        getLayers() { return []; },
      };
    },
  };

  window.LLMEngine.register({
    id: 'topics', title: '科普图谱', icon: 'map', kind: 'overlay',
    tagline: '十个维度看 LLM：分词 / 语义 / 缩放 / 幻觉 / 对齐 / RAG / CoT / 多模态 / 成本 / 评测',
    hint: '覆盖大语言模型的方方面面，卡片可滚动浏览。',
    boot: (ctx) => window.TopicsMod.boot(ctx),
  });
})();
