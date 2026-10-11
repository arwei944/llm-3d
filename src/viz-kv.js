/* =============================================================================
 * viz-kv.js —— 互动模块③：上下文窗口与 KV 缓存
 *
 * 拖动「上下文长度」，实时看到：
 *   · 因果掩码三角怎么长出来（每个新 token 多一行注意力连接）
 *   · K / V 缓存墙怎么变高（每层每 token 都要存一行真实 K/V 向量）
 *   · 注意力连接数 O(T²) 与缓存元素 O(T) 的对比读数
 * 全部数值来自真实 forward 的 k / v 中间张量。
 * ========================================================================== */
(function () {
  'use strict';

  const LM = () => window.TinyLM;

  window.KvViz = {
    boot(ctx) {
      const { model, core } = ctx;
      const LMm = LM();
      const PAL = window.LLMCore.PAL;
      const D = 32, NL = 2, TMAX = 16;
      const STREAM = '1592073816490257';   // 预置输入流（16 字符）

      const root = new THREE.Group();
      core.scene.add(root);
      root.visible = false;

      const S = { T: 8, cache: null, pulse: 0 };

      /* ---- token 行 ---- */
      const tokRow = new THREE.Group(); root.add(tokRow);
      const tokChips = [];

      /* ---- 因果掩码三角 ---- */
      const TILE = 0.6;
      const mask = [];   // [row][col]
      const maskGrp = new THREE.Group(); maskGrp.position.set(-7.4, 0, 0); root.add(maskGrp);
      const maskTileGeo = new THREE.BoxGeometry(TILE * 0.86, 0.08, TILE * 0.86);
      for (let r = 0; r < TMAX; r++) {
        mask.push([]);
        for (let c = 0; c < TMAX; c++) {
          const m = new THREE.Mesh(maskTileGeo, new THREE.MeshStandardMaterial({ color: 0xf1ece0, roughness: 0.7 }));
          m.position.set(c * TILE, -r * TILE, 0);
          maskGrp.add(m); mask[r].push(m);
        }
      }
      const maskTitle = window.LLMCore.makeTextSprite('因果掩码', { size: 42, color: '#6b6259', h: 0.5 });
      maskTitle.position.set(4.8, 1.15, 0); maskGrp.add(maskTitle);

      /* ---- K / V 缓存墙（canvas 纹理热图） ---- */
      function makeWall(label, x, y, z) {
        const cv = document.createElement('canvas'); cv.width = D; cv.height = TMAX;
        const tex = new THREE.CanvasTexture(cv);
        tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.LinearFilter;
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 4.6), new THREE.MeshBasicMaterial({ map: tex }));
        plane.position.set(x, y, z);
        root.add(plane);
        const t = window.LLMCore.makeTextSprite(label, { size: 42, color: '#6b6259', h: 0.5 });
        t.position.set(x, y + 2.85, z); root.add(t);
        return { cv, tex };
      }
      const walls = [
        makeWall('层1 · K 缓存', -3.6, 5.0, -8.6), makeWall('层1 · V 缓存', 4.2, 5.0, -8.6),
        makeWall('层2 · K 缓存', -3.6, -0.9, -8.6), makeWall('层2 · V 缓存', 4.2, -0.9, -8.6),
      ];

      function drawWall(w, mat, rows) {
        const g = w.cv.getContext('2d');
        const img = g.createImageData(D, TMAX);
        for (let r = 0; r < TMAX; r++) {
          const on = r < rows;
          for (let d = 0; d < D; d++) {
            const v = on ? Math.max(-1, Math.min(1, mat[r * D + d] * 2.2)) : 0;
            const i = (r * D + d) * 4;
            if (!on) { img.data[i] = 0xf1; img.data[i + 1] = 0xec; img.data[i + 2] = 0xe0; }
            else if (v >= 0) { img.data[i] = 0x8e; img.data[i + 1] = Math.round(0xcb - v * 0x4a); img.data[i + 2] = 0xb4; }
            else { img.data[i] = Math.round(0xf1 + v * 0x2a); img.data[i + 1] = 0xec; img.data[i + 2] = Math.round(0xe0 + v * 0x2a); }
            img.data[i + 3] = 255;
          }
        }
        g.putImageData(img, 0, 0);
        w.tex.needsUpdate = true;
      }

      function recompute() {
        const ids = LMm.tokSeq(STREAM).slice(0, S.T);
        S.cache = LMm.forward(model, ids);
        const T = S.cache.T;
        // token 行
        while (tokRow.children.length) tokRow.remove(tokRow.children[0]);
        tokChips.length = 0;
        ids.forEach((id, i) => {
          const chip = new THREE.Mesh(window.LLMCore.roundedBoxGeo(0.9, 0.9, 0.3, 0.12),
            new THREE.MeshStandardMaterial({ color: i === T - 1 ? PAL.amber : PAL.jadeLo, roughness: 0.55 }));
          chip.position.set(i * 1.05 - (T - 1) * 0.525, 0, 0);
          tokRow.add(chip);
          const lab = window.LLMCore.makeTextSprite(LMm.detok(id), { size: 50, color: '#2b2723', h: 0.6 });
          lab.position.set(i * 1.05 - (T - 1) * 0.525, 0, 0.36);
          tokRow.add(lab);
          tokChips.push(chip);
        });
        tokRow.position.set(2.2, 0, 5.0);
        // 掩码
        for (let r = 0; r < TMAX; r++) for (let c = 0; c < TMAX; c++) {
          const m = mask[r][c];
          const on = r < T && c <= r;
          const fresh = (r === T - 1);
          m.material.color.set(on ? (fresh ? PAL.amber : PAL.jade) : 0xe7e2d7);
          m.visible = r < T && c < T;
        }
        // 缓存墙（真实 k / v）
        for (let l = 0; l < NL; l++) {
          drawWall(walls[l * 2], S.cache.layers[l].k, T);
          drawWall(walls[l * 2 + 1], S.cache.layers[l].v, T);
        }
        drawPanel();
      }

      /* ---- 面板 ---- */
      const panelHTML = `
        <div class="mod-sec">
          <div class="lab"><span>上下文长度 T</span><b id="kvTVal">8</b></div>
          <input type="range" id="kvT" min="3" max="16" step="1" value="8">
          <div class="ctl-row" style="margin-top:8px">
            <button id="kvAdd"><span class="ic-slot" data-ic="plus"></span>追加 token</button>
            <button id="kvMax">拉满 16</button>
          </div>
          <div id="kvRead" class="mod-read"></div>
          <div class="note">注意两个量级：注意力连接数按 <b>T(T+1)/2 平方级</b>增长，KV 缓存按 <b>T 线性</b>增长 ——
          这就是「上下文越长越贵」的根源。真实大模型把这段缓存放进显存，一次对话动辄几个 GB。</div>
        </div>`;

      function drawPanel() {
        const r = document.getElementById('kvRead');
        if (!r || !S.cache) return;
        const T = S.T;
        const conn = T * (T + 1) / 2;
        const kv = 2 * NL * T * D;
        r.innerHTML = `注意力连接 <b>${conn}</b> 条（平方级）<br>KV 缓存元素 <b>${kv}</b> 个 = 2×${NL}层×${T}×${D}（线性）<br>fp32 存储 ≈ <b>${(kv * 4 / 1024).toFixed(2)} KB</b> · 真实大模型 ≈ 千倍维度 × 万倍上下文`;
        const tv = document.getElementById('kvTVal');
        if (tv) tv.textContent = String(T);
        const sl = document.getElementById('kvT');
        if (sl && +sl.value !== T) sl.value = String(T);
      }

      function panelInit(host) {
        const I = window.LLMIcons || {};
        host.querySelectorAll('.ic-slot[data-ic]').forEach(el => {
          if (I[el.dataset.ic]) el.innerHTML = I[el.dataset.ic](15);
        });
        host.querySelector('#kvT').addEventListener('input', (e) => {
          S.T = parseInt(e.target.value, 10); recompute();
        });
        host.querySelector('#kvAdd').addEventListener('click', () => {
          if (S.T < TMAX) { S.T++; host.querySelector('#kvT').value = String(S.T); recompute(); }
        });
        host.querySelector('#kvMax').addEventListener('click', () => {
          S.T = TMAX; host.querySelector('#kvT').value = String(TMAX); recompute();
        });
        recompute();
      }

      function tick(dt, now) {
        // 最新 token 呼吸
        S.pulse = now;
        const last = tokChips[tokChips.length - 1];
        if (last) last.scale.setScalar(1 + Math.sin(now * 0.005) * 0.06);
      }

      const CAMS = {
        overview: { pos: [-0.5, 8.5, 21], tgt: [-1.0, 1.8, -3.0] },
        mask: { pos: [-7.4, 9, 8.5], tgt: [-7.4, -2.4, 0] },
        walls: { pos: [0.3, 3.2, 4.0], tgt: [0.3, 2.1, -8.6] },
      };
      function applyCam(name) {
        window.LLMEngine.setCam(core, CAMS[name] || CAMS.overview);
      }

      function getHud() {
        const T = S.T;
        return {
          stage: '上下文窗口与 KV 缓存',
          desc: `当前 T=${T}：注意力连接 ${T * (T + 1) / 2} 条（平方级），KV 缓存 ${2 * NL * T * D} 个元素（线性）。每追加一个 token，K/V 墙多一行。`,
          formula: '连接数 O(T²) · 缓存 O(T) —— 长上下文的代价曲线',
          pill: `T = ${T}/${TMAX}`,
        };
      }
      function getSeq() { return STREAM.slice(0, S.T); }

      return { root, tick, applyCam, getHud, getSeq, panelHTML, panelInit };
    },
  };

  window.LLMEngine.register({
    id: 'kv', title: '上下文与缓存', icon: 'layers', kind: 'viz3d',
    tagline: '拖上下文长度，看 O(T²) 连接与 KV 缓存怎么长',
    hint: '互动模式：K/V 墙的每个格子都是真实的缓存值。',
    camRows: [['overview', '全景'], ['mask', '掩码'], ['walls', '缓存墙']],
    boot: (ctx) => window.KvViz.boot(ctx),
  });
})();
