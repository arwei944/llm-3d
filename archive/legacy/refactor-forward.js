/* 重新生成 src/viz-forward.js：保留 布局/图元/场景/步骤脚本/updateVisuals/相机/HUD，
 * 去掉 DOM 事件绑定、主循环与自启动（这些归 app.js）。 */
const fs = require('fs');
const src = fs.readFileSync('viz.js', 'utf8');
const OUT = 'src/viz-forward.js';

const a = src.indexOf('// ============================================================ 布局常量');
const b = src.indexOf('  // ============================================================ 交互');
if (a < 0 || b < 0) throw new Error('anchor missing: ' + a + ',' + b);
const body = src.slice(a, b);

// 提取 DESC
const dStart = src.indexOf('const DESC = {');
const dEnd = src.indexOf('\n  };', dStart) + '\n  };'.length;
if (dStart < 0) throw new Error('DESC missing');
const DESC = src.slice(dStart, dEnd);

const head = `(function () {
  'use strict';

  const LM = window.TinyLM;
  const CFG = LM.CFG;
  const { V, D, NH, dh, FF, NL } = CFG;
  const { PAL, makeTextSprite, setLabel, roundedBoxGeo, roundRect } = window.LLMCore;
  const col = (h) => new THREE.Color(h);

  let core = null, scene = null, camera = null, controls = null;

  const S = {
    model: null, trained: false,
    prompt: [1, 5, 9, 2, 0, 7], seq: [], step: 0,
    playing: true, speed: 1, showMatrix: true, showHeat: true,
    reduceMotion: false, lastSample: null,
  };

  function boot(coreRef) {
    core = coreRef; scene = core.scene; camera = core.camera; controls = core.controls;

`;

const tail = `
  // ============================================================ 对外接口（app.js 调度）
  function getHud() {
    const st = STEPS[stepIdx];
    const p = Math.min(1, stepT / st.ms);
    return {
      stage: st.name, desc: DESC[st.id] || '', formula: st.formula,
      pill: \`步骤 \${stepIdx + 1}/\${STEPS.length} · \${(p * 100).toFixed(0)}%\`,
      seq: S.seq.slice(), progress: p,
    };
  }

  function getLayerProgress() {
    const st = STEPS[stepIdx];
    const p = Math.min(1, stepT / st.ms);
    const out = [];
    for (let l = 0; l < NL; l++) {
      if (st.layer === l) out.push({ l, p, val: Math.round(p * 100) + '%' });
      else if (indexOfAfterLayer(l) < stepIdx) out.push({ l, p: 1, val: 'done' });
      else out.push({ l, p: 0, val: '—' });
    }
    return out;
  }

  return {
    S, STEPS, LAY, layerY, applyCam, gotoStep,
    update: updateVisuals,
    getHud, getLayerProgress,
    root: G.root,
    setModel: function (m) {
      S.model = m; S.trained = true; S.seq = S.prompt.slice(); S.step = 0;
      stepIdx = 0; stepT = 0; S.phase = 'run'; S.playing = true;
      cache = LM.forward(m, S.seq);
    },
    advance: advance,
    refresh: function () { cache = LM.forward(S.model, S.seq); },
    getCache: function () { return cache; },
  };
  }

  window.FwdViz = { boot: boot };
})();
`;

fs.writeFileSync(OUT, head + body + tail);
console.log('regenerated', OUT);