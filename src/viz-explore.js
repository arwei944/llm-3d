/* =============================================================================
 * viz-explore.js —— 互动模块①：采样实验室
 *
 * 实时调参，看「下一个 token 的概率分布」怎么变：
 *   温度 T   —— logits / T 再 softmax：T→0 越接近 argmax，T→∞ 越平均
 *   Top-K    —— 只保留概率最高的 K 个候选
 *   Top-P    —— 只保留累计概率达到 P 的最小候选集
 * 全部数字来自已训练微型模型的真实 forward，滑动滑杆立即重算。
 * ========================================================================== */
(function () {
  'use strict';

  const LM = () => window.TinyLM;

  window.ExploreViz = {
    boot(ctx) {
      const { model, core } = ctx;
      const LMm = LM();
      const VOCAB = LMm.VOCAB, V = VOCAB.length;

      /* ---------------- 3D 场景 ---------------- */
      const PAL = window.LLMCore.PAL;
      const root = new THREE.Group();
      core.scene.add(root);
      root.visible = false;

      const mats = {};
      const chipMat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.55, metalness: 0.05 });

      // 输入 token 行
      const inputRow = new THREE.Group(); root.add(inputRow);
      // 概率条（12 根）
      const bars = [], barLabels = [], barVals = [];
      const barsGrp = new THREE.Group(); barsGrp.position.set(0, 0.6, -4.0); root.add(barsGrp);
      const BAR_W = 0.52, GAP = 0.26, HMAX = 5.4;
      for (let i = 0; i < V; i++) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(BAR_W, 1, BAR_W), chipMat(PAL.jadeLo));
        const x = (i - (V - 1) / 2) * (BAR_W + GAP);
        m.position.set(x, 0.5, 0);
        barsGrp.add(m); bars.push(m);
        const lab = window.LLMCore.makeTextSprite(VOCAB[i], { size: 56, color: '#2b2723', h: 0.62 });
        lab.position.set(x, 0.18, 0.5); barsGrp.add(lab); barLabels.push(lab);
        const val = window.LLMCore.makeTextSprite('0%', { size: 44, color: '#6b6259', h: 0.46 });
        val.position.set(x, 0.5, -0.4); barsGrp.add(val); barVals.push(val);
      }
      const basePlate = new THREE.Mesh(new THREE.BoxGeometry(V * (BAR_W + GAP), 0.18, 1.1), chipMat(PAL.slab));
      basePlate.position.set(0, 0.09, 0); barsGrp.add(basePlate);
      const distTitle = window.LLMCore.makeTextSprite('下一个 token 的概率分布（真实 forward）', { size: 44, color: '#6b6259', h: 0.55 });
      distTitle.position.set(0, 6.5, -4.0); root.add(distTitle);

      // 生成序列行
      const genRow = new THREE.Group(); genRow.position.set(0, -2.6, 0); root.add(genRow);
      const genTitle = window.LLMCore.makeTextSprite('自回归生成', { size: 40, color: '#6b6259', h: 0.5 });
      genTitle.position.set(-9.2, 0, 0); genRow.add(genTitle);

      const chipGeo = window.LLMCore.roundedBoxGeo(0.8, 0.8, 0.3, 0.12);

      /* ---------------- 状态 ---------------- */
      const S = {
        ids: LMm.tokSeq('159'),
        gen: [],
        temp: 0.85, topK: V, topP: 1.0,
        seed: 7,
        auto: false, autoT: 0,
        dist: null,          // {probs, kept:[], entropy, picked}
        shownH: new Float32Array(V),
      };

      function sanitize(str) {
        const allow = VOCAB.join('');
        const out = [];
        for (const ch of String(str)) if (allow.includes(ch)) out.push(ch);
        return out.join('');
      }

      function recompute() {
        const m = model;
        const ids = S.ids.slice();
        const cache = LMm.forward(m, ids);
        const logits = cache.logits;
        const T = cache.T, last = (T - 1) * V;
        // 温度 softmax
        const t = Math.max(0.01, S.temp);
        const ex = new Float64Array(V);
        let mx = -Infinity;
        for (let i = 0; i < V; i++) mx = Math.max(mx, logits[last + i]);
        let sum = 0;
        for (let i = 0; i < V; i++) { ex[i] = Math.exp((logits[last + i] - mx) / t); sum += ex[i]; }
        let probs = new Float64Array(V);
        for (let i = 0; i < V; i++) probs[i] = ex[i] / sum;
        // Top-K
        const kept = new Array(V).fill(true);
        if (S.topK < V) {
          const order = Array.from({ length: V }, (_, i) => i).sort((a, b) => probs[b] - probs[a]);
          for (let i = S.topK; i < V; i++) kept[order[i]] = false;
        }
        // Top-P（在 top-k 基础上取累计 ≥ P 的最小前缀）
        if (S.topP < 0.999) {
          const order = Array.from({ length: V }, (_, i) => i).sort((a, b) => probs[b] - probs[a]);
          let acc = 0;
          for (const i of order) {
            if (!kept[i]) continue;
            if (acc >= S.topP) kept[i] = false;
            acc += probs[i];
          }
        }
        let ksum = 0;
        for (let i = 0; i < V; i++) if (!kept[i]) probs[i] = 0;
        for (let i = 0; i < V; i++) ksum += probs[i];
        for (let i = 0; i < V; i++) probs[i] /= ksum;
        // 熵（bit）
        let H = 0;
        for (let i = 0; i < V; i++) if (probs[i] > 0) H -= probs[i] * Math.log2(probs[i]);
        S.dist = { probs, kept, entropy: H, keptCount: kept.filter(Boolean).length, logits: logits.slice(last, last + V) };
        drawPanel();
      }

      function sample() {
        if (!S.dist) recompute();
        const { probs } = S.dist;
        const rng = LMm.mulberry32(S.seed++);
        let r = rng(), pick = 0;
        for (let i = 0; i < V; i++) { r -= probs[i]; if (r <= 0) { pick = i; break; } }
        S.dist.picked = pick;
        S.dist.pickedP = probs[pick];
        S.gen.push(pick);
        if (S.ids.length + S.gen.length > 16) { // 超出上下文：把最早生成挤掉输入
          if (S.gen.length > 1) S.gen.shift(); else if (S.ids.length > 1) S.ids.shift();
        }
        redraw();
        recompute();
      }

      /* ---------------- 3D 重绘 ---------------- */
      const jadeC = new THREE.Color(PAL.jadeLo), jadeHi = new THREE.Color(PAL.jade), grayC = new THREE.Color(PAL.line), amberC = new THREE.Color(PAL.amber);
      function redraw() {
        // 输入行
        while (inputRow.children.length) inputRow.remove(inputRow.children[0]);
        const all = S.ids.concat(S.gen);
        const n = all.length, span = Math.min(15.2, n * 1.0);
        const x0 = -span / 2;
        all.forEach((id, i) => {
          const isGen = i >= S.ids.length;
          const chip = new THREE.Mesh(chipGeo, chipMat(isGen ? PAL.amber : PAL.jadeLo));
          chip.position.set(x0 + i * 1.0 + 0.4, 0, 0);
          inputRow.add(chip);
          const lab = window.LLMCore.makeTextSprite(LMm.detok(id), { size: 54, color: isGen ? '#5b3a16' : '#1f4c3d', bg: null, h: 0.66 });
          lab.position.set(x0 + i * 1.0 + 0.4, 0, 0.34);
          inputRow.add(lab);
        });
        // 概率条目标高度
        if (S.dist) {
          let pmax = 0;
          for (let i = 0; i < V; i++) if (S.dist.kept[i]) pmax = Math.max(pmax, S.dist.probs[i]);
          const norm = pmax > 0 ? HMAX / pmax : 0;
          for (let i = 0; i < V; i++) {
            const p = S.dist.probs[i];
            bars[i].userData.target = Math.max(0.04, p * norm);
            bars[i].userData.kept = S.dist.kept[i];
            bars[i].userData.picked = (S.dist.picked === i);
            barLabels[i].material.opacity = S.dist.kept[i] ? 1 : 0.35;
            barVals[i].material.opacity = S.dist.kept[i] ? 1 : 0.3;
          }
        }
        // 生成行（并入 inputRow 显示）
        genRow.visible = false;
      }

      function tick(dt) {
        // 概率条动画
        for (let i = 0; i < V; i++) {
          const b = bars[i];
          const tgt = b.userData.target || 0.04;
          b.scale.y += (Math.max(0.04, tgt) / 1 - b.scale.y) * Math.min(1, dt * 0.012);
          b.position.y = 0.18 + b.scale.y / 2;
          const c = b.userData.picked ? amberC : (b.userData.kept ? (b.scale.y > 0.01 ? jadeHi : jadeC) : grayC);
          b.material.color.lerp(c, Math.min(1, dt * 0.01));
          if (S.dist) {
            const p = S.dist.probs[i];
            // 概率太小就别显示数值 —— 一排「0.0%」只会制造噪声
            const txt = !S.dist.kept[i] ? '—' : (p < 0.005 ? '' : (p * 100).toFixed(1) + '%');
            window.LLMCore.setLabel(barVals[i], txt, b.userData.picked ? '#8a4d12' : '#6b6259');
          }
        }
        // 自动生成
        if (S.auto) {
          S.autoT += dt;
          if (S.autoT > 650) { S.autoT = 0; sample(); }
        }
      }

      /* ---------------- 参数面板 ---------------- */
      const panelHTML = `
        <div class="mod-sec">
          <div class="lab"><span>输入序列（词表只有 0-9 · |）</span></div>
          <div class="ctl-row" id="exPresets">
            <button data-ids="159">159</button><button data-ids="207381">207381</button>
            <button data-ids="·159·">·159·</button><button data-ids="0000">0000</button>
          </div>
          <input type="text" id="exInput" class="txt" spellcheck="false" value="159" maxlength="16">
          <div class="lab"><span>温度 T</span><b id="exTempVal">0.85</b></div>
          <input type="range" id="exTemp" min="0.05" max="3" step="0.05" value="0.85">
          <div class="lab"><span>Top-K</span><b id="exKVal">12（关）</b></div>
          <input type="range" id="exK" min="1" max="12" step="1" value="12">
          <div class="lab"><span>Top-P</span><b id="exPVal">1.00（关）</b></div>
          <input type="range" id="exP" min="0.05" max="1" step="0.05" value="1">
          <div class="ctl-row" style="margin-top:8px">
            <button id="exStep"><span class="ic-slot" data-ic="step"></span>采样一步</button>
            <button id="exAuto"><span class="ic-slot" data-ic="play"></span>自动生成</button>
            <button id="exReset"><span class="ic-slot" data-ic="reset"></span>重置</button>
          </div>
          <canvas id="exCanvas" width="286" height="96" style="width:100%;margin-top:8px;border:1px solid var(--line);border-radius:8px;background:#fdfcf8"></canvas>
          <div id="exRead" class="mod-read"></div>
          <div class="note">温度越低分布越尖（接近确定性），越高越平（更「有创意」也更常胡说）；Top-K / Top-P 把长尾砍掉。 bars 的灰色 = 被过滤的候选。</div>
        </div>`;

      function drawPanel() {
        const cv = document.getElementById('exCanvas');
        if (!cv || !S.dist) return;
        const g = cv.getContext('2d'), W = cv.width, H = cv.height;
        g.clearRect(0, 0, W, H);
        const bw = W / V;
        for (let i = 0; i < V; i++) {
          const p = S.dist.probs[i];
          const h = Math.max(2, p * (H - 18));
          g.fillStyle = S.dist.picked === i ? '#c98a3c' : (S.dist.kept[i] ? '#2f7d63' : '#d8d0c2');
          g.fillRect(i * bw + 3, H - 14 - h, bw - 6, h);
          g.fillStyle = '#6b6259';
          g.font = '11px sans-serif'; g.textAlign = 'center';
          g.fillText(VOCAB[i], i * bw + bw / 2, H - 3);
        }
        const r = document.getElementById('exRead');
        if (r) {
          const d = S.dist;
          r.innerHTML = `熵 <b>${d.entropy.toFixed(2)}</b> bit（12 选 1 上限 ${Math.log2(V).toFixed(2)}）· 保留候选 <b>${d.keptCount}</b>/12` +
            (d.picked !== undefined ? ` · 上次采样 <b>${LMm.detok(d.picked)}</b>（p=${(d.pickedP * 100).toFixed(1)}%）` : '');
        }
      }

      function panelInit(host) {
        const $ = (id) => host.querySelector('#' + id);
        const I = window.LLMIcons || {};
        // 面板内的图标位统一注入
        host.querySelectorAll('.ic-slot[data-ic]').forEach(el => {
          if (I[el.dataset.ic]) el.innerHTML = I[el.dataset.ic](15);
        });
        function setAutoUI(on) {
          const b = $('exAuto'), slot = b && b.querySelector('.ic-slot');
          if (b) b.classList.toggle('on', on);
          if (slot && I) slot.innerHTML = I[on ? 'pause' : 'play'](15);
          if (b) { const t = Array.from(b.childNodes).find(n => n.nodeType === 3); if (t) t.nodeValue = on ? '停止' : '自动生成'; }
        }
        const setIds = (str) => {
          const s = sanitize(str);
          if (s) { S.ids = LMm.tokSeq(s); S.gen = []; S.dist && (S.dist.picked = undefined); redraw(); recompute(); }
        };
        host.querySelectorAll('#exPresets button').forEach(b => b.addEventListener('click', () => {
          $('exInput').value = b.dataset.ids; setIds(b.dataset.ids);
        }));
        $('exInput').addEventListener('change', () => setIds($('exInput').value));
        $('exTemp').addEventListener('input', () => {
          S.temp = parseFloat($('exTemp').value);
          $('exTempVal').textContent = S.temp.toFixed(2);
          recompute();
        });
        $('exK').addEventListener('input', () => {
          S.topK = parseInt($('exK').value, 10);
          $('exKVal').textContent = S.topK >= V ? '12（关）' : String(S.topK);
          recompute();
        });
        $('exP').addEventListener('input', () => {
          S.topP = parseFloat($('exP').value);
          $('exPVal').textContent = S.topP.toFixed(2) + (S.topP >= 0.999 ? '（关）' : '');
          recompute();
        });
        $('exStep').addEventListener('click', () => sample());
        $('exAuto').addEventListener('click', () => {
          S.auto = !S.auto;
          setAutoUI(S.auto);
        });
        $('exReset').addEventListener('click', () => {
          S.gen = []; S.auto = false; setAutoUI(false); redraw(); recompute();
        });
        recompute(); redraw();
      }

      function getHud() {
        const d = S.dist;
        return {
          stage: '采样实验室 · 实时调参',
          desc: d ? `温度 ${S.temp.toFixed(2)} · Top-K ${S.topK >= V ? '关' : S.topK} · Top-P ${S.topP.toFixed(2)} —— 概率分布共 12 个候选，当前保留 ${d.keptCount} 个，熵 ${d.entropy.toFixed(2)} bit。`
            : '拖动滑杆，观察分布实时变化。',
          formula: 'p_i ∝ exp(logit_i / T) → Top-K → Top-P → 归一化 → 按概率采样',
          pill: `上下文 ${S.ids.length + S.gen.length}/16 · 已生成 ${S.gen.length}`,
        };
      }
      function getSeq() { return S.ids.concat(S.gen).map(LMm.detok).join(''); }

      /* 相机预设 */
      const CAMS = {
        overview: { pos: [0, 6.6, 15.6], tgt: [0, 2.6, -2.2] },
        dist: { pos: [0, 3.4, 7.4], tgt: [0, 2.8, -4.0] },
        low: { pos: [0, 1.8, 12.5], tgt: [0, -0.2, 0] },
      };
      function applyCam(name) {
        window.LLMEngine.setCam(core, CAMS[name] || CAMS.overview);
      }

      redraw();
      return { root, tick, applyCam, getHud, getSeq, panelHTML, panelInit };
    },
  };

  window.LLMEngine.register({
    id: 'explore', title: '采样实验室', icon: 'sliders', kind: 'viz3d',
    tagline: '实时调温度 / Top-K / Top-P，看概率分布怎么变',
    hint: '互动模式：所有滑杆都实时驱动真实 forward 重算。',
    camRows: [['overview', '全景'], ['dist', '分布特写'], ['low', '序列']],
    boot: (ctx) => window.ExploreViz.boot(ctx),
  });
})();
