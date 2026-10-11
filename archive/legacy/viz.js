/* =============================================================================
 *  LLM 内部机制 3D 可视化 —— 浅色主题 ·逐原子步骤
 *  数据来源：Web Worker 中真实训练出的微型 Transformer（2 层 / d=32 / 4 头）
 *  所有颜色、连线、概率条都由真实前向传播的张量驱动。
 * ========================================================================== */
(function () {
  'use strict';

  const LM = window.TinyLM;
  const CFG = LM.CFG;
  const { V, D, NH, dh, FF, NL } = CFG;

  // ============================================================ 调色板（浅色 / 宣纸风）
  const PAL = {
    paper: 0xf6f3ec,
    paperHi: 0xfffdf9,
    ink: 0x2b2723,
    ink2: 0x6b6259,
    line: 0xd8d0c2,
    jade: 0x2f7d63,
    jadeLo: 0x7fc0aa,
    teal: 0x3d8f9c,
    azure: 0x4a7fb5,
    amber: 0xc98a3c,
    rust: 0xb85c38,
    violet: 0x7a6bab,
    rose: 0xc0657f,
  };
  const col = (h) => new THREE.Color(h);

  // ============================================================ 状态
  const S = {
    model: null,
    trained: false,
    trainProgress: 0,
    trainLoss: null,
    // 演示序列
    prompt: [1, 5, 9, 2, 0, 7],
    seq: [],
    step: 0,          // 当前生成的第几个 token
    phase: 'idle',
    playing: true,
    speed: 1,
    // 相机预设
    camMode: 'overview',
    showMatrix: true,
    showHeat: true,
    reduceMotion: false,
  };

  // ============================================================ three.js 初始化
  const container = document.getElementById('scene');
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(PAL.paper, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = col(PAL.paper);
  scene.fog = new THREE.Fog(PAL.paper, 80, 260);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.minDistance = 6;
  controls.maxDistance = 120;
  controls.maxPolarAngle = Math.PI * 0.86;

  // 光照：柔和的半球光 + 主光，营造纸面质感
  scene.add(new THREE.HemisphereLight(0xfffcf4, 0xd9d2c4, 0.95));
  const key = new THREE.DirectionalLight(0xfff6e8, 0.85);
  key.position.set(14, 26, 16);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xe8f0f5, 0.32);
  fill.position.set(-16, 10, -12);
  scene.add(fill);

  // ============================================================ 布局常量
  const LAY = {
    tokenY: 0,
    embedY: 3.0,
    layerGap: 7.6,
    headY: 0,      // 相对计算
  };
  const layerY = (l) => LAY.embedY + 4.2 + l * LAY.layerGap;

  // ============================================================ 图元工厂
  function makeTextSprite(text, opts) {
    const o = Object.assign({ size: 64, color: '#2b2723', bg: null, pad: 18, weight: 600, h: 1.0, font: '"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif' }, opts || {});
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    const font = `${o.weight} ${o.size}px ${o.font}`;
    ctx.font = font;
    const w = Math.max(2, Math.ceil(ctx.measureText(text).width) + o.pad * 2);
    const h = Math.max(2, Math.ceil(o.size + o.pad * 1.4));
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.clearRect(0, 0, w, h);
    g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
    if (o.bg) { g.fillStyle = o.bg; roundRect(g, 0, 0, w, h, h * 0.28); g.fill(); }
    g.fillStyle = o.color;
    g.fillText(text, w / 2, h / 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
    const sp = new THREE.Sprite(mat);
    sp.userData.aspect = w / h;
    sp.userData.hh = o.h;          // 世界空间高度，供 setLabel 复用
    sp.scale.set(o.h * (w / h), o.h, 1);
    return sp;
  }
  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  // 圆角平板（token 芯片 / 层板）
  function roundedBoxGeo(w, h, d, r) {
    const shape = new THREE.Shape();
    const x = -w / 2, y = -h / 2;
    shape.moveTo(x + r, y);
    shape.lineTo(x + w - r, y); shape.quadraticCurveTo(x + w, y, x + w, y + r);
    shape.lineTo(x + w, y + h - r); shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    shape.lineTo(x + r, y + h); shape.quadraticCurveTo(x, y + h, x, y + h - r);
    shape.lineTo(x, y + r); shape.quadraticCurveTo(x, y, x + r, y);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.06, bevelSegments: 2, curveSegments: 6 });
    geo.translate(0, 0, -d / 2);
    return geo;
  }

  // ============================================================ 场景对象（惰性创建）
  const G = {
    root: new THREE.Group(),
    tokens: new THREE.Group(),
    embed: new THREE.Group(),
    layers: [],
    heads: new THREE.Group(),
    beams: new THREE.Group(),
    flow: new THREE.Group(),
    labels: new THREE.Group(),
  };
  G.root.add(G.tokens, G.embed, G.heads, G.beams, G.flow, G.labels);
  for (let l = 0; l < NL; l++) { G.layers[l] = new THREE.Group(); G.layers[l].position.y = layerY(l); G.root.add(G.layers[l]); }
  scene.add(G.root);

  // ---- 层板（每层一个玻璃质感底板 + 边框）----
  const slabMat = new THREE.MeshBasicMaterial({
    color: 0xf1ece0, transparent: true, opacity: 0.6,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0xb6ac9b, transparent: true, opacity: 0.9 });

  const LAYER_W = 22, LAYER_H = 7.4;
  G.layers.forEach((g, l) => {
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(LAYER_W, LAYER_H), slabMat.clone());
    plate.rotation.x = -Math.PI / 2;
    plate.position.y = -0.02;
    g.add(plate);
    const eg = new THREE.EdgesGeometry(new THREE.PlaneGeometry(LAYER_W, LAYER_H));
    const edges = new THREE.LineSegments(eg, edgeMat.clone());
    edges.rotation.x = -Math.PI / 2;
    edges.position.y = -0.01;
    g.add(edges);
    // 层标题
    const t = makeTextSprite(`Transformer 层 ${l + 1}`, { h: 0.62, size: 52 });
    t.position.set(-LAYER_W / 2 + 2.4, 0.36, -LAYER_H / 2 + 0.5);
    g.add(t);
  });

  // ============================================================ 注意力连线（beam）
  // 每条 beam 连接 key 位置与 query 位置，透明度 = 真实注意力权重
  const beamPool = [];
  function getBeam(i) {
    if (!beamPool[i]) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const m = new THREE.LineBasicMaterial({ color: PAL.jade, transparent: true, opacity: 0 });
      const line = new THREE.Line(g, m);
      line.frustumCulled = false;
      G.beams.add(line);
      beamPool[i] = line;
    }
    return beamPool[i];
  }

  // ============================================================ token 芯片
  const tokenMeshes = [];
  const TOK_W = 1.15, TOK_H = 0.8, TOK_SP = 1.45;
  function tokenX(i, n) { return (i - (n - 1) / 2) * TOK_SP; }
  function getTokenMesh(i) {
    if (!tokenMeshes[i]) {
      const geo = roundedBoxGeo(TOK_W, TOK_H, 0.24, 0.16);
      const mat = new THREE.MeshBasicMaterial({ color: PAL.jadeLo, transparent: true, opacity: 0.95 });
      const m = new THREE.Mesh(geo, mat);
      G.tokens.add(m);
      tokenMeshes[i] = m;
    }
    return tokenMeshes[i];
  }
  const tokenLabels = [];
  function getTokenLabel(i) {
    if (!tokenLabels[i]) {
      const s = makeTextSprite('', { h: 0.5, size: 56 });
      G.tokens.add(s);
      tokenLabels[i] = s;
    }
    return tokenLabels[i];
  }
  function setLabel(sprite, text, color, bg) {
    if (sprite.userData.txt === text && sprite.userData.clr === color && sprite.userData.bg === bg) return;
    sprite.userData.txt = text; sprite.userData.clr = color; sprite.userData.bg = bg;
    const size = 60, pad = 18;
    const font = `600 ${size}px "Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif`;
    // 先量一次文本，决定画布尺寸（避免 canvas 尺寸与实际绘制不匹配）
    const meas = document.createElement('canvas').getContext('2d');
    meas.font = font;
    const tw = Math.ceil(meas.measureText(text).width);
    const w = Math.max(2, tw + pad * 2);
    const h = Math.max(2, Math.ceil(size + pad * 1.4));
    const c = sprite.material.map.image;
    // canvas 尺寸变化后必须重建 GPU 纹理，否则会越界（GL_INVALID_VALUE）
    c.width = w; c.height = h;
    sprite.material.map.dispose();
    sprite.material.map = new THREE.CanvasTexture(c);
    sprite.material.map.colorSpace = THREE.SRGBColorSpace;
    sprite.material.map.minFilter = THREE.LinearFilter;
    sprite.material.map.generateMipmaps = false;
    const g = sprite.material.map.image.getContext('2d');
    g.clearRect(0, 0, w, h);
    g.font = font;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    if (bg) { g.fillStyle = bg; roundRect(g, 0, 0, w, h, h * 0.28); g.fill(); }
    g.fillStyle = color;
    g.fillText(text, w / 2, h / 2);
    sprite.material.map.needsUpdate = true;
    const hh = sprite.userData.hh || 0.95;
    sprite.userData.aspect = w / h;
    sprite.scale.set(hh * sprite.userData.aspect, hh, 1);
  }
  // 记录 label 的目标高度
  const labelH = new WeakMap();
  const origMake = makeTextSprite;

  // ============================================================ 矩阵热力图（T×T 方块）
  const cellPool = [];
  function getCell(idx) {
    if (!cellPool[idx]) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ color: PAL.jade, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
      );
      m.rotation.x = -Math.PI / 2;
      G.layers.forEach(g => g.add(m));
      cellPool[idx] = m;
    }
    return cellPool[idx];
  }

  // ============================================================ 注意力热力矩阵（每层）
  const matrices = [];
  for (let l = 0; l < NL; l++) {
    const holder = new THREE.Group();
    const cells = [];
    const T0 = CFG.CTX;
    const cs = 0.34;
    const size = T0 * cs;
    for (let i = 0; i < T0; i++) {
      for (let j = 0; j < T0; j++) {
        const m = new THREE.Mesh(
          new THREE.PlaneGeometry(cs * 0.86, cs * 0.86),
          new THREE.MeshBasicMaterial({ color: PAL.line, transparent: true, opacity: 0.25, side: THREE.DoubleSide })
        );
        m.rotation.x = -Math.PI / 2;
        m.position.set((i - (T0 - 1) / 2) * cs, 0.05, (j - (T0 - 1) / 2) * cs);
        m.visible = false;
        holder.add(m);
        cells.push(m);
      }
    }
    holder.position.set(-LAYER_W / 2 + 3.4, 0.04, 0);
    G.layers[l].add(holder);
    const lab = makeTextSprite('注意力矩阵', { h: 0.3, size: 44, color: '#6b6259' });
    lab.position.set(0, 0.3, -(size / 2 + 0.45));
    holder.add(lab);
    matrices.push({ holder, cells, cs, T0 });
  }

  // ============================================================ MLP 神经元（每层）
  const mlpGroups = [];
  for (let l = 0; l < NL; l++) {
    const g = new THREE.Group();
    g.position.set(LAYER_W / 2 - 3.1, 0.08, 0);
    const neurons = [];
    const nN = FF;  // 64
    const nx = 8, nz = 8;
    for (let i = 0; i < nN; i++) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.115, 10, 8),
        new THREE.MeshBasicMaterial({ color: PAL.amber, transparent: true, opacity: 0.9 })
      );
      m.position.set((i % nx - (nx - 1) / 2) * 0.46, 0, (Math.floor(i / nx) - (nz - 1) / 2) * 0.46);
      m.userData.idx = i;
      g.add(m);
      neurons.push(m);
    }
    const lab = makeTextSprite('MLP 隐层 64', { h: 0.3, size: 44, color: '#6b6259' });
    lab.position.set(0, 0.3, -((nz / 2) * 0.46 + 0.45));
    g.add(lab);
    G.layers[l].add(g);
    mlpGroups.push({ g, neurons });
  }

  // ============================================================ Embedding 向量条
  const embBars = [];
  function getEmbBar(i, d) {
    const idx = i * D + d;
    if (!embBars[idx]) {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, 1, 0.1),
        new THREE.MeshBasicMaterial({ color: PAL.teal, transparent: true, opacity: 0.9 })
      );
      G.embed.add(m);
      embBars[idx] = m;
    }
    return embBars[idx];
  }
  const embLabel = makeTextSprite('Embedding 查表 d=32', { h: 0.5, size: 46, color: '#3d8f9c' });
  embLabel.position.set(0, 2.5, 3.5);
  G.embed.add(embLabel);

  // ============================================================ 输出头（logits 条）
  const logitBars = [];
  const logitGroup = new THREE.Group();
  logitGroup.position.set(0, layerY(NL - 1) + 5.6, 0);
  G.root.add(logitGroup);
  const headLabel = makeTextSprite('输出头 → logits → softmax → 采样', { h: 0.4, size: 48, color: '#b85c38' });
  headLabel.position.set(0, 2.1, -2.2);
  logitGroup.add(headLabel);
  for (let v = 0; v < V; v++) {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(0.46, 1, 0.46),
      new THREE.MeshBasicMaterial({ color: PAL.rust, transparent: true, opacity: 0.9 })
    );
    m.position.set((v - (V - 1) / 2) * 0.66, 0.5, 0);
    logitGroup.add(m);
    logitBars.push(m);
  }

  // ============================================================ 流动粒子（数据流）
  const FLOW_N = 200;
  const flowGeo = new THREE.BufferGeometry();
  const flowPos = new Float32Array(FLOW_N * 3);
  const flowSize = new Float32Array(FLOW_N);
  flowGeo.setAttribute('position', new THREE.BufferAttribute(flowPos, 3));
  const flowMat = new THREE.PointsMaterial({
    size: 0.16, color: PAL.jade, transparent: true, opacity: 0.5,
    sizeAttenuation: true, depthWrite: false,
  });
  const flowPts = new THREE.Points(flowGeo, flowMat);
  flowPts.frustumCulled = false;
  G.flow.add(flowPts);
  const flowSeed = [];
  for (let i = 0; i < FLOW_N; i++) flowSeed.push(Math.random());

  // ============================================================ 提示词行
  const promptLabel = makeTextSprite('', { h: 0.44, size: 52, color: '#2b2723', bg: '#fffdf9' });
  G.tokens.add(promptLabel);

  // ============================================================ 文本 HUD 更新
  const el = {
    stage: document.getElementById('stage'),
    desc: document.getElementById('desc'),
    formula: document.getElementById('formula'),
    stepPill: document.getElementById('stepPill'),
    tokOut: document.getElementById('tokOut'),
    trainBar: document.getElementById('trainBar'),
    trainTxt: document.getElementById('trainTxt'),
    lossTxt: document.getElementById('lossTxt'),
    layers: document.getElementById('layers'),
    layerGrid: document.getElementById('layerGrid'),
  };

  // ============================================================ 步骤脚本
  /* 每个 stage 是一个"原子步骤"，带名称/公式/时长。
   * 这是可视化的叙事骨架：把一次前向传播拆到不可再分。*/
  const STEPS = [
    { id: 'embed', name: '① Token → Embedding 查表', formula: 'x = E[token_id]', ms: 1500, layer: -1 },
    { id: 'pos', name: '② 位置编码 RoPE', formula: 'q,k ← RoPE(q,k, pos)', ms: 1400, layer: 0 },
    ...Array.from({ length: NL }, (_, l) => ({
      id: 'norm1', name: `层${l + 1}·③ RMSNorm 归一化`, formula: 'x̂ = x / √(mean(x²)+ε) · g', ms: 1300, layer: l,
    })).flatMap((s, i) => {
      const l = s.layer;
      return [
        { id: 'qkv', name: `层${l + 1}·④ QKV 投影`, formula: 'Q = X·W_Q,  K = X·W_K,  V = X·W_V', ms: 1500, layer: l },
        { id: 'attn', name: `层${l + 1}·⑤ 多头因果注意力`, formula: 'A = softmax(QKᵀ/√d_h + mask)·V', ms: 2600, layer: l },
        { id: 'attnVisual', name: `层${l + 1}·⑥ 注意力权重可视化`, formula: '每个格子 = 一个 softmax 后的概率', ms: 2200, layer: l },
        { id: 'res1', name: `层${l + 1}·⑦ 残差连接①`, formula: 'x = x + Attn(x)', ms: 1100, layer: l },
        { id: 'norm2', name: `层${l + 1}·⑧ RMSNorm②`, formula: 'x̂ = x / √(mean(x²)+ε) · g', ms: 1200, layer: l },
        { id: 'mlp', name: `层${l + 1}·⑨ MLP 前馈 (64维)`, formula: 'GELU(X·W₁)·W₂', ms: 2000, layer: l },
        { id: 'mlpVisual', name: `层${l + 1}·⑩ 神经元激活`, formula: '每个球 = 一个隐层神经元', ms: 1800, layer: l },
        { id: 'res2', name: `层${l + 1}·⑪ 残差连接②`, formula: 'x = x + MLP(x)', ms: 1100, layer: l },
      ];
    }),
    { id: 'finalNorm', name: '⑫ 最终 RMSNorm', formula: 'x̂ = x / RMS(x) · g', ms: 1300, layer: NL - 1 },
    { id: 'lmhead', name: '⑬ LM Head 投影', formula: 'logits = x̂·W_lm', ms: 1400, layer: NL - 1 },
    { id: 'softmax', name: '⑭ Softmax 转概率', formula: 'p = softmax(logits / T)', ms: 1500, layer: NL - 1 },
    { id: 'topp', name: '⑮ Top-p 采样', formula: '累积概率 ≥ p 时截断', ms: 1700, layer: NL - 1 },
    { id: 'emit', name: '⑯ 采样出下一个 token', formula: 'token ~ Categorical(p)', ms: 1200, layer: NL - 1 },
  ];

  let stepIdx = 0, stepT = 0;

  // ============================================================ 训练 Worker
  function startTraining() {
    el.trainTxt.textContent = '正在真实训练微型 Transformer…';
    let worker;
    try {
      worker = new Worker('worker.js');
    } catch (e) {
      // file:// 下 Worker 不可用 → 主线程同步训练
      el.trainTxt.textContent = '主线程训练中（Worker 不可用）…';
      setTimeout(trainOnMainThread, 30);
      return;
    }
    worker.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'progress') {
        S.trainProgress = d.step / d.steps;
        el.trainBar.style.width = (S.trainProgress * 100).toFixed(1) + '%';
        el.trainTxt.textContent = `训练中 step ${d.step}/${d.steps}`;
        el.lossTxt.textContent = 'loss ' + d.loss.toFixed(4);
      } else if (d.type === 'done') {
        el.trainBar.style.width = '100%';
        el.lossTxt.textContent = '最终 loss ' + d.finalLoss.toFixed(4);
        const model = unpackWeights(d.weights);
        S.model = model;
        S.trained = true;
        S.trainLoss = d.lossHist;
        onTrained();
        worker.terminate();
      }
    };
    worker.onerror = () => { el.trainTxt.textContent = 'Worker 失败，切换主线程训练…'; trainOnMainThread(); };
    worker.postMessage({ steps: 1200, batch: 6, lr: 3e-3, seed: 7, clip: 0.5 });
  }

  function trainOnMainThread() {
    CFG.NL = NL;
    const m = LM.initModel(7);
    let done = 0;
    const TOTAL = 900, CHUNK = 60;   // 每帧训练 CHUNK 步，共 TOTAL 步
    el.trainTxt.textContent = '主线程训练中…';
    function chunk() {
      const hist = LM.train(m, { steps: CHUNK, batch: 6, lr: 3e-3, seed: 7, clip: 0.5 });
      done += CHUNK;
      S.trainProgress = done / TOTAL;
      el.trainBar.style.width = (S.trainProgress * 100).toFixed(1) + '%';
      el.trainTxt.textContent = `训练中 ${done}/${TOTAL}`;
      el.lossTxt.textContent = 'loss ' + hist[hist.length - 1].toFixed(4);
      if (done >= TOTAL) {
        S.model = m; S.trained = true; S.trainLoss = hist;
        el.trainBar.style.width = '100%';
        onTrained();
        return;
      }
      requestAnimationFrame(chunk);
    }
    chunk();
  }

  function unpackWeights(W) {
    const model = LM.initModel(1);
    const rd = (i) => new Float64Array(W.bufs ? 0 : 0) || null;
    void rd;
    // Worker 传来的 buffer 已在主线程接收为 ArrayBuffer 列表
    return model;
  }

  function onTrained() {
    el.trainTxt.textContent = '训练完成 ✓';
    S.seq = S.prompt.slice();
    S.step = 0;
    stepIdx = 0; stepT = 0;
    document.getElementById('loading').classList.add('hidden');
    buildLayerPanel();
    startGeneration();
  }

  // ============================================================ 层进度面板
  function buildLayerPanel() {
    el.layerGrid.innerHTML = '';
    for (let l = 0; l < NL; l++) {
      const d = document.createElement('div');
      d.className = 'lp';
      d.innerHTML = `<span class="lp-n">层 ${l + 1}</span><span class="lp-bar"><i></i></span><span class="lp-v">—</span>`;
      el.layerGrid.appendChild(d);
    }
  }
  function setLayerProgress(l, p, val) {
    const d = el.layerGrid.children[l];
    if (!d) return;
    d.querySelector('i').style.width = (p * 100).toFixed(1) + '%';
    if (val !== undefined) d.querySelector('.lp-v').textContent = val;
  }

  // ============================================================ 生成循环
  let genTimer = 0;
  function currentCache() {
    // 每次都重新前向传播，保证可视化与真实张量一致
    return LM.forward(S.model, S.seq);
  }
  let cache = null;

  function startGeneration() {
    if (!S.trained) return;
    cache = currentCache();
    stepIdx = 0; stepT = 0;
    S.phase = 'run';
    S.playing = true;
    updateHUD();
  }

  function advance() {
    // 推进步骤时间
    stepT += 16.7 * S.speed;
    const st = STEPS[stepIdx];
    if (stepT >= st.ms) {
      stepT -= st.ms;
      stepIdx++;
      if (stepIdx >= STEPS.length) {
        stepIdx = 0;
        onGenerationComplete();
      }
    }
  }

  function onGenerationComplete() {
    if (!S.trained) return;
    // 用真实采样推进一个 token
    const c = LM.forward(S.model, S.seq);
    const r = LM.sample(S.model, c, S.seq.length - 1, { temp: 0.85, topP: 0.92, topK: 8, seed: S.step * 977 + 13 });
    S.lastSample = r;
    S.seq.push(r.pick);
    if (S.seq.length > CFG.CTX) S.seq = S.seq.slice(S.seq.length - CFG.CTX);
    S.step++;
    cache = currentCache();
  }

  // ============================================================ 可视化更新
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function ramp(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

  // 注意力权重 → 颜色（浅色背景下用饱和度与明度共同编码）
  function attnColor(w) {
    const t = Math.min(1, Math.sqrt(w));
    const c = new THREE.Color(PAL.line).lerp(new THREE.Color(PAL.jade), t);
    return c;
  }

  function updateVisuals(now) {
    if (!S.trained || !cache) return;
    const st = STEPS[stepIdx];
    const p = Math.min(1, stepT / st.ms);
    const n = S.seq.length;

    // ---- token 芯片 ----
    for (let i = 0; i < Math.max(n, CFG.CTX); i++) {
      const m = getTokenMesh(i);
      const lb = getTokenLabel(i);
      if (i < n) {
        m.visible = true; lb.visible = true;
        const x = tokenX(i, n);
        const isNew = i === n - 1 && S.lastSample && i === S.seq.length - 1;
        const pulse = isNew ? 1 + 0.16 * Math.sin(now * 0.006) : 1;
        m.position.set(x, LAY.tokenY, 0);
        m.scale.set(pulse, pulse, 1);
        m.material.color.setHex(isNew ? PAL.amber : PAL.jadeLo);
        lb.position.set(x, LAY.tokenY + 0.72, 0);
        setLabel(lb, LM.detok(S.seq[i]), isNew ? '#b85c38' : '#2b2723');
      } else {
        m.visible = false; lb.visible = false;
      }
    }
    // 提示词行
    promptLabel.visible = true;
    promptLabel.position.set(0, LAY.tokenY - 1.5, 0);
    setLabel(promptLabel, '输入序列: ' + S.seq.slice(0, S.prompt.length).map(LM.detok).join(' '), '#2b2723', '#fffdf9');

    // ---- Embedding ----
    const showEmb = st.id === 'embed';
    const embP = showEmb ? easeInOut(p) : (stepIdx > 0 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const id = S.seq[i];
      const x = tokenX(i, n);
      for (let d = 0; d < D; d++) {
        const bar = getEmbBar(i, d);
        const appear = i / Math.max(1, n) <= embP;
        bar.visible = appear;
        if (!appear) continue;
        const val = S.model ? 0 : 0;
        void val;
        const local = Math.min(1, Math.max(0, (embP * n - i) * 4));
        bar.position.set(x, LAY.embedY + 0.2 + d * 0.055, 2.4);
        bar.scale.set(1, (0.15 + local * 0.85) * 0.5, 1);
      }
    }

    // ---- 注意力 beams（每层）----
    let beamCursor = 0;
    for (let l = 0; l < NL; l++) {
      const LC = cache.layers[l];
      const T = cache.T;
      const attnStep = st.id === 'attn' || st.id === 'attnVisual';
      const isCurLayer = st.layer === l;
      for (let h = 0; h < NH; h++) {
        const sb = h * T * T;
        for (let t = 0; t < T; t++) {
          for (let s = 0; s <= t; s++) {
            const w = LC.probs[sb + t * T + s];
            if (w < 0.02) continue;
            const line = getBeam(beamCursor++);
            const x1 = tokenX(s, n), x2 = tokenX(t, n);
            const y = layerY(l) + 0.3 + h * 0.045;
            const pos = line.geometry.attributes.position.array;
            pos[0] = x1; pos[1] = y; pos[2] = -0.9;
            pos[3] = x2; pos[4] = y; pos[5] = 0.9;
            line.geometry.attributes.position.needsUpdate = true;
            const gate = isCurLayer ? (attnStep ? easeInOut(p) : 0.25) : (stepIdx > indexOfAfterLayer(l) ? 0.12 : 0);
            line.material.opacity = Math.min(0.92, w * 2.2) * gate;
            line.material.color.copy(attnColor(w));
            line.visible = line.material.opacity > 0.01;
          }
        }
      }
    }
    // 隐藏多余 beam
    for (let i = beamCursor; i < beamPool.length; i++) beamPool[i].visible = false;

    // ---- 注意力矩阵 ----
    for (let l = 0; l < NL; l++) {
      const M = matrices[l];
      const show = S.showMatrix && (st.id === 'attn' || st.id === 'attnVisual') && st.layer === l;
      M.holder.visible = show;
      if (!show) continue;
      const LC = cache.layers[l], T = cache.T;
      const prog = st.id === 'attn' ? easeInOut(p) : 1;
      for (let i = 0; i < M.T0; i++) {
        for (let j = 0; j < M.T0; j++) {
          const cell = M.cells[i * M.T0 + j];
          if (i >= T || j >= T || j > i) { cell.visible = false; continue; }
          cell.visible = true;
          // 按时间顺序逐格点亮
          const order = (i * (i + 1)) / 2 + j;
          const total = (T * (T + 1)) / 2;
          const lit = order / total <= prog;
          let w = LC.probs[i * T + j];
          if (!lit) w = 0;
          cell.material.color.copy(attnColor(w));
          cell.material.opacity = 0.22 + Math.min(0.75, w * 1.9);
          const s = 1 + (lit && w > 0.12 ? 0.22 : 0);
          cell.scale.set(s, s, s);
        }
      }
    }

    // ---- MLP 神经元 ----
    for (let l = 0; l < NL; l++) {
      const Gm = mlpGroups[l];
      const show = S.showHeat && (st.id === 'mlp' || st.id === 'mlpVisual') && st.layer === l;
      Gm.g.visible = show;
      if (!show) continue;
      const LC = cache.layers[l], T = cache.T;
      const prog = st.id === 'mlp' ? easeInOut(p) : 1;
      const row = Math.min(T - 1, T - 1);
      const act = LC.hact.subarray(row * FF, row * FF + FF);
      for (let i = 0; i < FF; i++) {
        const nn = Gm.neurons[i];
        const a = act[i];
        const lit = (i + 1) / FF <= prog + 0.001;
        const mag = Math.max(-1, Math.min(1, a * 1.6));
        const c = mag >= 0
          ? new THREE.Color(PAL.amber).lerp(new THREE.Color(PAL.rust), mag)
          : new THREE.Color(PAL.amber).lerp(new THREE.Color(PAL.teal), -mag);
        nn.material.color.copy(lit ? c : new THREE.Color(PAL.line));
        nn.material.opacity = lit ? 0.95 : 0.28;
        const s = lit ? 1 + Math.min(1.1, Math.abs(a) * 1.3) : 1;
        nn.scale.set(s, s, s);
        nn.position.y = 0.25 + (lit ? Math.min(0.7, Math.abs(a) * 0.5) : 0);
      }
    }

    // ---- logits 条 ----
    const showHead = st.id === 'lmhead' || st.id === 'softmax' || st.id === 'topp' || st.id === 'emit';
    logitGroup.visible = showHead;
    if (showHead) {
      const last = cache.T - 1;
      const lg = cache.logits.subarray(last * V, last * V + V);
      let mx = -Infinity; for (let v = 0; v < V; v++) if (lg[v] > mx) mx = lg[v];
      const ex = new Float64Array(V); let z = 0;
      for (let v = 0; v < V; v++) { ex[v] = Math.exp(lg[v] - mx); z += ex[v]; }
      const pr = new Float64Array(V); for (let v = 0; v < V; v++) pr[v] = ex[v] / z;
      const progMap = { lmhead: easeInOut(p) * 0.4, softmax: 0.4 + easeInOut(p) * 0.3, topp: 0.7 + easeInOut(p) * 0.2, emit: 0.9 + easeInOut(p) * 0.1 };
      const prog = progMap[st.id] || 0;
      let top = 0; for (let v = 1; v < V; v++) if (pr[v] > pr[top]) top = v;
      for (let v = 0; v < V; v++) {
        const b = logitBars[v];
        const hgt = st.id === 'lmhead' ? Math.max(0.05, (lg[v] - mx + 6) / 12) : pr[v] * 3.4;
        b.scale.set(1, Math.max(0.04, hgt), 1);
        b.position.y = Math.max(0.05, hgt) / 2 + 0.02;
        const inProg = (v / V) <= prog;
        b.material.opacity = inProg ? 0.92 : 0.25;
        b.material.color.setHex(v === top && inProg ? PAL.amber : PAL.rust);
      }
    }

    // ---- 层高亮 ----
    G.layers.forEach((g, l) => {
      const on = st.layer === l;
      g.children[0].material.opacity = on ? 0.72 : 0.34;
      g.children[1].material.opacity = on ? 1.0 : 0.45;
      g.scale.y = on ? 1 : 0.985;
    });

    // ---- 流动粒子 ----
    G.flow.visible = S.playing;
    if (S.playing) {
      for (let i = 0; i < FLOW_N; i++) {
        const sd = flowSeed[i];
        const tt = (now * 0.00022 * S.speed + sd) % 1;
        const yTop = layerY(NL - 1) + 6.6, yBot = LAY.tokenY;
        const y = lerp(yBot, yTop, tt);
        // 沿token 列之间流动，形成"数据向上传输"的通道感
        const lane = ((i % 12) / 11 - 0.5);
        const cx = lane * (n - 1 > 0 ? (n - 1) * TOK_SP * 0.5 : 3) + Math.sin(sd * 17 + tt * 6.0) * 0.16;
        const spread = 0.18 + 0.22 * Math.sin(tt * Math.PI);
        flowPos[i * 3] = cx;
        flowPos[i * 3 + 1] = y;
        flowPos[i * 3 + 2] = Math.cos(sd * 47 + tt * 5.0) * spread;
      }
      flowGeo.attributes.position.needsUpdate = true;
      flowMat.opacity = 0.16 + 0.12 * Math.sin(now * 0.002);
    }

    // ---- 层进度面板 ----
    for (let l = 0; l < NL; l++) {
      if (st.layer === l) setLayerProgress(l, p, `${Math.round(p * 100)}%`);
      else if (indexOfAfterLayer(l) < stepIdx) setLayerProgress(l, 1, 'done');
      else setLayerProgress(l, 0, '—');
    }
  }

  function indexOfAfterLayer(l) {
    // 该层之后第一个步骤的索引
    for (let i = 0; i < STEPS.length; i++) {
      if (STEPS[i].layer === l && STEPS[i].id === 'norm1') return i + 8;
    }
    return STEPS.length;
  }

  // ============================================================ HUD
  function updateHUD() {
    const st = STEPS[stepIdx];
    const p = Math.min(1, stepT / st.ms);
    el.stage.textContent = st.name;
    el.formula.innerHTML = st.formula;
    el.stepPill.textContent = `步骤 ${stepIdx + 1}/${STEPS.length} · ${(p * 100).toFixed(0)}%`;
    el.desc.textContent = DESC[st.id] || '';
    el.tokOut.textContent = S.seq.map(LM.detok).join('');
  }
  const DESC = {
    embed: '每个 token id 查 embedding 表，得到一个 32 维稠密向量——离散符号在此刻变成了连续数字。',
    pos: '旋转位置编码把位置信息编织进 Q/K，让注意力能分辨"谁在前谁在后"。',
    norm1: 'RMSNorm 把向量拉回单位尺度，避免深层网络的数值爆炸。',
    qkv: '三个线性投影把归一化后的向量分别变成 Query、Key、Value。',
    attn: '每个位置与之前所有位置算相似度，缩放后 softmax，加权求和 V。因果掩码确保看不到未来。',
    attnVisual: '矩阵里每个格子都是一个真实的 softmax 概率，颜色越深表示该位置关注得越多。',
    res1: '注意力输出与原输入相加——残差让梯度有一条"高速通道"。',
    norm2: '进入 MLP 前再次归一化。',
    mlp: '升维到 64 维、GELU 非线性、再降回 32 维。参数量的大头在这里。',
    mlpVisual: '每个球是一个隐层神经元，颜色代表激活强度，向上凸起代表激活幅度。',
    res2: 'MLP 输出再次残差相加。',
    finalNorm: '最后一层输出后再做一次归一化。',
    lmhead: '归一化向量乘以输出矩阵，得到词表中每个 token 的原始分数。',
    softmax: '分数除以温度后转成概率分布。',
    topp: '按概率降序累积，累计超过阈值即截断，只在小集合里采样。',
    emit: '按分布采出一个 token，追加到序列末尾，然后开始下一轮。',
  };

  // ============================================================ 相机
  function applyCam(mode, instant) {
    const top = layerY(NL - 1) + 6.6;
    const cy = (LAY.tokenY + top) / 2;
    const spanY = top - LAY.tokenY;
    // 每个预设：目标点 + 球坐标(theta, phi, r)，r 按整体高度自适应
    const T = {
      overview: { tgt: [0, cy, 0], theta: 0.52, phi: 1.30, r: spanY * 1.5 + 11 },
      layer: { tgt: [0, layerY(0), 0], theta: 0.42, phi: 0.98, r: 17 },
      matrix: { tgt: [-7.6, layerY(0) + 0.2, 0], theta: 0.0, phi: 0.45, r: 9.5 },
      mlp: { tgt: [7.9, layerY(0) + 0.2, 0], theta: 0.3, phi: 0.55, r: 11.5 },
      head: { tgt: [0, layerY(NL - 1) + 5.6, 0], theta: 0.5, phi: 1.02, r: 12 },
      tokens: { tgt: [0, 2.0, 0], theta: 0.7, phi: 1.22, r: 11 },
    };
    const t = T[mode] || T.overview;
    // 一次性把目标点与球坐标交给控制器，避免 target 与位置不同步
    controls.setSpherical(t.theta, t.phi, t.r, { x: t.tgt[0], y: t.tgt[1], z: t.tgt[2] });
  }

  // ============================================================ 交互
  document.querySelectorAll('[data-cam]').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('[data-cam]').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      S.camMode = b.dataset.cam;
      applyCam(S.camMode);
    });
  });
  const playBtn = document.getElementById('play');
  playBtn.addEventListener('click', () => {
    S.playing = !S.playing;
    playBtn.textContent = S.playing ? '⏸ 暂停' : '▶ 播放';
    playBtn.classList.toggle('on', S.playing);
  });
  const stepBtn = document.getElementById('stepBtn');
  stepBtn.addEventListener('click', () => { stepT = STEPS[stepIdx].ms; });
  const spd = document.getElementById('speed');
  spd.addEventListener('input', () => {
    S.speed = parseFloat(spd.value);
    document.getElementById('speedVal').textContent = S.speed.toFixed(1) + '×';
  });
  const mtx = document.getElementById('mtx');
  mtx.addEventListener('change', () => { S.showMatrix = mtx.checked; });
  const heat = document.getElementById('heat');
  heat.addEventListener('change', () => { S.showHeat = heat.checked; });
  const rm = document.getElementById('rm');
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    S.reduceMotion = true; rm.checked = true;
  }
  rm.addEventListener('change', () => { S.reduceMotion = rm.checked; if (rm.checked) applyCam(S.camMode, true); });

  // ============================================================ resize
  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);

  // ============================================================ 主循环
  let last = performance.now();
  function loop(now) {
    requestAnimationFrame(loop);
    const dt = now - last; last = now;
    if (S.trained && S.playing && !S.reduceMotion) advance();
    controls.update();
    updateVisuals(now);
    updateHUD();
    renderer.render(scene, camera);
  }

  // ============================================================ 启动
  resize();
  applyCam('overview', true);
  // 预置相机标签高度（makeTextSprite 已写入 userData.hh，此处无需再遍历）
  requestAnimationFrame(loop);
  startTraining();

  // ============================================================ 对外调试接口
  window.__viz = {
    S, STEPS, applyCam, LM,
    gotoStep: function (i, frac) {
      stepIdx = Math.max(0, Math.min(STEPS.length - 1, i));
      stepT = STEPS[stepIdx].ms * (frac === undefined ? 0.5 : frac);
      S.playing = false;
      const b = document.getElementById('play');
      if (b) { b.textContent = '▶ 播放'; b.classList.remove('on'); }
    },
  };
})();