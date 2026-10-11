/* 逐场景采样：在每个场景 55% 处截一帧，并打印场景时间表。
 * 之后用 ffmpeg tile 拼成联络表，一次性检视全片构图。
 * 用法： CW/CH 控制视口；OUTDIR 控制输出目录
 */
const fs = require('fs'), path = require('path');
const OUTDIR = process.env.OUTDIR || path.join(__dirname, 'shots', 'scenes');
fs.mkdirSync(OUTDIR, { recursive: true });
const W = parseInt(process.env.CW || '1600', 10), H = parseInt(process.env.CH || '900', 10);
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
  const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  return { send, logs };
}
const wait = ms => new Promise(r => setTimeout(r, ms));

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
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result && r.result.result ? r.result.result.value : null;
  };
  await wait(3000);
  for (let i = 0; i < 90; i++) { if (await evalv('window.__app && window.__app.bootDone')) break; await wait(1000); }
  await evalv('window.LLMCine.setOn(true, {recording:true}); window.__app.recFreeze = true; 1');
  await wait(600);

  const list = await evalv('window.LLMCine.scenes.map(function(s,i){return {i:i,act:s.act,title:s.title,mode:s.mode,cam:s.cam,step:s.steps?JSON.stringify(s.steps):"",train:s.trainAt?JSON.stringify(s.trainAt):"",grow:s.growTokens||0,card:s.card||"",dur:s.dur}})');
  const cum = await evalv('window.LLMCine.cum');
  const FPSMAP = {};
  console.log('idx  起-止(s)      模式   预设      时长  步/阶段              备注   标题');
  for (const s of list) {
    const a = cum[s.i] / 1000, b = (cum[s.i] + s.dur) / 1000;
    console.log(
      String(s.i).padStart(3) + '  ' +
      (a.toFixed(0) + '-' + b.toFixed(0)).padStart(11) + '  ' +
      s.mode.padEnd(6) + s.cam.padEnd(10) + String(s.dur / 1000).padStart(4) + 's  ' +
      (s.step || s.train || '').padEnd(20) + ' ' +
      ((s.grow ? 'grow' + s.grow : '') + (s.card ? ' card:' + s.card : '')).padEnd(7) + ' ' + s.title);
  }

  for (const s of list) {
    const t = cum[s.i] + s.dur * 0.55;
    await evalv(`window.LLMCine.seek(${t}); window.LLMCine.render(); 1`);
    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
    fs.writeFileSync(path.join(OUTDIR, String(s.i).padStart(2, '0') + '.jpg'), Buffer.from(shot.result.data, 'base64'));
  }
  console.log('\n截图完成 →', OUTDIR);
  console.log('异常:', logs.length ? logs.slice(0, 4).join(' || ') : '(none)');
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
