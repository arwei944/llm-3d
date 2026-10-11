/* =============================================================================
 * viz-train.js —— 训练全流程可视化
 * 展示闭环：采样批次 → 前向 → 交叉熵损失 → 反向传播（梯度逐层下流）
 *          → 梯度裁剪 → AdamW 更新权重 → loss 曲线下降 → 重复
 * 所有数值来自真实 trainStep()，包括梯度范数、裁剪系数、权重变化量。
 * ========================================================================== */
(function () {
  'use strict';

  const LM = window.TinyLM;
  const CFG = LM.CFG;
  const { V, D, NH, dh, FF, NL } = CFG;
  const { PAL, makeTextSprite, setLabel, roundedBoxGeo } = window.LLMCore;

  const S = {
    model: null,
    running: false,
    steps: 0,
    maxSteps: 2000,
    history: [],          // loss 历史
    last: null,           // 上一次 trainStep 的返回
    playing: true,
    speed: 1,
    phase: 'idle',
    reduceMotion: false,
  };

  // 训练步骤脚本（每个 epoch 内的一次迭代）
  const STEPS = [
    { id: 'batch', name: '① 采样训练批次', formula: '(x, y) ← 语料窗口', ms: 700 },
    { id: 'forward', name: '② 前向传播', formula: 'logits = f(x; θ)', ms: 900 },
    { id: 'loss', name: '③ 计算交叉熵损失', formula: 'L = -log p(y|x)', ms: 800 },
    { id: 'backward', name: '④ 反向传播 ∂L/∂θ', formula: '链式法则，从输出层逐层回传', ms: 1300 },
    { id: 'clip', name: '⑤ 梯度裁剪', formula: 'g ← g · min(1, c/‖g‖)', ms: 650 },
    { id: 'adam', name: '⑥ AdamW 更新权重', formula: 'θ ← θ - η·(m̂/(√v̂+ε) + λθ)', ms: 1100 },
    { id: 'record', name: '⑦ 记录 loss，下一轮', formula: 'θ 已改变 → 重新前向', ms: 600 },
  ];
  let stepIdx = 0, stepT = 0;

  function boot(core) {
    const scene = core.scene, camera = core.camera, controls = core.controls;
    const root = new THREE.Group();
    scene.add(root);

    // ---------------------------------------------------- 布局
    const W = 20;
    /* 五块板等间距 5.5。原来是 5.5/6.0/4.0/5.0 不均匀，
     * 其中「损失→反向」只有 4.0：拍损失那一幕时，反向传播板的梯度柱
     * 会从画面上方压下来抢焦点（实测占了近三分之一屏）。 */
    const yBatch = 0, yFwd = 5.5, yLoss = 11.0, yBack = 16.5, yOpt = 22.0;

    function plate(y, w, h, title) {
      const g = new THREE.Group();
      g.position.y = y;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ color: PAL.slab, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2; g.add(m);
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(w, h)),
        new THREE.LineBasicMaterial({ color: PAL.edge, transparent: true, opacity: 0.9 }));
      e.rotation.x = -Math.PI / 2; g.add(e);
      const t = makeTextSprite(title, { h: 0.55, size: 50, color: '#2b2723' });
      t.position.set(-w / 2 + 2.6, 0.3, -h / 2 + 0.5);
      g.add(t);
      root.add(g);
      return g;
    }

    // ---------------------------------------------------- ① 批次
    const gBatch = plate(yBatch, W, 6.5, '① 训练批次 (输入 x / 目标 y)');
    const batchCells = [];
    for (let i = 0; i < CFG.CTX; i++) {
      const m = new THREE.Mesh(roundedBoxGeo(0.95, 0.62, 0.18, 0.14),
        new THREE.MeshBasicMaterial({ color: PAL.jadeLo, transparent: true, opacity: 0.95 }));
      m.position.set((i - (CFG.CTX - 1) / 2) * 1.12, 0, -1.1);
      gBatch.add(m);
      const lbl = makeTextSprite('', { h: 0.42, size: 52 });
      lbl.position.set((i - (CFG.CTX - 1) / 2) * 1.12, 0.5, -1.1);
      gBatch.add(lbl);
      batchCells.push({ m, lbl });
    }
    // 目标行（右移一格，体现"预测下一个"）
    const tgtCells = [];
    for (let i = 0; i < CFG.CTX; i++) {
      const m = new THREE.Mesh(roundedBoxGeo(0.95, 0.62, 0.18, 0.14),
        new THREE.MeshBasicMaterial({ color: PAL.amber, transparent: true, opacity: 0.95 }));
      m.position.set((i - (CFG.CTX - 1) / 2) * 1.12, 0, 1.35);
      gBatch.add(m);
      const lbl = makeTextSprite('', { h: 0.42, size: 52, color: '#8a5a1e' });
      lbl.position.set((i - (CFG.CTX - 1) / 2) * 1.12, 0.5, 1.35);
      gBatch.add(lbl);
      tgtCells.push({ m, lbl });
    }

    // ---------------------------------------------------- ② 前向（简化层栈）
    const gFwd = plate(yFwd, W, 6.0, '② 前向传播');
    const fwdLayers = [];
    for (let l = 0; l < NL; l++) {
      const g = new THREE.Group();
      // 两块层块间距 4.6（原 6.0）：间距太大时想框住整块内容就得把相机拉远，
      // 而下一块板（间距只有 5.5）就会被一起收进画面、抢掉焦点。
      g.position.set((l - (NL - 1) / 2) * 4.6, 0.1, 0);
      const box = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.35, 3.4),
        new THREE.MeshBasicMaterial({ color: PAL.line, transparent: true, opacity: 0.7 }));
      g.add(box);
      const t = makeTextSprite(`层 ${l + 1}`, { h: 0.4, size: 44, color: '#6b6259' });
      t.position.set(0, 0.5, 0);
      g.add(t);
      gFwd.add(g);
      fwdLayers.push({ g, box });
    }

    // ---------------------------------------------------- ③ 损失
    const gLoss = plate(yLoss, W, 6.0, '③ 交叉熵损失 L = -log p(y)');
    const lossBar = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: PAL.rust, transparent: true, opacity: 0.92 }));
    lossBar.position.set(-5, 0.5, 0);
    gLoss.add(lossBar);
    const lossLabel = makeTextSprite('L = —', { h: 0.5, size: 48, color: '#b85c38' });
    lossLabel.position.set(-5, 2.2, 0);
    gLoss.add(lossLabel);
    // 目标 token 的概率条：p 越高损失越低
    const pBar = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: PAL.jade, transparent: true, opacity: 0.92 }));
    pBar.position.set(2, 0.5, 0);
    gLoss.add(pBar);
    const pLabel = makeTextSprite('p(y) = —', { h: 0.5, size: 48, color: '#2f7d63' });
    pLabel.position.set(2, 2.2, 0);
    gLoss.add(pLabel);

    // ---------------------------------------------------- ④ 反向传播（梯度柱）
    const gBack = plate(yBack, W, 7.0, '④ 反向传播：逐层梯度范数 ‖∂L/∂θ‖');
    const gradBars = [];
    const gradLabels = [];
    // 顺序：LM Head → L2 → L1 → Embedding（从输出到输入）
    const gradNames = ['LM Head', ...Array.from({ length: NL }, (_, i) => `层 ${NL - i}`), 'Embedding'];
    for (let i = 0; i < gradNames.length; i++) {
      const x = (i - (gradNames.length - 1) / 2) * 3.4;
      const bar = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1, 1.6),
        new THREE.MeshBasicMaterial({ color: PAL.violet, transparent: true, opacity: 0.9 }));
      bar.position.set(x, 0.5, 0);
      gBack.add(bar);
      const lbl = makeTextSprite(gradNames[i], { h: 0.38, size: 42, color: '#6b6259' });
      lbl.position.set(x, 0.18, 2.2);
      gBack.add(lbl);
      gradBars.push(bar); gradLabels.push(lbl);
    }
    // 梯度流向粒子（从上往下）
    const GN = 90;
    const gGeo = new THREE.BufferGeometry();
    const gPos = new Float32Array(GN * 3);
    gGeo.setAttribute('position', new THREE.BufferAttribute(gPos, 3));
    const gMat = new THREE.PointsMaterial({ size: 0.2, color: PAL.violet, transparent: true, opacity: 0.6, depthWrite: false });
    const gPts = new THREE.Points(gGeo, gMat);
    gPts.frustumCulled = false;
    gBack.add(gPts);
    const gSeed = Array.from({ length: GN }, () => Math.random());

    // ---------------------------------------------------- ⑤⑥ 优化器 / 权重
    const gOpt = plate(yOpt, W, 7.0, '⑤⑥ 梯度裁剪 → AdamW 更新权重');
    // 权重立方体：取 W1 的 8×8 块，高度/颜色 = 真实权重值
    const WN = 8;
    const wCells = [];
    for (let i = 0; i < WN * WN; i++) {
      const c = new THREE.Mesh(new THREE.BoxGeometry(0.34, 1, 0.34),
        new THREE.MeshBasicMaterial({ color: PAL.teal, transparent: true, opacity: 0.9 }));
      const r = Math.floor(i / WN), cc = i % WN;
      c.position.set((cc - (WN - 1) / 2) * 0.44 - 5.5, 0.3, (r - (WN - 1) / 2) * 0.44);
      gOpt.add(c);
      wCells.push(c);
    }
    const wLabel = makeTextSprite('W₁ (前 8×8，真实权重)', { h: 0.4, size: 42, color: '#3d8f9c' });
    wLabel.position.set(-5.5, 2.0, 0);
    gOpt.add(wLabel);
    // 裁剪 + 学习率信息
    const clipLabel = makeTextSprite('‖g‖ = —   clip = —', { h: 0.45, size: 46, color: '#7a6bab' });
    clipLabel.position.set(2.6, 1.6, 0);
    gOpt.add(clipLabel);
    const adamLabel = makeTextSprite('η = —   step = —', { h: 0.45, size: 46, color: '#6b6259' });
    adamLabel.position.set(2.6, 0.9, 0);
    gOpt.add(adamLabel);
    // 动量/二阶矩示意（两个小立方体阵列）
    const momCells = [];
    for (let i = 0; i < 16; i++) {
      const c = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1, 0.3),
        new THREE.MeshBasicMaterial({ color: PAL.amber, transparent: true, opacity: 0.75 }));
      c.position.set(2.6 + (i % 4) * 0.42 - 0.63, 0.2, Math.floor(i / 4) * 0.42 - 0.9);
      gOpt.add(c);
      momCells.push(c);
    }

    // ---------------------------------------------------- loss 曲线（3D 折线）
    const curveGroup = new THREE.Group();
    curveGroup.position.set(0, yOpt + 5.0, 0);
    root.add(curveGroup);
    const CURVE_N = 200;
    const cGeo = new THREE.BufferGeometry();
    const cPos = new Float32Array(CURVE_N * 3);
    cGeo.setAttribute('position', new THREE.BufferAttribute(cPos, 3));
    const cLine = new THREE.Line(cGeo, new THREE.LineBasicMaterial({ color: PAL.jade, transparent: true, opacity: 0.95 }));
    cLine.frustumCulled = false;
    curveGroup.add(cLine);
    const curveLabel = makeTextSprite('训练 loss 曲线', { h: 0.5, size: 46, color: '#2f7d63' });
    curveLabel.position.set(-7, 3.2, 0);
    curveGroup.add(curveLabel);
    const curveVal = makeTextSprite('—', { h: 0.45, size: 44, color: '#b85c38' });
    // 放在曲线右端内侧：贴到 x=7 时会被画面右边缘裁掉
    curveVal.position.set(5.0, 3.2, 0);
    curveGroup.add(curveVal);

    // ---------------------------------------------------- 相机预设
    /* 与 viz-forward 同策略：直接标定「目标点 + 距离 r」，
     * r 是 16:9 下用取景探针实测出来的（fitR 那套"内容箱"对斜俯视的平面不准，
     * 会把距离估得偏远，内容就又小又偏）。
     * 另一处关键修正：板子上的内容（柱子、标签、立方体）是**立在板面之上**的，
     * 相机若对准板面 y，内容就会整体偏到画面中心上方甚至顶出画外 ——
     * 所以目标点抬到内容的中高位置（板面 y + 约 1.1）。 */
    const REF_A = 16 / 9;
    /* 下面各 tgt/r 是 solve-cams.js 在 1920×1080 下迭代求出来的：
     * 内容包围盒中心精确落在 (960,572)，最大边占宽/占高如注释所示。 */
    const cams = {
      overview: { tgt: [-0.56, 15.44, -1.28], theta: 0.50, phi: 1.16, r: 47.5 },
      batch: { tgt: [2.08, -0.58, -0.43], theta: 0.55, phi: 1.05, r: 11.6 },
      forward: { tgt: [-0.72, 5.63, 0.61], theta: 0.50, phi: 1.02, r: 8.1 },
      /* forwardTight：㉑「前向传播」用。下一块批次板只低 5.5，框太宽就会一起入镜，
       * 所以层块间距收窄（4.6）+ 相机拉近到 5.4，让两块层块填满画面、批次板只露一条边。 */
      forwardTight: { tgt: [-0.30, 6.00, 0.15], theta: 0.50, phi: 1.05, r: 5.4 },
      loss: { tgt: [-1.78, 12.61, 0.19], theta: 0.45, phi: 1.02, r: 9.0 },
      backward: { tgt: [-1.35, 18.15, 0.01], theta: 0.50, phi: 0.98, r: 16.6 },
      optim: { tgt: [-1.89, 22.48, -0.65], theta: 0.55, phi: 0.92, r: 14.9 },
      curve: { tgt: [0.96, 30.09, -1.06], theta: 0.42, phi: 1.35, r: 9.1 },
    };
    function resolveCam(mode) {
      const t = cams[mode] || cams.overview;
      const a = camera.aspect || REF_A;
      return { theta: t.theta, phi: t.phi, r: t.r * Math.min(1.45, Math.max(1, REF_A / a)), tgt: t.tgt };
    }
    function applyCam(mode) {
      const t = resolveCam(mode);
      controls.setSpherical(t.theta, t.phi, t.r, { x: t.tgt[0], y: t.tgt[1], z: t.tgt[2] });
    }
    function applyCamAt(theta, phi, r, tgt) {
      controls.setSpherical(theta, phi, r, { x: tgt[0], y: tgt[1], z: tgt[2] });
    }

    // ---------------------------------------------------- 真实训练推进
    function doStep() {
      if (!S.model) return;
      const r = LM.trainStep(S.model, { batch: 1, lr: 3e-3, seed: 7, clip: 0.5 });
      S.last = r;
      S.steps = r.step;
      S.history.push(r.loss);
      if (S.history.length > CURVE_N) S.history.shift();
    }

    function advance(dt) {
      if (!S.playing || !S.model) return;
      stepT += dt;
      const st = STEPS[stepIdx];
      if (stepT >= st.ms / Math.max(0.25, S.speed)) {
        stepT = 0;
        stepIdx++;
        if (stepIdx >= STEPS.length) {
          stepIdx = 0;
          doStep();                       // 一轮结束 → 真实训练一步
          if (S.steps >= S.maxSteps) { S.running = false; }
        }
      }
    }

    // ---------------------------------------------------- 每帧更新
    function update(now) {
      if (!S.model) return;
      const st = STEPS[stepIdx];
      const p = Math.min(1, stepT / (st.ms / Math.max(0.25, S.speed)));
      const last = S.last;

      // ① 批次：显示真实采样窗口
      const ids = last ? last.ids : null;
      for (let i = 0; i < CFG.CTX; i++) {
        const bc = batchCells[i], tc = tgtCells[i];
        if (ids && st.id !== 'batch' || ids) {
          const show = st.id === 'batch' ? (i / CFG.CTX <= p) : true;
          bc.m.visible = show; bc.lbl.visible = show;
          tc.m.visible = show && i > 0; tc.lbl.visible = show && i > 0;
          if (show) setLabel(bc.lbl, LM.detok(ids[i]), '#2b2723');
          if (show && i > 0) setLabel(tc.lbl, LM.detok(ids[i]), '#8a5a1e');
        } else { bc.m.visible = false; bc.lbl.visible = false; tc.m.visible = false; tc.lbl.visible = false; }
      }

      // ② 前向：层块依次点亮
      for (let l = 0; l < NL; l++) {
        const on = st.id === 'forward' ? ((l + 1) / NL <= p + 0.001) : true;
        fwdLayers[l].box.material.color.setHex(on ? PAL.jade : PAL.line);
        fwdLayers[l].box.material.opacity = on ? 0.85 : 0.35;
        fwdLayers[l].box.scale.y = on ? 1.6 : 1;
      }

      // ③ 损失
      const loss = last ? last.loss : 0;
      const pv = last ? last.predProb : 0;
      const lossH = Math.min(4.2, Math.max(0.05, (loss - 1.6) * 1.5));
      lossBar.scale.y = lossH; lossBar.position.y = lossH / 2;
      lossBar.material.color.setHex(PAL.rust);
      setLabel(lossLabel, `L = ${loss.toFixed(4)}`, '#b85c38');
      const pH = Math.min(4.2, Math.max(0.05, pv * 4.2));
      pBar.scale.y = pH; pBar.position.y = pH / 2;
      setLabel(pLabel, `p(y) = ${(pv * 100).toFixed(1)}%`, '#2f7d63');

      // ④ 梯度柱：真实各块梯度范数
      const gb = LM.gradNormPerBlock(S.model);
      for (let i = 0; i < gradBars.length; i++) {
        const v = gb[i] ? gb[i].v : 0;
        const h = Math.min(4.0, Math.max(0.06, v * 3.2));
        gradBars[i].scale.y = h; gradBars[i].position.y = h / 2;
        const fade = st.id === 'backward' ? (i / gradBars.length <= p + 0.001 ? 1 : 0.25) : 0.85;
        gradBars[i].material.opacity = fade;
      }
      // 梯度粒子从上往下流
      gPts.visible = !S.reduceMotion && (st.id === 'backward' || st.id === 'clip');
      if (gPts.visible) {
        for (let i = 0; i < GN; i++) {
          const sd = gSeed[i];
          const tt = (now * 0.00035 * S.speed + sd) % 1;
          gPos[i * 3] = (sd * 2 - 1) * 9;
          gPos[i * 3 + 1] = 4.5 - tt * 4.5;      // 从上往下
          gPos[i * 3 + 2] = Math.sin(sd * 31 + tt * 6) * 1.2;
        }
        gGeo.attributes.position.needsUpdate = true;
        gMat.opacity = 0.35 + 0.25 * Math.sin(now * 0.004);
      }

      // ⑤⑥ 权重真实值（取 W1 前 8×8）
      const W1 = S.model.blocks[0].W1;
      for (let i = 0; i < WN * WN; i++) {
        const r = Math.floor(i / WN), cc = i % WN;
        const w = W1[r * D + cc] || 0;
        const h = Math.min(2.2, Math.max(0.06, Math.abs(w) * 14));
        wCells[i].scale.y = h; wCells[i].position.y = h / 2 + 0.05;
        const t = Math.min(1, Math.abs(w) * 9);
        wCells[i].material.color.copy(new THREE.Color(PAL.line).lerp(new THREE.Color(w >= 0 ? PAL.teal : PAL.rust), t));
      }
      // 动量示意：用真实的 Adam 一阶矩绝对值
      const momA = S.model._adam ? S.model._adam.mom.b0.W1 : null;
      for (let i = 0; i < momCells.length; i++) {
        const v = momA ? Math.abs(momA[i] || 0) : 0;
        const h = Math.min(1.4, Math.max(0.06, v * 120));
        momCells[i].scale.y = h; momCells[i].position.y = h / 2 + 0.06;
      }
      setLabel(clipLabel, `‖g‖ = ${(last ? last.gnorm : 0).toFixed(3)}   clip = ${(last ? last.clipScale : 1).toFixed(3)}`, '#7a6bab');
      setLabel(adamLabel, `η = ${(last ? last.lr : 0).toFixed(5)}   step = ${S.steps}`, '#6b6259');

      // loss 曲线：x 按「当前已有历史」铺满整宽（早期只有几个点时也能看清走势），
      // 历史攒满 CURVE_N 后即等价于按固定窗口铺满。
      // y 用固定参考带 [0.2, 3.0] 映射到 [0, 3.2]：
      // 随机基线是 ln(12)≈2.48，训好后会落到 0.5 附近，正好铺满这个量程。
      const H = S.history;
      const span = Math.max(1, Math.min(H.length, CURVE_N) - 1);
      for (let i = 0; i < CURVE_N; i++) {
        if (i < H.length) {
          const x = (i / span) * 14 - 7;
          const y = Math.min(3.2, Math.max(0, (H[i] - 0.2) * 1.3));
          cPos[i * 3] = x; cPos[i * 3 + 1] = y; cPos[i * 3 + 2] = 0;
        } else {
          // 未用到的顶点停在曲线自身的范围里（x=7 是右端、y=0 是基线）。
          // 以前停在 y=-99 靠 setDrawRange 裁掉 —— 画面上没问题，
          // 但会把几何包围盒撑到 100 单位以上，任何"按包围盒取景"的逻辑全废。
          cPos[i * 3] = 7; cPos[i * 3 + 1] = 0; cPos[i * 3 + 2] = 0;
        }
      }
      cGeo.attributes.position.needsUpdate = true;
      cGeo.setDrawRange(0, Math.max(1, H.length));
      if (H.length) setLabel(curveVal, `${H[H.length - 1].toFixed(4)} (step ${S.steps})`, '#b85c38');
    }

    function getHud() {
      const st = STEPS[stepIdx];
      const p = Math.min(1, stepT / (st.ms / Math.max(0.25, S.speed)));
      return {
        stage: st.name, desc: DESC[st.id] || '', formula: st.formula,
        pill: `迭代 ${S.steps}/${S.maxSteps} · ${(p * 100).toFixed(0)}%`,
        progress: p,
      };
    }

    const DESC = {
      batch: '从语料里切一个窗口：x 是输入，y 是"下一个 token"。监督信号就来自序列本身，不需要人工标注。',
      forward: '和推理时完全相同的计算：嵌入 → 各层注意力与 MLP → 输出头 → logits。训练与推理共用一条前向路径。',
      loss: '把正确 token 的概率取 -log。概率越接近 1，损失越接近 0；随机初始化的模型约 ln(12)≈2.48。',
      backward: '链式法则从损失出发，把梯度一路送回每一层的每个参数。这里柱子的高度就是各块真实的梯度范数。',
      clip: '若梯度范数超过阈值就整体缩放，防止深层网络的梯度爆炸。此处显示真实的 ‖g‖ 与裁剪系数。',
      adam: 'AdamW：用一阶矩（动量）和二阶矩（自适应步长）修正更新量，再做权重衰减。立方体是 W₁ 的真实权重。',
      record: '一步完成，参数已改变。回到①继续下一批次——训练就是把这个循环跑上成千上万次。',
    };

    return {
      S, STEPS, applyCam, applyCamAt, camTable: () => cams, resolveCam, update, getHud, advance,
      // 调试/测量钩子：暴露各层板与曲线组，供取景探针标定使用
      __boards: { batch: gBatch, fwd: gFwd, loss: gLoss, back: gBack, opt: gOpt, curve: curveGroup }, root,
      setModel: function (m) {
        S.model = m; S.history = []; S.steps = 0; S.running = true;
        stepIdx = 0; stepT = 0;
        // 先跑一步，让画面立刻有真实数据
        doStep();
      },
      /* 影片模式：确定性定位到「第 k 步训练之后」的状态。
       * doStep() 会真的改权重、无法回退，所以回到更早的步数时
       * 从同一种子的初始模型重放 —— initModel(7) + trainStep 全程确定性，
       * 重放结果与首次完全一致。 */
      seekToStep: function (k) {
        k = Math.max(0, k | 0);
        if (k >= S.steps) {
          while (S.steps < k) doStep();
        } else {
          S.model = LM.initModel(7);
          S.model._adam = null;
          S.history = []; S.steps = 0;
          while (S.steps < k) doStep();
        }
        S.running = true;
      },
      /* 影片模式：定位到某一阶段的某个进度 */
      seekPhase: function (phaseIdx, phaseFrac) {
        stepIdx = Math.max(0, Math.min(STEPS.length - 1, phaseIdx | 0));
        stepT = STEPS[stepIdx].ms * Math.max(0, Math.min(1, phaseFrac || 0));
        S.playing = false;
      },
      root,
    };
  }

  window.TrainViz = { boot: boot };
})();