/* 探针：影片各时间点下，脚本指定的相机预设 vs 实际相机状态 */
const URL = 'file:///' + require('path').join(__dirname, 'dist', 'index.html').replace(/\\/g, '/');
async function cdp() {
  const list = await (await fetch('http://127.0.0.1:9334/json/list')).json();
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (m, p) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  return { send };
}
(async () => {
  const { send } = await cdp();
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: 'about:blank' }); await new Promise(r => setTimeout(r, 400));
  await send('Page.navigate', { url: URL });
  const probe = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return 'ERR: ' + r.result.exceptionDetails.text;
    return r.result && r.result.result ? r.result.result.value : null;
  };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await wait(3500);
  for (let i = 0; i < 60; i++) { if (await probe('window.__app && window.__app.bootDone')) break; await wait(1000); }
  // 关掉自动播放，避免测的时候时间在走
  await probe('window.__app.toggleCinema(true); window.LLMCine.pause(); 1');
  await wait(800);

  console.log('canvas/aspect:', await probe('(function(){var c=window.__app.core.renderer.domElement;return c.clientWidth+"x"+c.clientHeight+" aspect="+window.__app.core.camera.aspect.toFixed(3)+" fov="+window.__app.core.camera.fov})()'));

  for (const sec of [12, 40, 90, 150, 200, 250, 300, 340]) {
    const r = await probe(`(function(){
      var C=window.LLMCine, A=window.__app;
      C.seek(${sec * 1000});
      var i=0; for(var k=0;k<C.scenes.length;k++){ if(${sec * 1000}>=C.cum[k] && ${sec * 1000}<C.cum[k]+C.scenes[k].dur) i=k; }
      var sc=C.scenes[i];
      var mod = sc.mode==='fwd'?A.fwd:A.train;
      var want = mod.resolveCam(sc.cam);
      return { i:i, cam:sc.cam, mode:sc.mode,
        wantR:+want.r.toFixed(2), wantTgt:want.tgt.map(function(v){return +v.toFixed(1)}),
        wantTheta:want.theta, wantPhi:want.phi,
        gotR:+A.core.controls.currentDistance().toFixed(2),
        gotTgt:[+A.core.controls.target.x.toFixed(1),+A.core.controls.target.y.toFixed(1),+A.core.controls.target.z.toFixed(1)] };
    })()`);
    const ok = Math.abs(r.wantR - r.gotR) < 0.3;
    console.log(`[${String(sec).padStart(3)}s] #${r.i} ${r.mode}/${r.cam.padEnd(8)} 期望 r=${r.wantR} tgt=${JSON.stringify(r.wantTgt)} | 实际 r=${r.gotR} tgt=${JSON.stringify(r.gotTgt)}  ${ok ? 'OK' : '<<< 不一致'}`);
  }
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
