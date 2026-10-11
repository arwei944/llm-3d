/* 枚举 -3D 场景里各组的子对象，用于确定相机取景框该选哪些内容 */
const path = require('path');
const URL = 'file:///' + path.join(__dirname, 'dist', 'index.html').replace(/\\/g, '/');

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
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const { send } = await cdp();
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'about:blank' }); await wait(400);
  await send('Page.navigate', { url: URL });
  const evalv = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result && r.result.result ? r.result.result.value : null;
  };
  await wait(3000);
  for (let i = 0; i < 90; i++) { if (await evalv('window.__app && window.__app.bootDone')) break; await wait(1000); }
  await evalv('window.__app.setMode("fwd"); window.LLMCine.seek(0); 1');
  await wait(300);

  const dump = async (label, expr) => {
    const rows = await evalv(`(function(){
      var arr = ${expr};
      return arr.map(function(o,i){
        var g = o.geometry;
        var info = { i:i, type:o.type, name:o.name||'', vis:o.visible };
        if (o.isSprite) info.scale = o.scale.x.toFixed(2)+'x'+o.scale.y.toFixed(2);
        if (g && g.parameters) { var p=g.parameters; info.geo = g.type+' '+['width','height','radius','depth','radiusTop'].map(function(k){return p[k]!==undefined?k+'='+p[k]:null}).filter(Boolean).join(','); }
        else if (g) info.geo = g.type;
        info.pos = [o.position.x, o.position.y, o.position.z].map(function(v){return +v.toFixed(2)}).join(',');
        return info;
      });
    })()`);
    console.log('\n=== ' + label + ' (' + rows.length + ') ===');
    for (const r of rows) console.log(`  [${String(r.i).padStart(2)}] ${r.type.padEnd(10)} ${(r.geo || '').padEnd(42)} pos(${r.pos}) ${r.scale ? 'scale ' + r.scale : ''} ${r.vis ? '' : 'HIDDEN'}`);
  };

  await dump('fwd layer0 children', 'window.__app.fwd.__groups.layers[0].children');
  await dump('fwd root children', 'window.__app.fwd.__groups.root.children');

  // 训练：切过去
  await evalv('window.__app.setMode("train"); 1');
  await wait(400);
  for (const k of ['batch', 'fwd', 'loss', 'back', 'opt', 'curve']) {
    await dump('train.' + k + ' children', `window.__app.train.__boards.${k}.children`);
  }
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
