/* 机位候选对比：对指定场景套若干组 (theta,phi,r,tgt)，各截一帧，拼成对比图。
 * 用法： node try-cam.js
 */
const fs = require('fs'), path = require('path');
const OUTDIR = path.join(__dirname, 'shots', 'try');
fs.mkdirSync(OUTDIR, { recursive: true });
const URL = 'file:///' + path.join(__dirname, 'dist', 'index.html').replace(/\\/g, '/');

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

/* 候选：[标签, 场景号, 场景内比例, 模式, theta, phi, r, tgt] */
const CAND = [
  ['A-phi0.80-r15.0', 4, 0.92, 'fwd', 0.40, 0.80, 15.0, [0.4, 7.2, 0.4]],
  ['B-phi0.62-r13.0', 4, 0.92, 'fwd', 0.40, 0.62, 13.0, [0.0, 7.2, 0.6]],
  ['C-phi0.80-r18.5', 4, 0.92, 'fwd', 0.40, 0.80, 18.5, [0.4, 7.2, 0.2]],
  ['D-phi0.92-r14.0', 4, 0.92, 'fwd', 0.40, 0.92, 14.0, [0.6, 7.2, 0.6]],
];

(async () => {
  const { send, logs } = await cdp();
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: 'about:blank' }); await wait(400);
  await send('Page.navigate', { url: URL });
  const evalv = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result && r.result.result ? r.result.result.value : null;
  };
  await wait(3000);
  for (let i = 0; i < 90; i++) { if (await evalv('window.__app && window.__app.bootDone')) break; await wait(1000); }
  await evalv('window.LLMCine.setOn(true, {recording:true}); window.__app.recFreeze = true; 1');
  await wait(500);
  const cum = await evalv('window.LLMCine.cum');

  for (const [tag, sc, frac, mode, th, ph, r, tgt] of CAND) {
    const dur = await evalv('window.LLMCine.scenes[' + sc + '].dur');
    await evalv(`window.LLMCine.seek(${cum[sc] + dur * frac}); 1`);
    await evalv(`(function(){var m=window.__app.${mode};m.applyCamAt(${th},${ph},${r},[${tgt.join(',')}]);window.LLMCine.render();})()`);
    const s = await send('Page.captureScreenshot', { format: 'jpeg', quality: 85 });
    fs.writeFileSync(path.join(OUTDIR, tag + '.jpg'), Buffer.from(s.result.data, 'base64'));
    console.log('shot', tag);
  }
  console.log('异常:', logs.length ? logs.slice(0, 3).join(' || ') : '(none)');
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
