/* =============================================================================
 * narration.js —— 讲解动画（影片模式）
 *
 * 一条脚本时间轴，把「原理 → 推理 → 训练」串成一部可播放的讲解片。
 * 它只是「驱动」既有的两个可视化模块：相机、原子步骤、训练阶段都由脚本指定，
 * 画面里的数字仍然是 src/model.js 现场算出来的真实张量 —— 影片没有任何预渲染素材。
 *
 * 关键设计：seek(t) 是**纯函数式**的（给定 t 就能完全确定画面），
 * 因此同一份脚本既能在页面里按真实时间播放，也能被逐帧导出成 MP4。
 * ========================================================================== */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- 影片脚本
   * 每个场景：
   *   act     幕标题（左上角）
   *   title   本场景标题（大字）
   *   mode    'fwd' 推理 / 'train' 训练
   *   cam     相机预设名
   *   dur     时长(ms)
   *   steps   [起, 止] 推理模式的原子步骤区间（按绝对索引）
   *   trainAt { step, phase } 训练模式：定位到第 step 步的第 phase 个阶段
   *   formula 可选，公式芯片
   *   talk    [[进度, 解说文字], ...] 进度 0~1
   *   big    可选，开场大字卡
   *   card   可选，'tensors' 显示真实张量表
   */
  const SCRIPT = [
    /* ======================= 第一幕 · 原理 ======================= */
    {
      act: '第一幕 · 原理', title: '大语言模型的内部，到底在算什么？',
      mode: 'fwd', cam: 'overview', dur: 12600, steps: [0, 0], big: true,
      talk: [
        [0.00, '大语言模型的内部，到底在算什么？'],
        [0.42, '接下来，我们把它从原理到训练，一步步拆开看。'],
      ],
    },
    {
      act: '第一幕 · 原理', title: '① 一切都从 Token 开始',
      mode: 'fwd', cam: 'tokens', dur: 21100, steps: [0, 0],
      talk: [
        [0.00, '模型看不懂文字。第一步是把文字切成 token —— 每个 token 对应一个整数 id。'],
        [0.40, '例子输入 "1592"，被切成 4 个 token：1、5、9、2。'],
        [0.74, '整个词表只有 12 个符号；真实的模型词表有几万到十几万个。'],
      ],
    },
    {
      act: '第一幕 · 原理', title: '② Embedding：把 id 变成向量',
      mode: 'fwd', cam: 'tokens', dur: 22800, steps: [0, 0],
      formula: 'x = E[token_id]',
      talk: [
        [0.00, '拿 id 去查一张表 E，得到一个 32 维的向量。'],
        [0.40, '这张表是训练出来的：语义相近的 token，向量也会比较接近。'],
        [0.74, '每一行代表一个 token 的初始含义，32 个数字就是它在空间里的坐标。'],
      ],
    },
    {
      act: '第一幕 · 原理', title: '③ 位置编码 RoPE',
      mode: 'fwd', cam: 'tokens', dur: 16900, steps: [1, 1],
      formula: "q' = RoPE(q, pos)",
      talk: [
        [0.00, '注意力本身是「无序」的：只给 token，模型分不清 "1592" 和 "2915"。'],
        [0.40, 'RoPE 把位置信息「旋转」进 Q 和 K —— 第 t 个位置转 t 个角度。'],
        [0.74, '这样两个 token 的内积就自然带上了「相对距离」的信息。'],
      ],
    },
    {
      act: '第一幕 · 原理', title: '④ 一层里有什么',
      /* ④ 的步进区间故意拉长到 [2,9]：解说讲的是"先注意力、再 MLP"，
       * 画面就得把这两半都走一遍（到这一步 MLP 神经元阵列也会点亮）。 */
      mode: 'fwd', cam: 'layer', dur: 23300, steps: [2, 9],
      talk: [
        [0.00, 'Transformer 由若干层堆叠而成，这里用了 2 层。'],
        [0.38, '每层干两件事：先让 token 之间交换信息（注意力），再各自做一次非线性加工（MLP）。'],
        [0.74, '两件事外面都套了残差连接，前面还有 RMSNorm 负责稳定数值。'],
      ],
    },
    {
      act: '第一幕 · 原理', title: '⑤ RMSNorm：先把数值拉回同一尺度',
      mode: 'fwd', cam: 'layer', dur: 12600, steps: [2, 2],
      formula: 'x̂ = x / √(mean(x²)+ε) · g',
      talk: [
        [0.00, '每层开始前先归一化：除以均方根，再乘一个可学习的增益 g。'],
        [0.48, '不做这一步，数值会在层与层之间越滚越大，训练根本稳不住。'],
      ],
    },
    {
      act: '第一幕 · 原理', title: '⑥ Q / K / V：三个视角看同一个 token',
      mode: 'fwd', cam: 'layer', dur: 17300, steps: [3, 3],
      formula: 'Q = X·W_Q,  K = X·W_K,  V = X·W_V',
      talk: [
        [0.00, '每个 token 的向量乘上三个权重矩阵，得到 Q、K、V。'],
        [0.36, 'Q 是「我在找什么」，K 是「我是什么」，V 是「我能提供什么」。'],
        [0.70, '注意力就是用 Q 去匹配所有 K，再按匹配度加权取 V。'],
      ],
    },
    {
      act: '第一幕 · 原理', title: '⑦ 注意力：缩放点积 + 因果掩码',
      mode: 'fwd', cam: 'matrix', dur: 17000, steps: [4, 4],
      formula: 'A = softmax(QKᵀ/√d_h + mask)·V',
      talk: [
        [0.00, '把 Q 和 K 做内积、除以 √d_h 缩放，得到一张分数表。'],
        [0.36, '再用下三角掩码把「未来」遮掉 —— 这就是因果注意力，只能看已生成的部分。'],
        [0.72, '最后 softmax 成概率，每一行加起来正好等于 1。'],
      ],
    },
    {
      act: '第一幕 · 原理', title: '⑧ 这张热力图就是真实权重',
      mode: 'fwd', cam: 'matrix', dur: 18700, steps: [5, 5],
      talk: [
        [0.00, '格子越深，说明这个位置的 token 被「关注」得越多。'],
        [0.38, '形状是三角的，因为每个位置只能看到自己和前面的位置。'],
        [0.72, '这些数字不是画出来的 —— 它们来自刚才那次真实的前向计算。'],
      ],
    },
    {
      act: '第一幕 · 原理', title: '⑨ 加权取 V，再叠加回原向量',
      mode: 'fwd', cam: 'layer', dur: 19100, steps: [6, 7],
      formula: 'x = x + Attn(x)',
      talk: [
        [0.00, '用概率给所有 V 加权求和，得到注意力这一路的输出。'],
        [0.40, '然后把输出加回原来的 x —— 这就是残差连接。'],
        [0.72, '残差让梯度能直接流回浅层，是深层网络能训起来的关键。'],
      ],
    },
    {
      act: '第一幕 · 原理', title: '⑩ MLP：每个位置各自做一次变换',
      mode: 'fwd', cam: 'mlp', dur: 21000, steps: [8, 8],
      formula: 'GELU(X·W₁)·W₂',
      talk: [
        [0.00, '把 32 维升到 64 维，过一层 GELU 激活，再降回 32 维。'],
        [0.40, '这里没有任何 token 之间的交流 —— 它是逐位置独立进行的。'],
        [0.72, '一句话总结：注意力负责横向传信息，MLP 负责纵向做加工。'],
      ],
    },
    {
      act: '第一幕 · 原理', title: '⑪ 64 个神经元的真实激活值',
      mode: 'fwd', cam: 'mlp', dur: 15900, steps: [9, 9],
      talk: [
        [0.00, '每个球是一个隐层神经元，大小和颜色是它这次的真实激活值。'],
        [0.42, '可以看到只有一部分神经元被点亮 —— 这就是稀疏激活。'],
        [0.72, '大模型里这个隐层要宽得多，但原理完全相同。'],
      ],
    },

    /* ======================= 第二幕 · 走完一次推理 ======================= */
    {
      act: '第二幕 · 走完一次推理', title: '⑫ 同样的结构，再来一遍',
      mode: 'fwd', cam: 'overview', dur: 16700, steps: [10, 19],
      talk: [
        [0.00, '第 1 层输出后，第 2 层用完全相同的结构再算一遍。'],
        [0.34, '真实的模型会堆几十到上百层，每一层的流程都和我们刚看到的一样。'],
        [0.70, '到这里，25 个原子步骤里的前 20 步已经走完。'],
      ],
    },
    {
      act: '第二幕 · 走完一次推理', title: '⑬ 输出头：把向量投影回词表',
      mode: 'fwd', cam: 'head', dur: 15700, steps: [20, 21],
      formula: 'logits = x̂ · W_lm',
      talk: [
        [0.00, '最后再做一次 RMSNorm，然后乘上输出矩阵 W_lm。'],
        [0.40, '它把 32 维的向量，投影成词表大小 12 的「打分」—— logits。'],
        [0.74, '分数越高，模型越认为下一个 token 是它。'],
      ],
    },
    {
      act: '第二幕 · 走完一次推理', title: '⑭ Softmax：分数变成概率',
      mode: 'fwd', cam: 'head', dur: 18700, steps: [22, 22],
      formula: 'p = softmax(logits / T)',
      talk: [
        [0.00, 'softmax 把 logits 变成概率分布：全部非负，加起来等于 1。'],
        [0.42, '温度 T 控制分布的「陡峭程度」—— T 越小越保守，越大越随机。'],
        [0.74, '到这里，模型才第一次给出「下一个词可能是谁」的答案。'],
      ],
    },
    {
      act: '第二幕 · 走完一次推理', title: '⑮ Top-p 采样：怎么挑出那个 token',
      mode: 'fwd', cam: 'head', dur: 17300, steps: [23, 24],
      formula: 'token ~ Categorical(p)',
      talk: [
        [0.00, 'Top-p 按概率从高到低累加，累计超过阈值就把剩下的截断。'],
        [0.38, '在保留下来的候选里按概率随机抽一个 —— 所以同样的输入，输出可以不同。'],
        [0.74, '抽出的 token 就是这次的预测结果。'],
      ],
    },
    {
      act: '第二幕 · 走完一次推理', title: '⑯ 自回归：把它接回去，再来一次',
      mode: 'fwd', cam: 'overview', dur: 20900, steps: [24, 24], growTokens: 2,
      talk: [
        [0.00, '把刚生成的 token 追加到序列末尾，然后整段重新跑一遍。'],
        [0.42, '这就是「自回归」—— 一次生成一个 token，循环下去，直到结束符。'],
        [0.74, '所谓大模型写字，本质就是这个循环重复了几百上千次。'],
      ],
    },

    /* ======================= 第三幕 · 真实运算 ======================= */
    {
      act: '第三幕 · 这些数是真的', title: '⑰ 把中间张量一个个摊开',
      mode: 'fwd', cam: 'tokens', dur: 30200, steps: [22, 22], card: 'tensors', growTokens: 3,
      talk: [
        [0.00, '刚才看到的每个数字，都来自浏览器里这次真实的前向计算。'],
        [0.34, '以固定输入 "1592" 为例：Embedding 查表、RMSNorm、QKV、注意力分数、softmax、MLP 激活、logits —— 逐步摊开。'],
        [0.70, '其中注意力那一组最能说明问题：先算原始分数，再减最大值，再归一化。'],
      ],
    },
    {
      act: '第三幕 · 这些数是真的', title: '⑱ 并且可以和独立实现对上',
      mode: 'fwd', cam: 'tokens', dur: 20700, steps: [22, 22], card: 'tensors',
      talk: [
        [0.00, '同一套权重，命令行里的另一份独立实现（同样用 Node 跑）算出的参考值，与页面逐项比对。'],
        [0.38, '13 组张量，最大绝对误差 0 —— 说明页面上的数确实是算出来的，不是写死的。'],
        [0.74, '面板上那两行自检，就是每次刷新都现场跑一遍这个比对。'],
      ],
    },

    /* ======================= 第四幕 · 训练 ======================= */
    {
      act: '第四幕 · 它怎么学会的', title: '⑲ 训练：一个闭环，跑上千万次',
      mode: 'train', cam: 'overview', dur: 18100, trainAt: { step: 1, phase: 'batch' },
      talk: [
        [0.00, '到这里模型还是「随机」的 —— 它的权重是随机初始化的。'],
        [0.36, '训练做的事很朴素：让它预测下一个 token，猜错了就调整权重，然后重复。'],
        [0.72, '接下来看这个闭环的每一步。'],
      ],
    },
    {
      act: '第四幕 · 它怎么学会的', title: '⑳ 采样训练批次',
      mode: 'train', cam: 'batch', dur: 19100, trainAt: { step: 1, phase: 'batch' },
      talk: [
        [0.00, '从语料里切一个窗口：上面一行是输入 x，下面一行是目标 y。'],
        [0.44, 'y 就是 x 往左移一格 —— 「下一个 token」这个监督信号直接来自序列本身。'],
        [0.76, '所以不需要人工标注，任何文本都是训练数据。'],
      ],
    },
    {
      act: '第四幕 · 它怎么学会的', title: '㉑ 前向传播',
      mode: 'train', cam: 'forwardTight', dur: 12900, trainAt: { step: 1, phase: 'forward' },
      talk: [
        [0.00, '和推理时完全相同的计算路径：嵌入、注意力、MLP、输出头。'],
        [0.50, '训练和推理共用同一条前向路径，区别只在训练时我们记住了中间结果。'],
      ],
    },
    {
      act: '第四幕 · 它怎么学会的', title: '㉒ 交叉熵损失',
      mode: 'train', cam: 'loss', dur: 22100, trainAt: { step: 1, phase: 'loss' },
      formula: 'L = -log p(y|x)',
      talk: [
        [0.00, '把正确 token 的概率取负对数，就是这一回的损失。'],
        [0.34, '概率越接近 1，损失越接近 0；随机初始化的模型大约在 ln(12) ≈ 2.48 附近。'],
        [0.70, '一个数字就概括了「这次猜得有多离谱」，接下来要让它变小。'],
      ],
    },
    {
      act: '第四幕 · 它怎么学会的', title: '㉓ 反向传播：把责任分回去',
      mode: 'train', cam: 'backward', dur: 21100, trainAt: { step: 1, phase: 'backward' },
      formula: '∂L/∂θ  链式法则逐层回传',
      talk: [
        [0.00, '要对权重负责，就得知道每个权重把损失推高了多少 —— 这就是梯度。'],
        [0.32, '从损失出发，用链式法则一层层往回算。柱子的高度就是各块参数真实的梯度范数。'],
        [0.68, '这个过程是手写的：前向、反向、每一层的转置乘法，都在 model.js 里。'],
      ],
    },
    {
      act: '第四幕 · 它怎么学会的', title: '㉔ 梯度裁剪：防止一步走飞',
      mode: 'train', cam: 'optim', dur: 18200, trainAt: { step: 1, phase: 'clip' },
      formula: 'g ← g · min(1, c/‖g‖)',
      talk: [
        [0.00, '如果梯度整体太大，一次更新就可能把模型推飞。'],
        [0.46, '做法很简单：梯度范数超过阈值，就整体等比缩放回去。'],
        [0.76, '画面上的 ‖g‖ 和裁剪系数，都是这一步的真实值。'],
      ],
    },
    {
      act: '第四幕 · 它怎么学会的', title: '㉕ AdamW：真正改动权重',
      mode: 'train', cam: 'optim', dur: 21800, trainAt: { step: 1, phase: 'adam' },
      formula: 'θ ← θ − η·(m̂/(√v̂+ε) + λθ)',
      talk: [
        [0.00, 'AdamW 用两个统计量来决定每一步走多大：梯度的滑动平均，和梯度平方的滑动平均。'],
        [0.34, '前者提供惯性，后者让每个参数有各自的学习率；再额外做一点权重衰减。'],
        [0.68, '画面上的立方体就是 W₁ 的真实权重，橙色小块是真实的一阶矩（动量）。'],
      ],
    },
    {
      act: '第四幕 · 它怎么学会的', title: '㉖ 一步完成，然后重复',
      mode: 'train', cam: 'curve', dur: 20700, trainAt: { step: 70, phase: 'record' },
      formula: 'θ 已改变 → 重新前向',
      talk: [
        [0.00, '一次迭代结束，权重已经变了。回到第一步，换一个批次再来。'],
        [0.38, '这条曲线是真实跑出来的 loss：每完成一次迭代就记录一个点。'],
        [0.72, '训练就是把这个闭环重复成千上万次 —— 大模型要跑几百万次。'],
      ],
    },
    {
      act: '尾声', title: '整个流程，到这里就闭环了',
      mode: 'train', cam: 'overview', dur: 23900, trainAt: { step: 160, phase: 'record' },
      talk: [
        [0.00, '原理、推理、训练 —— 三者用的是同一套代码、同一份权重、同一套数学。'],
        [0.42, '语料是六个三字符词拼成的短语；模型从随机初始化出发，真把下一字符的预测准确率练到了八成以上。'],
        [0.78, '大模型的规模大了几个数量级，但骨架就是刚才这些。'],
      ],
    },
  ];


  /* ---------------- 时间轴累计 ---------------- */
  const CUM = [];
  let TOTAL = 0;
  for (const s of SCRIPT) { CUM.push(TOTAL); TOTAL += s.dur; }

  const el = (id) => document.getElementById(id);
  const LM = window.TinyLM;
  const clamp01 = (x) => x < 0 ? 0 : x > 1 ? 1 : x;
  const smooth = (u) => u * u * (3 - 2 * u);
  const XFADE = 1200;          // 场景末尾用于相机过渡的时长
  const fmt = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };

  const C = {
    on: false, playing: false, t: 0, total: TOTAL,
    scenes: SCRIPT, cum: CUM, xfade: XFADE,
    dur: TOTAL, fps: 24,
  };
  let deps = null;
  let curMode = null;
  let captionCache = { scene: -1, line: -1, big: null };

  /* ---------------- 初始化 ---------------- */
  function attach(d) {
    deps = d;
    const F = deps.fwd;
    if (F.STEPS.length !== 25) {
      console.warn('[narration] 推理步骤数不是 25，脚本中的 steps 索引可能失效：', F.STEPS.length);
    }
    buildDom();
    // 注意：此处不 seek。模型还没训练完时可视化的 cache 是空的，
    // 提前 update 会抛异常。等 app.js 在 bootDone 之后调用 seek(0)。
    return C;
  }
  function ready() { return !!(deps && deps.app && deps.app.bootDone); }

  function buildDom() {
    if (el('cine')) return;
    const wrap = document.createElement('div');
    wrap.id = 'cine';
    wrap.innerHTML =
      '<div id="cineAct"></div>' +
      '<div id="cineTitle"></div>' +
      '<div id="cineFormula"></div>' +
      '<div id="cineCard"></div>' +
      '<div id="cineCaption"></div>' +
      '<div id="cineFoot"><div id="cineBar"><i></i></div>' +
      '<div id="cineClock"></div></div>' +
      '<div id="cineCtl">' +
      '<button id="cinePlay"><span class="ic-slot" id="cinePlayIcon"></span><span id="cinePlayLabel">暂停</span></button>' +
      '<input type="range" id="cineSeek" min="0" max="1000" value="0">' +
      '<span id="cineTime">0:00 / 0:00</span>' +
      '</div>';
    document.body.appendChild(wrap);

    setPlayUI(true);
    el('cinePlay').addEventListener('click', () => { C.playing ? pause() : play(); });
    el('cineSeek').addEventListener('input', () => {
      pause();
      seek(parseFloat(el('cineSeek').value) / 1000 * TOTAL);
    });
    el('cineTime').textContent = '0:00 / ' + fmt(TOTAL);
  }

  /* ---------------- 相机插值 ---------------- */
  function camOf(mode, name) {
    const m = mode === 'fwd' ? deps.fwd : deps.train;
    // 用 resolveCam 而不是 camTable：r 需要按当前宽高比现算
    return m.resolveCam ? m.resolveCam(name) : null;
  }
  function applyInterp(mode, camA, camB, u) {
    const a = camOf(mode, camA);
    if (!a) return;
    const b = camB ? camOf(mode, camB) : a;
    const e = smooth(clamp01(u));
    const m = mode === 'fwd' ? deps.fwd : deps.train;
    m.applyCamAt(
      a.theta + (b.theta - a.theta) * e,
      a.phi + (b.phi - a.phi) * e,
      a.r + (b.r - a.r) * e,
      [a.tgt[0] + (b.tgt[0] - a.tgt[0]) * e,
       a.tgt[1] + (b.tgt[1] - a.tgt[1]) * e,
       a.tgt[2] + (b.tgt[2] - a.tgt[2]) * e]
    );
  }

  /* ---------------- 解说文字 ---------------- */
  function talkAt(sc, p) {
    let idx = 0;
    for (let i = 0; i < sc.talk.length; i++) if (p >= sc.talk[i][0]) idx = i;
    return idx;
  }

  function renderCaption(i, sc, p) {
    const li = talkAt(sc, p);
    if (captionCache.scene === i && captionCache.line === li) return;
    captionCache.scene = i; captionCache.line = li;
    const cap = el('cineCaption');
    cap.textContent = sc.talk[li][1];
    cap.classList.toggle('on', true);
    // 大字卡：开场时把解说放大居中
    const big = !!sc.big;
    if (captionCache.big !== big) { captionCache.big = big; document.body.classList.toggle('cineBig', big); }
  }

  function renderCard(sc) {
    const box = el('cineCard');
    if (!sc.card) { box.classList.remove('on'); return; }
    if (box.dataset.built === sc.card && box.classList.contains('on')) return;
    if (sc.card === 'tensors') {
      const model = deps.app && deps.app.model;
      if (!model || !window.LLMTrace) return;
      const R = window.LLMTrace.compute(model);
      const cmp = window.LLMTrace.compare(R, window.LLMTraceRef ? window.LLMTraceRef.tensors : (window.LLM_TRACE_REF && window.LLM_TRACE_REF.tensors));
      // 只取前 8 组，避免卡片过高；数值直接来自真实计算
      const rows = R.steps.slice(0, 8).map((s) =>
        '<div class="cc-row"><div class="cc-t">' + s.title + '</div>' +
        '<div class="cc-f">' + s.formula + '</div>' +
        '<div class="cc-n">' + s.arr.map((v) => '<span>' + v + '</span>').join('') + '</div></div>').join('');
      box.innerHTML =
        '<div class="cc-h">真实运算示例 · 输入 ' + R.tokens.join('') + '</div>' +
        rows +
        '<div class="cc-foot">' + (cmp.ok ? '✓ ' + cmp.msg : '⚠ ' + cmp.msg) +
        ' &nbsp;·&nbsp; 概率和 Σp = ' + R.pSum +
        ' &nbsp;·&nbsp; softmax 手算一致性 ' + (R.attnConsistent ? '✓' : '✗') + '</div>';
      box.dataset.built = sc.card;
      box.classList.add('on');
    }
  }

  /* ---------------- 自回归：把新 token 真的接回序列 ----------------
   * 影片模式下主循环不再驱动推理，所以序列不会自己生长。
   * 为了让第 16 幕的解说「把生成的 token 接回去」名副其实，
   * 这里用可视化里同一套 Top-p 采样（固定种子）真的追加 token。
   * 采样结果只依赖序列与模型，因此是确定性的：同一时刻 seek 必然得到同一画面。 */
  let growChain = null;      // 预计算的追加链
  let grownNow = -1;         // 当前已追加的数量
  function ensureGrowChain() {
    if (growChain) return growChain;
    const F = deps.fwd;
    if (!F.S.model) return null;
    const base = F.S.prompt.slice();
    let seq = base.slice();
    const out = [];
    for (let k = 0; k < 4; k++) {
      const cache = LM.forward(F.S.model, seq);
      // seed 固定 → 每次播放取到的是同一串 token
      const r = LM.sample(F.S.model, cache, cache.T - 1,
        { temp: 0.85, topP: 0.92, topK: 8, seed: 11 + k });
      out.push(r.pick);
      seq = seq.concat([r.pick]);
    }
    growChain = { base, toks: out };
    return growChain;
  }
  function applyGrow(n) {
    if (grownNow === n) return;
    const ch = n > 0 ? ensureGrowChain() : null;
    const F = deps.fwd;
    if (n > 0 && !ch) return;
    F.S.seq = ch ? ch.base.concat(ch.toks.slice(0, n)) : F.S.prompt.slice();
    F.refresh();
    grownNow = n;
  }

  /* ---------------- 核心：定位到某一时刻 ---------------- */
  function seek(t) {
    if (!ready()) return;
    t = Math.max(0, Math.min(TOTAL, t));
    C.t = t;

    let i = 0;
    while (i < SCRIPT.length - 1 && t >= CUM[i] + SCRIPT[i].dur) i++;
    const sc = SCRIPT[i];
    const local = t - CUM[i];
    const p = clamp01(local / sc.dur);

    // ---- 模式 ----
    if (sc.mode !== curMode) {
      curMode = sc.mode;
      deps.setMode(sc.mode, true);          // true = 不要覆盖相机，由影片接管
    }

    // ---- 相机：场景末尾向下一场景过渡 ----
    const tail = sc.dur - XFADE;
    let camB = null, u = 0;
    if (local > tail) {
      const nx = SCRIPT[i + 1];
      if (nx && nx.mode === sc.mode) { camB = nx.cam; u = (local - tail) / XFADE; }
    }
    applyInterp(sc.mode, sc.cam, camB, u);

    // ---- 视觉状态 ----
    if (sc.mode === 'fwd') {
      applyGrow(sc.growTokens || 0);
      const [a, b] = sc.steps || [0, 0];
      const n = Math.max(1, b - a + 1);
      // 前 82% 走完步骤区间，剩下留给画面停留
      const uu = clamp01(p / 0.82) * n;
      const si = Math.min(n - 1, Math.floor(uu));
      const frac = Math.min(1, uu - si);
      deps.fwd.gotoStep(a + si, frac);
      deps.fwd.update(t);
    } else {
      const ta = sc.trainAt || { step: 1, phase: 'batch' };
      const pi = deps.train.STEPS.findIndex((s) => s.id === ta.phase);
      deps.train.seekToStep(ta.step);
      // 阶段内进度：75% 之前推到满，之后停留
      const pf = clamp01(p / 0.75);
      deps.train.seekPhase(pi < 0 ? 0 : pi, pf);
      deps.train.update(t);
    }

    // ---- 文案 ----
    el('cineAct').textContent = sc.act;
    el('cineTitle').textContent = sc.title;
    const f = el('cineFormula');
    f.textContent = sc.formula || '';
    f.classList.toggle('on', !!sc.formula);
    renderCaption(i, sc, p);
    renderCard(sc);

    el('cineBar').firstChild.style.width = (t / TOTAL * 100).toFixed(2) + '%';
    el('cineClock').textContent = fmt(t) + ' / ' + fmt(TOTAL);
    const sk = el('cineSeek');
    if (sk && document.activeElement !== sk) sk.value = String(Math.round(t / TOTAL * 1000));
    el('cineTime').textContent = fmt(t) + ' / ' + fmt(TOTAL);
  }

  function render() {
    if (!ready()) return;
    deps.core.controls.update();
    deps.core.renderer.render(deps.core.scene, deps.core.camera);
  }

  /* ---------------- 播放控制 ---------------- */
  let lastReal = 0;
  function play() {
    if (C.t >= TOTAL) seek(0);
    C.playing = true; lastReal = 0;
    setPlayUI(true);
  }
  function pause() {
    C.playing = false;
    setPlayUI(false);
  }
  /* 播放/暂停按钮：矢量图标 + 文案（不用文字符号） */
  function setPlayUI(playing) {
    const b = el('cinePlay'); if (!b) return;
    const I = window.LLMIcons || {};
    const icon = el('cinePlayIcon'), label = el('cinePlayLabel');
    b.classList.toggle('on', playing);
    if (icon && I) icon.innerHTML = I[playing ? 'pause' : 'play'](15);
    if (label) label.textContent = playing ? '暂停' : '播放';
  }
  function tick(now) {
    if (!C.playing) return;
    if (!lastReal) lastReal = now;
    const dt = now - lastReal; lastReal = now;
    const nt = C.t + dt;
    seek(nt);
    if (nt >= TOTAL) pause();
  }

  /* ---------------- 开关 ---------------- */
  function setOn(on, opts) {
    if (!ready()) return;
    C.on = !!on;
    document.body.classList.toggle('cinema', C.on);
    document.body.classList.toggle('recording', !!(opts && opts.recording));
    deps.app.cinema.on = C.on;
    // 侧栏隐藏后画布尺寸变了，必须重算
    requestAnimationFrame(() => {
      deps.core.resize();
      if (C.on) seek(C.t); else deps.app.applyModeCam && deps.app.applyModeCam();
      render();
    });
    if (C.on) {
      if (!(opts && opts.recording)) play(); else pause();
    }
  }

  window.LLMCine = {
    SCRIPT, total: TOTAL, scenes: SCRIPT, cum: CUM,
    C, attach, seek, render, play, pause, tick, setOn,
    isOn: () => C.on, fmt,
  };
})();
