/* 探针：量化各视角预设下，目标物体在屏幕上的实际范围与偏移 */
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
  const probe = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : null; };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await wait(3500);
  for (let i = 0; i < 60; i++) { if (await probe('window.__app && window.__app.bootDone')) break; await wait(1000); }

  // 把图层/矩阵/MLP 的世界坐标找到，并投影到屏幕
  const info = await probe(`(function(){
    var A = window.__app, S = A.core.scene, cam = A.core.camera;
    function screenOf(v){
      var p = v.clone(); p.project(cam);
      var w = A.core.renderer.domElement.clientWidth, h = A.core.renderer.domElement.clientHeight;
      return { x: Math.round((p.x*0.5+0.5)*w), y: Math.round((-p.y*0.5+0.5)*h), w: w, h: h };
    }
    var out = { fov: cam.fov, camPos: cam.position.toArray().map(function(v){return +v.toFixed(2)}),
                tgt: [A.core.controls.target.x, A.core.controls.target.y, A.core.controls.target.z].map(function(v){return +v.toFixed(2)}),
                canvas: [A.core.renderer.domElement.clientWidth, A.core.renderer.domElement.clientHeight] };
    // 在 fwd root 下找带 '注意力矩阵' 标签的 holder：改为直接按名字找 group 不顺，改为遍历
    var found = [];
    A.fwd.root.traverse(function(o){ if(o.isGroup) found.push(o); });
    return out;
  })()`);
  console.log('相机:', JSON.stringify(info));

  // 逐个视角预设：应用后测量目标物体在屏幕上的实际范围与偏移
  const CASES = [
    ['overview', 0, '矩阵', `[-7.6-half, ly+0.09, -half]`, `[-7.6+half, ly+0.09, half]`],
    ['matrix', 5, '矩阵', `[-7.6-half, ly+0.09, -half]`, `[-7.6+half, ly+0.09, half]`],
    ['mlp', 9, 'MLP', `[7.9-half2, ly+0.1, -half2]`, `[7.9+half2, ly+0.1, half2]`],
    ['head', 22, '输出头', `[-6, ly2, -6]`, `[6, ly2, 6]`],
    ['tokens', 1, 'Token行', `[-9, 0.2, -3]`, `[9, 0.2, 3]`],
    ['layer', 3, '层平面', `[-11, ly, -4]`, `[11, ly, 4]`],
  ];
  for (const [cam, idx, label, p1, p2] of CASES) {
    const m = await probe(`(function(){
      var A = window.__app, cam = A.core.camera, T = window.THREE;
      A.fwd.gotoStep(${idx}, 1);
      A.fwd.applyCam('${cam}');
      for (var i=0;i<40;i++) A.core.controls.update();   // 让阻尼收敛
      A.fwd.update(performance.now());
      // three 的 Vector3.project() 用的是渲染时缓存的 matrixWorldInverse，
      // 这里没经过 render，必须手动刷新，否则量到的是上一帧的相机状态。
      cam.updateMatrixWorld(true);
      cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
      cam.updateProjectionMatrix();
      var dom = A.core.renderer.domElement, w = dom.clientWidth, h = dom.clientHeight;
      function scr(a){ var p=new T.Vector3(a[0],a[1],a[2]); p.project(cam); return {x:Math.round((p.x*0.5+0.5)*w), y:Math.round((-p.y*0.5+0.5)*h)}; }
      var ly = 7.2, ly2 = 3.0 + 4.2 + 1*7.6;
      var half = 16*0.34/2, half2 = (8-1)/2*0.46 + 0.2;
      var a = scr(${p1}), b = scr(${p2});
      return { canvas:[w,h], a:a, b:b,
               spanX: Math.abs(b.x-a.x), spanY: Math.abs(b.y-a.y),
               cx: Math.round((a.x+b.x)/2), cy: Math.round((a.y+b.y)/2),
               r: +A.core.controls.currentDistance().toFixed(2) };
    })()`);
    console.log(`[${cam.padEnd(8)}] 视角目标「${label}」: 屏幕范围 ${m.spanX}×${m.spanY}px / canvas ${m.canvas[0]}×${m.canvas[1]}` +
      ` | 中心 (${m.cx},${m.cy}) vs 画布中心 (${m.canvas[0] / 2},${m.canvas[1] / 2}) | r=${m.r}`);
  }
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
