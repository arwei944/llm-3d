/* 用长序列复测矩阵/MLP 取景：序列短时可见格子只占网格一角，容易误判成"相机太远" */
const fs = require('fs'), path = require('path');
const SHOTDIR = path.join(__dirname, 'shots');
const URL = 'file:///' + path.join(__dirname, 'dist', 'index.html').replace(/\\/g, '/');
async function cdp() {
  const list = await (await fetch('http://127.0.0.1:9334/json/list')).json();
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0; const pending = new Map(); const logs = [];
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; logs.push('EXC ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text)); } });
  const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  return { send, logs, clear: () => { logs.length = 0; } };
}
(async () => {
  const { send, logs, clear } = await cdp();
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: 'about:blank' }); await new Promise(r => setTimeout(r, 400));
  clear();
  await send('Page.navigate', { url: URL });
  const probe = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : null; };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async (n) => { const s = await send('Page.captureScreenshot', { format: 'png' }); if (s.result && s.result.data) { fs.writeFileSync(SHOTDIR + '/' + n + '.png', Buffer.from(s.result.data, 'base64')); console.log('  shot', n); } };
  await wait(3500);
  for (let i = 0; i < 60; i++) { if (await probe('window.__app && window.__app.bootDone')) break; await wait(1000); }

  // 构造一个 14 token 的序列（接近 CTX 上限），让矩阵近似铺满 16×16 网格
  const setup = await probe(`(function(){
    var A = window.__app;
    A.fwd.S.seq = [1,5,9,2,7,0,3,8,1,6,4,9,2,5];
    A.fwd.refresh();
    var c = A.fwd.getCache();
    return 'T=' + c.T + ' seq=' + A.fwd.S.seq.join('');
  })()`);
  console.log('序列:', setup);

  for (const [cam, idx, name] of [['matrix', 5, 'f1-matrix-full'], ['mlp', 9, 'f2-mlp-full'], ['layer', 5, 'f3-layer-full']]) {
    await probe(`(function(){ var A=window.__app; A.fwd.gotoStep(${idx},1); A.fwd.applyCam('${cam}'); A.fwd.update(performance.now()); return 1; })()`);
    await wait(1200);
    await shot(name);
  }

  // 统计矩阵实际可见格子数与屏幕包围盒（相机状态与测量放在同一次求值内）
  console.log(await probe(`(function(){
    var A=window.__app, cam=A.core.camera, T=window.THREE;
    A.fwd.gotoStep(5,1); A.fwd.applyCam('matrix');
    for (var i=0;i<60;i++) A.core.controls.update();
    A.fwd.update(performance.now());
    cam.updateMatrixWorld(true); cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    var dom=A.core.renderer.domElement, w=dom.clientWidth, h=dom.clientHeight;
    function scr(v){ v.project(cam); return [(v.x*0.5+0.5)*w, (-v.y*0.5+0.5)*h]; }
    var tg = A.core.controls.target;
    var box={x0:1e9,y0:1e9,x1:-1e9,y1:-1e9}, n=0;
    A.fwd.root.traverse(function(o){
      if(o.isMesh && o.visible && o.geometry && o.geometry.type==='PlaneGeometry' && Math.abs(o.geometry.parameters.width-0.34*0.86)<1e-6){
        var s = scr(o.getWorldPosition(new T.Vector3())); n++;
        box.x0=Math.min(box.x0,s[0]); box.x1=Math.max(box.x1,s[0]);
        box.y0=Math.min(box.y0,s[1]); box.y1=Math.max(box.y1,s[1]);
      }
    });
    return ['可见矩阵格子数=' + n,
      '格子屏幕包围盒 x[' + Math.round(box.x0) + ',' + Math.round(box.x1) + '] y[' + Math.round(box.y0) + ',' + Math.round(box.y1) + '] (' + Math.round(box.x1-box.x0) + 'x' + Math.round(box.y1-box.y0) + 'px，画布 ' + w + 'x' + h + ')',
      'camPos=' + cam.position.toArray().map(function(v){return +v.toFixed(2)}),
      'target=' + [+tg.x.toFixed(2),+tg.y.toFixed(2),+tg.z.toFixed(2)],
      'dist=' + +A.core.controls.currentDistance().toFixed(2),
      'proj(target)=' + scr(new T.Vector3(tg.x,tg.y,tg.z)).map(Math.round),
      'proj(格子中心-7.94,7.2,-0.5)=' + scr(new T.Vector3(-7.94,7.2,-0.5)).map(Math.round)
    ].join('\\n');
  })()`));

  console.log('errors:', logs.length ? logs.slice(0, 3).join(' || ') : '(none)');
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
