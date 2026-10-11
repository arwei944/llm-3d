/* =============================================================================
 * viz-attn.js —— 互动模块②：注意力探针
 *
 * 选层 / 选头 / 选查询位置，实时看「这个位置在关注谁」：
 *   热力图 = cache.layers[l].probs[头*h + 行*T + 列]（真实注意力概率）。
 *   上一三角是未来 —— 因果掩码永远灰掉。
 * ========================================================================== */
(function () {
  'use strict';

  const LM = () => window.TinyLM;

  window.AttnViz = {
    boot(ctx) {
      const { model, core } = ctx;
      const LMm = LM();
      const PAL = window.LLMCore.PAL;
      const NH = 4, TMAX = 12;

      const root = new THREE.Group();
      core.scene.add(root);
      root.visible = false;

      const S = { ids: LMm.tokSeq('1592073816490257').slice(0, TMAX), layer: 0, head: 0, query: 8, cache: null, top3: [] };

      /* ---- 网格 ---- */
      const TILE = 0.78;
      const tiles = [];          // [row][col] → mesh
      const rowLabels = [], colLabels = [];
      const grid = new THREE.Group(); root.add(grid);
      const tileGeo = new THREE.BoxGeometry(TILE * 0.9, 0.1, TILE * 0.9);
      for (let r = 0; r < TMAX; r++) {
        tiles.push([]);
        for (let c = 0; c < TMAX; c++) {
          const m = new THREE.Mesh(tileGeo, new THREE.MeshStandardMaterial({ color: 0xf1ece0, roughness: 0.7 }));
          m.position.set((c - (TMAX - 1) / 2) * TILE, (r - (TMAX - 1) / 2) * -TILE, 0);
          grid.add(m); tiles[r].push(m);
        }
      }
      for (let c = 0; c < TMAX; c++) {
        const l = window.LLMCore.makeTextSprite('', { size: 50, color: '#6b6259', h: 0.56 });
        l.position.set((c - (TMAX - 1) / 2) * TILE, ((TMAX - 1) / 2) * -TILE - 0.9, 0);
        grid.add(l); colLabels.push(l);
      }
      for (let r = 0; r < TMAX; r++) {
        const l = window.LLMCore.makeTextSprite('', { size: 50, color: '#6b6259', h: 0.56 });
        l.position.set(-(TMAX / 2) * TILE - 0.85, (r - (TMAX - 1) / 2) * -TILE, 0);
        grid.add(l); rowLabels.push(l);
      }
      const title = window.LLMCore.makeTextSprite('注意力概率：列=被关注位置，行=查询位置（下三角）', { size: 42, color: '#6b6259', h: 0.52 });
      title.position.set(0, -((TMAX / 2) * TILE + 1.35), 0); root.add(title);

      const lo = new THREE.Color(0xf1ece0), hi = new THREE.Color(PAL.jade), futureC = new THREE.Color(0xe7e2d7), pickC = new THREE.Color(PAL.amber);

      function recompute() {
        S.ids = S.ids.slice(0, TMAX);
        if (S.query >= S.ids.length) S.query = S.ids.length - 1;
        S.cache = LMm.forward(model, S.ids);
        const T = S.ids.length;
        const probs = S.cache.layers[S.layer].probs;
        const base = S.head * T * T;
        let best = [];
        for (let r = 0; r < TMAX; r++) {
          for (let c = 0; c < TMAX; c++) {
            const t = tiles[r][c];
            if (r >= T || c >= T) { t.visible = false; continue; }
            t.visible = true;
            if (c > r) { t.material.color.copy(futureC); t.userData.p = -1; }
            else {
              const p = probs[base + r * T + c];
              t.userData.p = p;
              t.material.color.copy(lo).lerp(hi, Math.min(1, p * 1.9));
              t.position.z = p * 0.16;
            }
          }
        }
        // 行列标签
        for (let c = 0; c < T; c++) window.LLMCore.setLabel(colLabels[c], LMm.detok(S.ids[c]), '#6b6259');
        for (let r = 0; r < T; r++) window.LLMCore.setLabel(rowLabels[r], LMm.detok(S.ids[r]), '#6b6259');
        for (let c = T; c < TMAX; c++) window.LLMCore.setLabel(colLabels[c], '', '#6b6259');
        for (let r = T; r < TMAX; r++) window.LLMCore.setLabel(rowLabels[r], '', '#6b6259');
        // query 行高亮 + top-3
        const q = S.query;
        const rowP = [];
        for (let c = 0; c <= q; c++) rowP.push([c, probs[base + q * T + c]]);
        rowP.sort((a, b) => b[1] - a[1]);
        S.top3 = rowP.slice(0, 3);
        // 高亮：query 行的 tiles 抬起 + top1 变琥珀
        for (let c = 0; c <= q; c++) {
          const t = tiles[q][c];
          t.position.y = 0.10;
          const isTop = c === S.top3[0][0];
          t.material.emissive = new THREE.Color(isTop ? PAL.amber : PAL.jade);
          t.material.emissiveIntensity = isTop ? 0.30 : 0.14;
        }
        for (let r = 0; r < T; r++) if (r !== q) for (let c = 0; c <= r; c++) { tiles[r][c].position.y = 0; tiles[r][c].material.emissiveIntensity = 0; }
        drawPanel();
      }

      /* ---- 面板 ---- */
      const panelHTML = `
        <div class="mod-sec">
          <div class="lab"><span>输入序列（前 12 个进入网格）</span></div>
          <div class="ctl-row" id="atPresets">
            <button data-ids="159207381649025738">短语流</button>
            <button data-ids="159|159|159">重复</button>
            <button data-ids="000000000000">全零</button>
          </div>
          <div class="lab"><span>层</span></div>
          <div class="ctl-row" id="atLayer"><button data-l="0" class="on">第 1 层</button><button data-l="1">第 2 层</button></div>
          <div class="lab"><span>注意力头</span></div>
          <div class="ctl-row" id="atHead"><button data-h="0" class="on">头 1</button><button data-h="1">头 2</button><button data-h="2">头 3</button><button data-h="3">头 4</button></div>
          <div class="lab"><span>查询位置（第几个 token）</span><b id="atQVal">9</b></div>
          <input type="range" id="atQ" min="1" max="12" step="1" value="9">
          <div id="atRead" class="mod-read"></div>
          <div class="note">换层 / 换头，注意有的头盯着前一个数字，有的头只认词边界「|」—— 分工是训练出来的，不是设计出来的。</div>
        </div>`;

      function drawPanel() {
        const r = document.getElementById('atRead');
        if (!r || !S.cache) return;
        const rows = S.top3.map(([c, p], i) =>
          `<div>关注 #${c + 1}「${LM().detok(S.ids[c])}」 <b>${(p * 100).toFixed(1)}%</b>${i === 0 ? ' ← 最强' : ''}</div>`).join('');
        r.innerHTML = `第 ${S.layer + 1} 层 · 头 ${S.head + 1} · 查询位置 ${S.query + 1}「${LM().detok(S.ids[S.query])}」<br>${rows}`;
        const q = document.getElementById('atQVal');
        if (q) q.textContent = String(S.query + 1);
      }

      function panelInit(host) {
        const re = () => recompute();
        host.querySelectorAll('#atPresets button').forEach(b => b.addEventListener('click', () => {
          S.ids = LM().tokSeq(b.dataset.ids).slice(0, TMAX);
          const q = host.querySelector('#atQ'); q.max = String(S.ids.length); if (S.query >= S.ids.length) S.query = S.ids.length - 1;
          re();
        }));
        host.querySelectorAll('#atLayer button').forEach(b => b.addEventListener('click', () => {
          host.querySelectorAll('#atLayer button').forEach(x => x.classList.toggle('on', x === b));
          S.layer = +b.dataset.l; re();
        }));
        host.querySelectorAll('#atHead button').forEach(b => b.addEventListener('click', () => {
          host.querySelectorAll('#atHead button').forEach(x => x.classList.toggle('on', x === b));
          S.head = +b.dataset.h; re();
        }));
        host.querySelector('#atQ').addEventListener('input', (e) => {
          S.query = Math.min(S.ids.length - 1, parseInt(e.target.value, 10) - 1);
          re();
        });
        recompute();
      }

      function tick(dt, now) {
        // query 行轻微呼吸
        const s = 0.42 + Math.sin(now * 0.004) * 0.05;
        for (let c = 0; c <= Math.min(S.query, S.ids.length - 1); c++) {
          const t = tiles[S.query] && tiles[S.query][c];
          if (t && t.visible) t.position.y = s;
        }
      }

      const CAMS = {
        overview: { pos: [0, -0.2, 15.2], tgt: [0, -0.2, 0] },
        zoom: { pos: [0, -0.2, 9.4], tgt: [0, -0.2, 0] },
      };
      function applyCam(name) {
        window.LLMEngine.setCam(core, CAMS[name] || CAMS.overview);
      }

      function getHud() {
        return {
          stage: '注意力探针 · 实时选层/头/位置',
          desc: S.cache ? `第 ${S.layer + 1} 层 · 头 ${S.head + 1}：位置 ${S.query + 1}「${LM().detok(S.ids[S.query])}」最关注「${LM().detok(S.top3[0][0] !== undefined ? S.ids[S.top3[0][0]] : '')}」（${(S.top3[0][1] * 100).toFixed(1)}%）。` : '计算中…',
          formula: 'softmax(qᵀk/√d) —— 概率来自真实 forward 的中间张量',
          pill: `序列 ${S.ids.length} · 层 ${S.layer + 1}/2 · 头 ${S.head + 1}/4`,
        };
      }
      function getSeq() { return S.ids.map(LM().detok).join(''); }

      recompute();
      return { root, tick, applyCam, getHud, getSeq, panelHTML, panelInit };
    },
  };

  window.LLMEngine.register({
    id: 'attn', title: '注意力探针', icon: 'target', kind: 'viz3d',
    tagline: '选层/头/位置，实时看注意力在关注谁',
    hint: '互动模式：热力图每个格子都是真实的注意力概率。',
    camRows: [['overview', '全景'], ['zoom', '俯视']],
    boot: (ctx) => window.AttnViz.boot(ctx),
  });
})();
