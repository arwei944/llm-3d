/* 取景求解器：把每个相机预设标定成「内容居中 + 占比合适」。
 *
 * 做法：页面内把该预设要看的那组物体**强制设为可见**（避免动画中途的可见性
 * 影响测量），算出它们的世界 AABB，投影 8 个角得到屏幕包围盒；
 * 然后迭代微调 target（用相机基向量换算像素→世界）与距离 r（按包围盒比例缩放），
 * 直到包围盒中心落在目标点、且最大边达到期望占比。
 *
 * 占比约束按"留白带"给：标题在顶部约 140px、字幕条在底部约 110px（1080p），
 * 所以内容最多占画面高的 68%、宽的 90%，且中心略低于几何中心。
 *
 * 用法： CW=1920 CH=1080 node solve-cams.js
 */
const path = require('path');
const URL = 'file:///' + path.join(__dirname, 'dist', 'index.html').replace(/\\/g, '/');
const W = parseInt(process.env.CW || '1920', 10), H = parseInt(process.env.CH || '1080', 10);

async function cdp() {
  const list = await (await fetch('http://127.0.0.1:9334/json/list')).json();
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0; const pending = new Map(); const logs = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; logs.push((d.exception && (d.exception.description || d.exception.value)) || d.text); }
  });
  const send = (m, p) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  return { send, logs };
}
const wait = ms => new Promise(r => setTimeout(r, ms));

/* 每个预设要看的内容（页面内表达式，返回 Object3D 数组）+ 在哪个场景取样
 * capH：内容最多占画面高的比例 —— 顶部有标题、底部有字幕条，得留白带 */
const SPECS = [
  { mode: 'fwd', preset: 'overview', scene: 12, capH: 0.76, sel: "window.__app.fwd.__groups.root.children.filter(function(c,i){return i!==4;})" },
  { mode: 'fwd', preset: 'layer', scene: 4, capH: 0.66, sel: "window.__app.fwd.__groups.layers[0].children.filter(function(c,i){return i>1;})" },
  { mode: 'fwd', preset: 'matrix', scene: 8, capH: 0.66, sel: "window.__app.fwd.__matrices[0].cells.filter(function(m,i){var T=Math.min(16,window.__app.fwd.S.seq.length);return (i>>4)<T && (i&15)<=(i>>4);})" },
  { mode: 'fwd', preset: 'mlp', scene: 11, capH: 0.66, sel: "window.__app.fwd.__mlps[0].g.children" },
  { mode: 'fwd', preset: 'head', scene: 14, capH: 0.70, sel: "window.__app.fwd.__groups.root.children[8].children" },
  { mode: 'fwd', preset: 'tokens', scene: 1, capH: 0.76, sel: "[window.__app.fwd.__groups.root.children[0],window.__app.fwd.__groups.root.children[1],window.__app.fwd.__groups.root.children[5]]" },
  { mode: 'train', preset: 'overview', scene: 19, capH: 0.80, sel: "window.__app.train.root.children" },
  { mode: 'train', preset: 'batch', scene: 20, capH: 0.68, sel: "window.__app.train.__boards.batch.children.filter(function(c,i){return i>1;})" },
  { mode: 'train', preset: 'forward', scene: 21, capH: 0.70, sel: "window.__app.train.__boards.fwd.children.filter(function(c,i){return i>1;})" },
  { mode: 'train', preset: 'loss', scene: 22, capH: 0.66, sel: "window.__app.train.__boards.loss.children.filter(function(c,i){return i>1;})" },
  { mode: 'train', preset: 'backward', scene: 23, capH: 0.66, sel: "window.__app.train.__boards.back.children.filter(function(c,i){return i>1;})" },
  { mode: 'train', preset: 'optim', scene: 25, capH: 0.66, sel: "window.__app.train.__boards.opt.children.filter(function(c,i){return i>1;})" },
  { mode: 'train', preset: 'curve', scene: 26, capH: 0.56, sel: "window.__app.train.__boards.curve.children" },
];

const MEASURE = (sel, W, H) => `(function(){
  var cam = window.__app.core.camera;
  window.__app.core.scene.updateMatrixWorld(true);
  var sel = ${sel};
  // 只统计实体几何（Mesh / Sprite）。粒子、连线是装饰性的，
  // 位置每帧都在动，纳入包围盒会把取景彻底带偏。
  var saved = [], savedVis = [];
  sel.forEach(function(o){ o.traverse(function(n){ if(n.isMesh||n.isSprite){ saved.push(n); savedVis.push(n.visible); } }); });
  saved.forEach(function(n){ n.visible = true; });
  window.__app.core.scene.updateMatrixWorld(true);

  var box = new THREE.Box3();
  var v = new THREE.Vector3();
  sel.forEach(function(o){
    o.updateWorldMatrix(true, false);
    o.traverse(function(n){
      if (!n.isMesh && !n.isSprite) return;
      if (n.isSprite) {
        n.getWorldPosition(v);
        box.expandByPoint(new THREE.Vector3(v.x-n.scale.x/2, v.y-n.scale.y/2, v.z));
        box.expandByPoint(new THREE.Vector3(v.x+n.scale.x/2, v.y+n.scale.y/2, v.z));
      } else if (n.geometry) {
        if (!n.geometry.boundingBox) n.geometry.computeBoundingBox();
        var b = n.geometry.boundingBox.clone();
        b.applyMatrix4(n.matrixWorld);
        box.union(b);
      }
    });
  });
  saved.forEach(function(n,i){ n.visible = savedVis[i]; });

  if (box.isEmpty()) return { empty: true };
  var c = box.getCenter(new THREE.Vector3());
  var minx=1e9,maxx=-1e9,miny=1e9,maxy=-1e9;
  for (var i=0;i<8;i++){
    v.set(i&1?box.max.x:box.min.x, i&2?box.max.y:box.min.y, i&4?box.max.z:box.min.z);
    v.project(cam);
    var sx=(v.x*0.5+0.5)*${W}, sy=(-v.y*0.5+0.5)*${H};
    if(sx<minx)minx=sx; if(sx>maxx)maxx=sx; if(sy<miny)miny=sy; if(sy>maxy)maxy=sy;
  }
  // 相机右/上基向量 + 目标处 1 世界单位对应的像素数
  var e = cam.matrixWorld.elements;
  var right = new THREE.Vector3(e[0],e[1],e[2]);
  var up    = new THREE.Vector3(e[4],e[5],e[6]);
  var tgt = new THREE.Vector3(cam.userData.tgt.x, cam.userData.tgt.y, cam.userData.tgt.z);
  function proj(p){ var q=p.clone().project(cam); return { x:(q.x*0.5+0.5)*${W}, y:(-q.y*0.5+0.5)*${H} }; }
  var p0 = proj(tgt), pR = proj(tgt.clone().add(right)), pU = proj(tgt.clone().add(up));
  return {
    w:maxx-minx, h:maxy-miny, cx:(minx+maxx)/2, cy:(miny+maxy)/2,
    wc: box.max.x-box.min.x, hc: box.max.y-box.min.y, dc: box.max.z-box.min.z,
    cc: [c.x, c.y, c.z],
    J: [[pR.x-p0.x, pU.x-p0.x],[pR.y-p0.y, pU.y-p0.y]],
  };
})()`;

(async () => {
  const { send, logs } = await cdp();
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: 'about:blank' }); await wait(400);
  logs.length = 0;
  await send('Page.navigate', { url: URL });
  const evalv = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' :: ' + e.slice(0, 70));
    return r.result && r.result.result ? r.result.result.value : null;
  };
  await wait(3000);
  for (let i = 0; i < 90; i++) { if (await evalv('window.__app && window.__app.bootDone')) break; await wait(1000); }
  await evalv('window.LLMCine.setOn(true, {recording:true}); window.__app.recFreeze = true; 1');
  await wait(600);

  const cum = await evalv('window.LLMCine.cum');
  const CX = W / 2, CY = H * 0.53;          // 内容中心目标（略低于几何中心，给顶部标题让位）
  const CAP_W = W * 0.90;                   // 宽度上限（避开左右边缘）

  console.log('目标：中心 (' + CX.toFixed(0) + ',' + CY.toFixed(0) + ')   宽上限 ' + CAP_W.toFixed(0) + 'px   高度按预设定\n');
  const results = [];
  for (const sp of SPECS) {
    const dur = await evalv('window.LLMCine.scenes[' + sp.scene + '].dur');
    // 取 0.90：fwd 步骤动画在 82% 走完、train 阶段在 75% 推到满，此处画面已稳定
    const t = cum[sp.scene] + dur * 0.90;
    const CAP_H = H * sp.capH;
    await evalv(`window.LLMCine.seek(${t}); 1`);
    // 记录当前实际生效的 tgt/r（resolveCam 的结果），供测量里的雅可比用
    const cur = await evalv(`(function(){
      var m = ${sp.mode === 'fwd' ? 'window.__app.fwd' : 'window.__app.train'};
      var c = m.resolveCam('${sp.preset}');
      var cam = window.__app.core.camera;
      cam.userData.tgt = { x:c.tgt[0], y:c.tgt[1], z:c.tgt[2] };
      return { tgt:c.tgt, r:c.r, theta:c.theta, phi:c.phi };
    })()`);
    let tgt = cur.tgt.slice(), r = cur.r;
    const th = cur.theta, ph = cur.phi;

    let info = null;
    for (let it = 0; it < 8; it++) {
      await evalv(`(function(){
        var m = ${sp.mode === 'fwd' ? 'window.__app.fwd' : 'window.__app.train'};
        m.applyCamAt(${th}, ${ph}, ${r}, [${tgt.join(',')}]);
        var cam = window.__app.core.camera;
        cam.userData.tgt = { x:${tgt[0]}, y:${tgt[1]}, z:${tgt[2]} };
        cam.updateMatrixWorld(true);
      })()`);
      info = await evalv(MEASURE(sp.sel, W, H));
      if (info.empty) break;
      // 缩放：让最大边达到上限
      const s = Math.max(info.w / CAP_W, info.h / CAP_H);
      r = r * s;
      // 平移：把包围盒中心拉回 (CX,CY)
      // 相机整体平移 δ 时，画面上的点反向移动 M·δ（M = 世界→像素雅可比）。
      // 要画面移动 (-dx,-dy)，就得 δ = M⁻¹·(dx,dy)。
      const dx = info.cx - CX, dy = info.cy - CY;
      const J = info.J;
      const det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
      if (Math.abs(det) > 1e-9) {
        const a = (J[1][1] * dx - J[0][1] * dy) / det;
        const b = (-J[1][0] * dx + J[0][0] * dy) / det;
        const el = await evalv('(function(){var m=window.__app.core.camera.matrixWorld.elements;return [m[0],m[1],m[2],m[4],m[5],m[6]];})()');
        tgt = [tgt[0] + a * el[0] + b * el[3], tgt[1] + a * el[1] + b * el[4], tgt[2] + a * el[2] + b * el[5]];
      }
    }
    if (info && !info.empty) {
      console.log(`fwd/train ${sp.mode.padEnd(5)} ${sp.preset.padEnd(9)}  bbox ${info.w.toFixed(0)}x${info.h.toFixed(0)}px  中心(${info.cx.toFixed(0)},${info.cy.toFixed(0)})  ` +
        `占宽${(info.w / W * 100).toFixed(0)}% 占高${(info.h / H * 100).toFixed(0)}%`);
      console.log(`             tgt: [${tgt.map(v => +v.toFixed(2)).join(', ')}], r: ${r.toFixed(1)}   (内容世界尺寸 ${info.wc.toFixed(1)}x${info.hc.toFixed(1)}x${info.dc.toFixed(1)})`);
      results.push({ mode: sp.mode, preset: sp.preset, tgt: tgt.map(v => +v.toFixed(2)), r: +r.toFixed(1) });
    } else console.log(`${sp.mode}/${sp.preset}: 空`);
  }
  console.log('\n// ---- 求解结果（可直接粘进 camTable）----');
  for (const r of results) console.log(`  // ${r.mode} ${r.preset}\n  ${r.preset}: { tgt: [${r.tgt.join(', ')}], theta: …, phi: …, r: ${r.r} },`);
  console.log('\n异常:', logs.length ? logs.slice(0, 4).join(' || ') : '(none)');
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
