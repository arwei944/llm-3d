/* =============================================================================
 * engine.js —— 科普引擎：模块注册表 + 生命周期 + 导航 + 面板托管
 *
 * 设计目标（需求 4）：后续功能扩展 = 新写一个文件、调用 LLMEngine.register({...})，
 * 不用再改 app.js / index.html —— 引擎自动生成导航按钮、注入参数面板、
 * 管理 3D root 显隐 / 相机行 / HUD / 主循环 tick。
 *
 * 模块契约：
 *   {
 *     id, title, icon, tagline, hint,
 *     kind: 'viz3d' | 'overlay',
 *     builtin: true,                       // fwd/train 这类老模式只进导航，不走引擎生命周期
 *     camRows: [['overview','全景'], ...],  // 可选：引擎注入视角按钮行
 *     boot(ctx) → inst
 *   }
 *   ctx = { model, core, LM, el }
 *   inst = {
 *     root,                                // viz3d：THREE.Group
 *     tick(dt, now)?, applyCam(name)?, getHud()?,
 *     getLayers()? [{n,p,val}], getSeq()? string,
 *     panelHTML? string, panelInit?(hostEl)?, panelTick()?,
 *     el?,                                 // overlay：根 DOM
 *   }
 * ========================================================================== */
(function () {
  'use strict';

  const REG = [];                 // 有序模块定义
  const INST = {};                // id → boot 产物
  let ENGINE = null;              // { ctx, cur, navHost, camHost, panelHost }

  window.LLMEngine = {
    register(mod) {
      if (REG.some(m => m.id === mod.id)) throw new Error('module duplicated: ' + mod.id);
      REG.push(mod);
    },
    get list() { return REG.slice(); },
    has(id) { return REG.some(m => m.id === id); },

    /* App 在模型训练完成后调用一次 */
    boot(ctx, startId) {
      ENGINE = { ctx, cur: null, navHost: document.getElementById('modTabs'), camHost: document.getElementById('engineCams'), panelHost: document.getElementById('modPanel') };
      if (!ENGINE.navHost || !ENGINE.panelHost) throw new Error('index.html 缺少 #modTabs / #engineCams / #modPanel 宿主');
      // 逐个 boot（失败不拖垮其它模块）
      for (const mod of REG) {
        try { INST[mod.id] = mod.boot ? mod.boot(ctx) : null; }
        catch (e) { console.error('[engine] boot 失败:', mod.id, e); INST[mod.id] = null; }
      }
      buildNav();
      buildCamRows();
      this.show(startId || (REG[0] && REG[0].id));
    },

    show(id, keepCam) {
      if (!ENGINE) return;
      const mod = REG.find(m => m.id === id);
      if (!mod) return;
      const prev = ENGINE.cur && REG.find(m => m.id === ENGINE.cur);
      // 隐藏旧模块
      if (prev && prev.id !== id) {
        const pi = INST[prev.id];
        if (pi && prev.kind === 'viz3d' && pi.root) pi.root.visible = false;
        if (pi && pi.el) pi.el.classList.add('hidden');
        if (pi && pi.onHide) pi.onHide();
      }
      ENGINE.cur = id;
      // 导航高亮
      ENGINE.navHost.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === id));
      // 视角行显隐
      if (ENGINE.camHost) {
        ENGINE.camHost.querySelectorAll('.camrow').forEach(r => { r.style.display = (r.dataset.formode === id) ? '' : 'none'; });
        const btns = Array.from(ENGINE.camHost.querySelectorAll(`.camrow[data-formode="${id}"] [data-cam]`));
        if (btns.length && !btns.some(b => b.classList.contains('on'))) btns[0].classList.add('on');
      }
      // 参数面板（引擎统一加区块头；panelHTML 定义在实例上）
      const inst = INST[id];
      if (ENGINE.panelHost) {
        if (inst && inst.panelHTML !== undefined) {
          if (ENGINE.panelHost.dataset.mod !== id) {
            ENGINE.panelHost.dataset.mod = id;
            ENGINE.panelHost.innerHTML = '<div class="sec-h">互动参数 · ' + (mod.title || id) + '</div>' + (inst.panelHTML || '');
            if (inst.panelInit) { try { inst.panelInit(ENGINE.panelHost); } catch (e) { console.error('[engine] panelInit:', id, e); } }
          }
          ENGINE.panelHost.style.display = '';
        } else {
          ENGINE.panelHost.dataset.mod = '';
          ENGINE.panelHost.innerHTML = '';
          ENGINE.panelHost.style.display = 'none';
        }
      }
      // overlay 显隐 + body 标记（供 CSS 隐藏共用区块）
      const overlay = id === 'topics';
      document.body.classList.toggle('mod-overlay', overlay);
      if (inst && inst.el) inst.el.classList.toggle('hidden', !overlay);
      // 显示新模块
      if (inst && mod.kind === 'viz3d' && inst.root) inst.root.visible = true;
      if (inst && inst.onShow) inst.onShow();
      if (!keepCam && inst && inst.applyCam && mod.kind === 'viz3d') {
        const b = ENGINE.camHost && ENGINE.camHost.querySelector(`.camrow[data-formode="${id}"] [data-cam].on`);
        inst.applyCam(b ? b.dataset.cam : 'overview');
      }
    },

    /* 主循环：驱动当前模块 */
    tick(dt, now) {
      if (!ENGINE) return;
      const inst = INST[ENGINE.cur];
      if (inst && inst.tick) inst.tick(dt, now);
    },
    /* HUD：当前模块提供 getHud 才绘制 */
    getHud() {
      if (!ENGINE) return null;
      const inst = INST[ENGINE.cur];
      return inst && inst.getHud ? inst.getHud() : null;
    },
    panelTick() {
      if (!ENGINE) return;
      const inst = INST[ENGINE.cur];
      if (inst && inst.panelTick) inst.panelTick();
    },
    getLayers() {
      if (!ENGINE) return null;
      const inst = INST[ENGINE.cur];
      return inst && inst.getLayers ? inst.getLayers() : null;
    },
    getSeq() {
      if (!ENGINE) return null;
      const inst = INST[ENGINE.cur];
      return inst && inst.getSeq ? inst.getSeq() : null;
    },
    inst(id) { return INST[id]; },

    /* 模块相机助手：把「相机点 + 目标点」换算成自研 OrbitControls 的球坐标。
     * 自研控制器的约定：theta = atan2(dx, dz)，phi = acos(dy/r)（极角）。 */
    setCam(core, c) {
      const dx = c.pos[0] - c.tgt[0], dy = c.pos[1] - c.tgt[1], dz = c.pos[2] - c.tgt[2];
      const r0 = Math.max(0.001, Math.sqrt(dx * dx + dy * dy + dz * dz));
      // 窄视口（三栏布局里中栏接近方形）需要拉远才能横向装下，
      // 但按 16:9 全额回拉会把内容缩得太小 —— 上限 1.45。
      const a = core.camera.aspect || (16 / 9);
      const r = r0 * Math.min(1.45, Math.max(1, (16 / 9) / a));
      core.controls.setSpherical(
        Math.atan2(dx, dz),
        Math.acos(Math.max(-1, Math.min(1, dy / r))),
        r,
        { x: c.tgt[0], y: c.tgt[1], z: c.tgt[2] });
    },
  };

  function buildNav() {
    // 内置模块（fwd/train）排最前，其余按注册顺序（sort 稳定）
    const ordered = REG.slice().sort((a, b) => (b.builtin ? 1 : 0) - (a.builtin ? 1 : 0));
    const IC = window.LLMIcons || {};
    ENGINE.navHost.innerHTML = ordered.map(m => {
      const ic = (IC && IC[m.icon]) ? IC[m.icon](17) : '';
      return `<button data-mode="${m.id}" title="${m.tagline || m.title}">` +
        `<span class="m-ic">${ic}</span>` +
        `<span class="m-tx"><b>${m.title}</b><i>${m.tagline || ''}</i></span></button>`;
    }).join('');
    ENGINE.navHost.querySelectorAll('[data-mode]').forEach(b => {
      b.addEventListener('click', () => window.__app.setMode(b.dataset.mode));
    });
  }

  function buildCamRows() {
    if (!ENGINE.camHost) return;
    let html = '';
    for (const mod of REG) {
      if (!mod.camRows || mod.builtin) continue;
      mod.camRows.forEach((row, ri) => {
        html += `<div class="ctl-row camrow" data-formode="${mod.id}" style="display:none">` +
          row.map(([cam, label], ci) =>
            `<button data-cam="${cam}"${ri === 0 && ci === 0 ? ' class="on"' : ''}>${label}</button>`).join('') +
          `</div>`;
      });
    }
    ENGINE.camHost.innerHTML = html;
    ENGINE.camHost.querySelectorAll('[data-cam]').forEach(b => {
      b.addEventListener('click', () => {
        const row = b.closest('.camrow');
        const id = row ? row.dataset.formode : ENGINE.cur;
        row.querySelectorAll('[data-cam]').forEach(x => x.classList.toggle('on', x === b));
        const inst = INST[id];
        if (inst && inst.applyCam) inst.applyCam(b.dataset.cam);
      });
    });
  }
})();
