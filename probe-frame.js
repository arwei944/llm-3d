/* 取景测量：给定场景索引与时间比例，算出「真正该被看到的那组物体」的屏幕包围盒，
 * 并报告相对画面中心的偏移与占比。用于把相机预设调准。
 * 用法： node probe-frame.js            # 默认测几个关键场景
 *        SCENE=8 FRAC=0.55 node probe-frame.js
 */
const path = require('path');
const URL = 'file:///' + path.join(__dirname, 'dist', 'index.html').replace(/\\/g, '/');
const W = parseInt(process.env.CW || '1600', 10), H = parseInt(process.env.CH || '900', 10);

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
  const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  return { send, logs };
}
const wait = ms => new Promise(r => setTimeout(r, ms));

/* 被测对象定义：在页面里按名字取一组 Mesh，算屏幕 AABB */
const TARGETS = `
window.__pt = function () {
  var F = window.__app.fwd;
  return {
    litCells: function () {
      var out = [], F = window.__app.fwd;
      var T = Math.min(16, F.S.seq.length);
      // 注意力矩阵点亮区域：i<T 且 j<=i（因果掩码）
      F.__matrices && F.__matrices[0].cells.forEach(function (m, k) {
        var i = Math.floor(k / 16), j = k % 16;
        if (m.visible && i < T && j <= i) out.push(m);
      });
      return out;
    },
    neurons: function () { return window.__app.fwd.__mlps[0].neurons; },
  };
};
`;

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
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' :: ' + e.slice(0, 60));
    return r.result && r.result.result ? r.result.result.value : null;
  };
  await wait(3000);
  for (let i = 0; i < 90; i++) { if (await evalv('window.__app && window.__app.bootDone')) break; await wait(1000); }

  // 暴露内部对象（viz-forward 的导出里没有 matrices/mlpGroups，用调试钩子）
  const exposed = await evalv('!!(window.__app.fwd.__matrices)');
  console.log('调试钩子 __matrices 可用:', exposed);
  if (!exposed) { console.log('需要先在 viz-forward.js 里导出 __matrices / __mlps'); process.exit(2); }
  await evalv(TARGETS);

  await evalv('window.LLMCine.setOn(true, {recording:true}); window.__app.recFreeze = true; 1');
  await wait(500);

  const cases = process.env.SCENE
    ? [{ scene: parseInt(process.env.SCENE, 10), frac: parseFloat(process.env.FRAC || '0.55'), what: process.env.WHAT || 'litCells' }]
    : [
      { scene: 4, frac: 0.55, what: 'all' },
      { scene: 7, frac: 0.55, what: 'litCells' },
      { scene: 8, frac: 0.55, what: 'litCells' },
      { scene: 10, frac: 0.55, what: 'neurons' },
      { scene: 11, frac: 0.55, what: 'neurons' },
      { scene: 13, frac: 0.55, what: 'all' },
    ];
  const cum = await evalv('window.LLMCine.cum');

  for (const cs of cases) {
    const t = cum[cs.scene] + (await evalv('window.LLMCine.scenes[' + cs.scene + '].dur')) * cs.frac;
    await evalv(`window.LLMCine.seek(${t}); window.LLMCine.render(); 1`);
    const info = await evalv(`(function(){
      var cam = window.__app.core.camera;
      cam.updateMatrixWorld(true);
      window.__app.core.scene.updateMatrixWorld(true);
      var sel;
      if ('${cs.what}' === 'all') {
        sel = window.__app.fwd.__matrices[0].cells.filter(function(m,k){return m.visible;})
          .concat(window.__app.fwd.__mlps[0].neurons);
      } else { sel = window.__pt()['${cs.what}'](); }
      if (!sel.length) return {n:0};
      var v = new THREE.Vector3(), minx=1e9,maxx=-1e9,miny=1e9,maxy=-1e9;
      sel.forEach(function(o){ o.updateWorldMatrix(true,false); v.setFromMatrixPosition(o.matrixWorld); v.project(cam);
        var sx=(v.x*0.5+0.5)*${W}, sy=(-v.y*0.5+0.5)*${H};
        if(sx<minx)minx=sx; if(sx>maxx)maxx=sx; if(sy<miny)miny=sy; if(sy>maxy)maxy=sy; });
      return { n: sel.length, minx:minx, maxx:maxx, miny:miny, maxy:maxy,
        w:maxx-minx, h:maxy-miny, cx:(minx+maxx)/2, cy:(miny+maxy)/2 };
    })()`);
    if (!info || !info.n) { console.log(`#${cs.scene} ${cs.what}: 没有可见对象`); continue; }
    const dx = info.cx - W / 2, dy = info.cy - H / 2;
    console.log(`#${String(cs.scene).padStart(2)} ${cs.what.padEnd(9)} n=${String(info.n).padStart(3)}  bbox ${info.w.toFixed(0)}x${info.h.toFixed(0)}px  ` +
      `中心(${info.cx.toFixed(0)},${info.cy.toFixed(0)})  偏移(${dx >= 0 ? '+' : ''}${dx.toFixed(0)}, ${dy >= 0 ? '+' : ''}${dy.toFixed(0)})  ` +
      `占画面 宽${(info.w / W * 100).toFixed(0)}% 高${(info.h / H * 100).toFixed(0)}%`);
  }
  console.log('异常:', logs.length ? logs.slice(0, 4).join(' || ') : '(none)');
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
