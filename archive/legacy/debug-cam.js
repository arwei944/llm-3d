/* 定点排错：相机目标点投影到屏幕，理应精确落在画布中心 */
const URL = 'file:///' + require('path').join(__dirname, 'dist', 'index.html').replace(/\\/g, '/');
async function cdp() {
  const list = await (await fetch('http://127.0.0.1:9334/json/list')).json();
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  return { send };
}
(async () => {
  const { send } = await cdp();
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: 'about:blank' }); await new Promise(r => setTimeout(r, 400));
  await send('Page.navigate', { url: URL });
  const probe = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : (r.result && r.result.exceptionDetails ? 'ERR ' + JSON.stringify(r.result.exceptionDetails.text) : null); };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await wait(3500);
  for (let i = 0; i < 60; i++) { if (await probe('window.__app && window.__app.bootDone')) break; await wait(1000); }

  console.log(await probe(`(function(){
    var A = window.__app, cam = A.core.camera, T = window.THREE;
    A.fwd.applyCam('layer');
    for (var i=0;i<60;i++) A.core.controls.update();
    cam.updateMatrixWorld(true);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    var dom = A.core.renderer.domElement, w = dom.clientWidth, h = dom.clientHeight;
    function scr(x,y,z){ var p=new T.Vector3(x,y,z); p.project(cam); return [Math.round((p.x*0.5+0.5)*w), Math.round((-p.y*0.5+0.5)*h)]; }
    var t = A.core.controls.target;
    return [
      'canvas=' + w + 'x' + h,
      'camPos=' + cam.position.toArray().map(function(v){return +v.toFixed(2)}),
      'target=' + [+t.x.toFixed(2), +t.y.toFixed(2), +t.z.toFixed(2)],
      'dist=' + +A.core.controls.currentDistance().toFixed(2),
      'proj(target)=' + scr(t.x, t.y, t.z),
      'proj(0,7.2,0)=' + scr(0, 7.2, 0),
      'proj(0,0,0)=' + scr(0, 0, 0),
      'aspect=' + cam.aspect,
      'dpr=' + A.core.renderer.getPixelRatio(),
      'drawBuf=' + A.core.renderer.getSize(new T.Vector2()).toArray(),
      'fov=' + cam.fov,
      'quat=' + cam.quaternion.toArray().map(function(v){return +v.toFixed(3)})
    ].join('\\n');
  })()`));
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
