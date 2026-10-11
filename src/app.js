/* =============================================================================
 * app.js —— 启动、模式调度、HUD 渲染、交互控制
 * 两个模式共用同一 renderer / camera：
 *   FwdViz   = 推理（前向传播逐原子步骤）
 *   TrainViz = 训练（采样→前向→损失→反向→裁剪→AdamW→loss 曲线）闭环
 * ========================================================================== */
(function () {
  'use strict';

  const LM = window.TinyLM;
  LM.CFG.NL = 2;

  const el = (id) => document.getElementById(id);
  const core = window.LLMCore.createScene(el('scene'));

  const fwd = window.FwdViz.boot(core);
  const train = window.TrainViz.boot(core);

  const App = {
    mode: 'fwd',          // 'fwd' | 'train'
    model: null,          // 推理用（已训练快照）
    trainModel: null,     // 训练模式用（从零开始）
    ref: window.LLM_TRACE_REF ? window.LLM_TRACE_REF.tensors : null,
    bootDone: false,
    cinema: { on: false },   // 影片模式（讲解动画）
    recFreeze: false,        // 录制态：主循环让出 CPU，画面只由导出脚本的 render() 决定
  };

  // ---------------------------------------------------------- 初始训练（分块，不卡死主线程）
  function bootTrain() {
    const m = LM.initModel(7);
    let done = 0;
    const TOTAL = 900, CHUNK = 60;
    function chunk() {
      for (let i = 0; i < CHUNK; i++) LM.trainStep(m, { batch: 1, lr: 3e-3, seed: 7, clip: 0.5 });
      done += CHUNK;
      const p = done / TOTAL;
      el('bootBar').style.width = (p * 100).toFixed(1) + '%';
      el('bootTxt').textContent = `训练微型 Transformer ${done}/${TOTAL}`;
      if (done >= TOTAL) {
        App.model = m;
        App.trainModel = LM.initModel(7);        // 训练模式：从零开始，展示学习过程
        fwd.setModel(m);
        train.setModel(App.trainModel);
        App.bootDone = true;
        el('loading').classList.add('hidden');
        el('statusDot').classList.remove('busy');
        renderTrace();
        // 科普引擎：注册内置模块后启动（explore/attn/kv/topics 已在各自文件里自注册）
        window.LLMEngine.register({ id: 'fwd', title: '推理', icon: 'gear', kind: 'viz3d', builtin: true, tagline: '前向传播 25 个原子步骤' });
        window.LLMEngine.register({ id: 'train', title: '训练', icon: 'flame', kind: 'viz3d', builtin: true, tagline: '真实训练闭环 7 阶段' });
        window.LLMEngine.boot({ model: App.model, core, LM, el }, 'fwd');
        setMode('fwd');
        if (window.LLMCine) window.LLMCine.seek(0);
        return;
      }
      requestAnimationFrame(chunk);
    }
    chunk();
  }

  // ---------------------------------------------------------- 模式切换（科普引擎托管新模块，fwd/train 保留原路径）
  function camButtons(mode) {
    return Array.from(document.querySelectorAll('.camrow[data-formode="' + mode + '"] [data-cam]'));
  }
  // 引擎托管模块的显隐收拾（切回 fwd/train 时调用）
  function hideEngineMods() {
    const eng = window.LLMEngine;
    if (!eng) return;
    for (const m of eng.list) {
      if (m.builtin) continue;
      const inst = eng.inst(m.id);
      if (!inst) continue;
      if (m.kind === 'viz3d' && inst.root) inst.root.visible = false;
      if (inst.el) inst.el.classList.add('hidden');
      if (inst.onHide) inst.onHide();
    }
    document.body.classList.remove('mod-overlay');
  }
  function setMode(mode, keepCam) {
    const eng = window.LLMEngine;
    const engineOwned = !!(eng && eng.has(mode) && mode !== 'fwd' && mode !== 'train');
    App.mode = mode;
    if (engineOwned) {
      // 引擎模块：藏掉老 root 与老视角行，其余交给引擎
      fwd.root.visible = false;
      train.root.visible = false;
      document.querySelectorAll('.camrow[data-formode="fwd"],.camrow[data-formode="train"]').forEach(r => { r.style.display = 'none'; });
      document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
      eng.show(mode, keepCam);
      const mod = eng.list.find(m => m.id === mode);
      el('modeHint').textContent = (mod && mod.hint) || '';
      return;
    }
    hideEngineMods();
    fwd.root.visible = (mode === 'fwd');
    train.root.visible = (mode === 'train');
    document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
    // 视角按钮集合随模式切换（按模式分组显示）
    document.querySelectorAll('.camrow').forEach(r => {
      r.style.display = (r.dataset.formode === mode) ? '' : 'none';
    });
    // 若该模式尚无选中视角，默认选中第一个（通常是「全景」）
    const bs = camButtons(mode);
    if (bs.length && !bs.some(b => b.classList.contains('on'))) bs[0].classList.add('on');
    // keepCam：影片模式自己接管相机，别用预设把插值结果覆盖掉
    if (!keepCam) (mode === 'fwd' ? fwd : train).applyCam(currentCam());
    el('modeHint').textContent = mode === 'fwd'
      ? '推理模式：展示一次完整前向传播，并自回归生成。'
      : '训练模式：真实迭代 —— 每跑完一轮脚本就执行一次 trainStep，权重与 loss 同步变化。';
  }
  function currentCam() {
    const b = document.querySelector('.camrow[data-formode="' + App.mode + '"] [data-cam].on');
    return b ? b.dataset.cam : 'overview';
  }
  function applyModeCam() {
    (App.mode === 'fwd' ? fwd : train).applyCam(currentCam());
  }

  // ---------------------------------------------------------- 真实运算示例
  function renderTrace() {
    if (!App.model) return;
    window.LLMTrace.render(el('traceBox'), App.model, App.ref);
  }

  // ---------------------------------------------------------- HUD
  let hudTick = 0;
  function renderHud(h) {
    el('stage').textContent = h.stage;
    el('desc').textContent = h.desc;
    el('formula').textContent = h.formula;
    el('stepPill').textContent = h.pill;
  }
  // 面板结构缓存：两种模式的面板 DOM 结构不同，按「类型」重建并复用节点，
  // 避免每帧重建 DOM。注意必须记录类型 —— 只比较子节点数量在层数变化时会失配，
  // 而且 fwd.update() 会先于本函数执行，拿到错结构会抛异常。
  const layerNodes = { kind: null, nodes: [] };
  function renderLayers(mode) {
    const box = el('layerGrid');
    // 引擎托管模块：用统一的 lp 行渲染 getLayers() 的返回
    const eng = window.LLMEngine;
    if (mode !== 'fwd' && mode !== 'train' && eng && eng.has(mode)) {
      const rows = eng.getLayers();
      if (!rows || !rows.length) { box.innerHTML = ''; layerNodes.kind = 'empty'; return; }
      if (layerNodes.kind !== 'gen' || layerNodes.nodes.length !== rows.length) {
        box.innerHTML = rows.map(() => `<div class="lp"><span class="lp-n"></span><span class="lp-bar"><i></i></span><span class="lp-v"></span></div>`).join('');
        layerNodes.kind = 'gen';
        layerNodes.nodes = Array.from(box.children);
      }
      rows.forEach((r, i) => {
        const d = layerNodes.nodes[i];
        d.children[0].textContent = r.n;
        d.children[1].firstChild.style.width = ((r.p || 0) * 100).toFixed(1) + '%';
        d.children[2].textContent = r.val || '';
      });
      return;
    }
    if (mode === 'fwd') {
      const rows = fwd.getLayerProgress();
      if (layerNodes.kind !== 'fwd' || layerNodes.nodes.length !== rows.length) {
        box.innerHTML = rows.map(() => `<div class="lp"><span class="lp-n"></span><span class="lp-bar"><i></i></span><span class="lp-v"></span></div>`).join('');
        layerNodes.kind = 'fwd';
        layerNodes.nodes = Array.from(box.children);
      }
      rows.forEach((r, i) => {
        const d = layerNodes.nodes[i];
        d.children[0].textContent = '层 ' + (i + 1);
        d.children[1].firstChild.style.width = (r.p * 100).toFixed(1) + '%';
        d.children[2].textContent = r.val;
      });
    } else {
      const t = train.S, last = t.last;
      const vals = [
        ['迭代', `${t.steps} / ${t.maxSteps}`],
        ['当前 loss', last ? last.loss.toFixed(4) : '—'],
        ['‖g‖', last ? last.gnorm.toFixed(3) : '—'],
        ['裁剪系数', last ? last.clipScale.toFixed(3) : '—'],
        ['学习率 η', last ? last.lr.toFixed(5) : '—'],
        ['正确 token 概率', last ? (last.predProb * 100).toFixed(1) + '%' : '—'],
      ];
      if (layerNodes.kind !== 'train' || layerNodes.nodes.length !== vals.length) {
        box.innerHTML = vals.map(() => `<div class="kv"><span></span><b></b></div>`).join('');
        layerNodes.kind = 'train';
        layerNodes.nodes = Array.from(box.children);
      }
      vals.forEach((v, i) => {
        layerNodes.nodes[i].children[0].textContent = v[0];
        layerNodes.nodes[i].children[1].textContent = v[1];
      });
    }
  }
  function renderSeq() {
    if (App.mode === 'fwd') {
      el('seqBox').textContent = fwd.S.seq.map(LM.detok).join('');
    } else if (App.mode === 'train') {
      const ids = train.S.last ? train.S.last.ids : [];
      el('seqBox').textContent = ids.map(LM.detok).join('') || '—';
    } else {
      const eng = window.LLMEngine;
      el('seqBox').textContent = (eng && eng.getSeq()) || '—';
    }
  }
  el('stepBtn').addEventListener('click', () => {
    if (App.mode === 'fwd') {
      setPlayState(false);
      fwd.S.playing = false;
      fwd.gotoStep(-1, 0);
    } else {
      train.advance(1e6);      // 直接推进一整步
    }
  });
  function setPlayState(on) {
    const b = el('play'), slot = b && b.querySelector('.ic-slot'), lb = el('playLabel');
    const I = window.LLMIcons || {};
    if (b) b.classList.toggle('on', on);
    if (slot && I) slot.innerHTML = on ? I.pause(16) : I.play(16);
    if (lb) lb.textContent = on ? '暂停' : '播放';
    fwd.S.playing = on;
    train.S.playing = on;
  }
  el('play').addEventListener('click', () => setPlayState(!el('play').classList.contains('on')));
  // 模式切换
  document.querySelectorAll('[data-mode]').forEach(b => {
    b.addEventListener('click', () => setMode(b.dataset.mode));
  });
  // 视角：按模式分组，组内互斥
  document.querySelectorAll('[data-cam]').forEach(b => {
    b.addEventListener('click', () => {
      const row = b.closest('.camrow');
      const formode = row ? row.dataset.formode : App.mode;
      camButtons(formode).forEach(x => x.classList.toggle('on', x === b));
      if (formode !== App.mode) setMode(formode);
      else (App.mode === 'fwd' ? fwd : train).applyCam(b.dataset.cam);
    });
  });
  el('speed').addEventListener('input', () => {
    const v = parseFloat(el('speed').value);
    fwd.S.speed = v; train.S.speed = v;
    el('speedVal').textContent = v.toFixed(2) + '×';
  });
  el('mtx').addEventListener('change', () => { fwd.S.showMatrix = el('mtx').checked; });
  el('heat').addEventListener('change', () => { fwd.S.showHeat = el('heat').checked; });
  el('rm').addEventListener('change', () => {
    fwd.S.reduceMotion = el('rm').checked; train.S.reduceMotion = el('rm').checked;
  });
  el('retrace').addEventListener('click', renderTrace);

  // ---------------------------------------------------------- 影片模式（讲解动画）
  function toggleCinema(on) {
    if (!App.bootDone || !window.LLMCine) return;
    const want = (on === undefined) ? !window.LLMCine.isOn() : !!on;
    window.LLMCine.setOn(want);
    const b = el('cineBtn'), ic = el('cineIcon'), lb = el('cineLabel');
    const I = window.LLMIcons || {};
    if (b) b.classList.toggle('on', want);
    if (ic && I) ic.innerHTML = want ? I.close(16) : I.film(16);
    if (lb) lb.textContent = want ? '退出讲解' : '讲解动画';
  }
  if (el('cineBtn')) el('cineBtn').addEventListener('click', () => toggleCinema());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && window.LLMCine && window.LLMCine.isOn()) toggleCinema(false);
    if (e.key === ' ' && window.LLMCine && window.LLMCine.isOn()) {
      e.preventDefault();
      window.LLMCine.C.playing ? window.LLMCine.pause() : window.LLMCine.play();
    }
  });
  App.toggleCinema = toggleCinema;

  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    fwd.S.reduceMotion = train.S.reduceMotion = true; el('rm').checked = true;
  }

  // ---------------------------------------------------------- 主循环
  let last = performance.now();
  function loop(now) {
    requestAnimationFrame(loop);
    if (App.recFreeze) return;   // 逐帧导出时：不渲染，把 CPU 全留给截图编码
    const dt = Math.min(64, now - last); last = now;
    if (!App.bootDone) {
      core.controls.update();
      core.renderer.render(core.scene, core.camera);
      return;
    }
    if (App.cinema.on) {
      // 影片模式：画面完全由脚本时间轴决定（相机 / 步骤 / 阶段），
      // 主循环只负责推进时间与绘制，避免真实时间把帧状态搅乱。
      window.LLMCine.tick(now);
      core.controls.update();
      core.renderer.render(core.scene, core.camera);
      return;
    }
    if (App.mode === 'fwd') {
      if (fwd.S.playing && !fwd.S.reduceMotion) fwd.advance();
      fwd.update(now);
      if (++hudTick % 6 === 0) { renderHud(fwd.getHud()); renderLayers('fwd'); renderSeq(); }
    } else if (App.mode === 'train') {
      train.advance(dt);
      train.update(now);
      if (++hudTick % 6 === 0) { renderHud(train.getHud()); renderLayers('train'); renderSeq(); }
    } else {
      // 科普引擎托管模块（采样实验室 / 注意力探针 / 上下文缓存 / 科普图谱）
      window.LLMEngine.tick(dt, now);
      if (++hudTick % 6 === 0) {
        const h = window.LLMEngine.getHud();
        if (h) renderHud(h);
        renderLayers(App.mode);
        renderSeq();
        window.LLMEngine.panelTick();
      }
    }
    core.controls.update();
    core.renderer.render(core.scene, core.camera);
  }

  // ---------------------------------------------------------- 启动
  core.resize();
  fwd.applyCam('overview');
  requestAnimationFrame(loop);
  bootTrain();

  window.__app = App;
  // 便于自动化验证：暴露两个可视化实例（可 gotoStep / applyCam）
  App.fwd = fwd;
  App.train = train;
  App.core = core;
  App.setMode = setMode;
  App.applyModeCam = applyModeCam;
  // 影片模式（讲解动画）
  if (window.LLMCine) {
    App.cine = window.LLMCine.attach({ fwd, train, core, app: App, setMode });
  }
})();