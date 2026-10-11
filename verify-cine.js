/* 影片模式冒烟验证：在多个时间点 seek，检查状态与异常，并截图 */
const fs = require('fs'), path = require('path');
const SHOTDIR = path.join(__dirname, 'shots', 'cine');
fs.mkdirSync(SHOTDIR, { recursive: true });
const URL = 'file:///' + path.join(__dirname, 'dist', 'index.html').replace(/\\/g, '/');

async function cdp() {
  const list = await (await fetch('http://127.0.0.1:' + (process.env.PORT || '9334') + '/json/list')).json();
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0; const pending = new Map(); const logs = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push('EXC ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
    }
  });
  const send = (m, p) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  return { send, logs, clear: () => { logs.length = 0; } };
}

(async () => {
  const W = parseInt(process.env.CW || '1600', 10), H = parseInt(process.env.CH || '900', 10);
  const { send, logs, clear } = await cdp();
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: 'about:blank' }); await new Promise(r => setTimeout(r, 400));
  clear();
  await send('Page.navigate', { url: URL });
  const probe = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return 'ERR: ' + r.result.exceptionDetails.text;
    return r.result && r.result.result ? r.result.result.value : null;
  };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async (n) => { const s = await send('Page.captureScreenshot', { format: 'jpeg', quality: 80 }); if (s.result && s.result.data) { fs.writeFileSync(SHOTDIR + '/' + n + '.jpg', Buffer.from(s.result.data, 'base64')); } };

  await wait(3500);
  for (let i = 0; i < 60; i++) { if (await probe('window.__app && window.__app.bootDone')) break; await wait(1000); }
  console.log('bootDone ok');

  console.log('影片总时长:', await probe('Math.round(window.LLMCine.total/1000) + "s / " + window.LLMCine.scenes.length + " 个场景"'));
  console.log('场景时长合计校验:', await probe('(function(){var c=window.LLMCine;var s=0;for(var i=0;i<c.scenes.length;i++)s+=c.scenes[i].dur;return s===c.total})()'));

  await probe('window.__app.toggleCinema(true)');
  await wait(1200);
  console.log('cinema on:', await probe('window.LLMCine.isOn()'), '| panel display:',
    await probe('getComputedStyle(document.getElementById("panel")).display'));
  console.log('canvas 尺寸:', await probe('(function(){var c=window.__app.core.renderer.domElement;return c.clientWidth+"x"+c.clientHeight})()'));

  const marks = [0, 12, 40, 90, 150, 200, 250, 300, 340];
  for (const sec of marks) {
    const t = sec * 1000;
    const info = await probe(`(function(){
      var C = window.LLMCine;
      C.seek(${t}); C.render();
      var sc = null, acc = 0, i = 0;
      for (var k = 0; k < C.scenes.length; k++) { if (${t} >= C.cum[k] && ${t} < C.cum[k] + C.scenes[k].dur) { sc = C.scenes[k]; i = k; } }
      return {
        i: i, act: sc.act, title: sc.title, mode: sc.mode,
        caption: document.getElementById('cineCaption').textContent.slice(0, 44),
        big: document.body.classList.contains('cineBig'),
        card: document.getElementById('cineCard').classList.contains('on'),
        appMode: window.__app.mode,
        step: (window.__app.fwd.STEPS[window.__app.fwd.S ? -1 : -1], null),
        trainStep: window.__app.trainModel ? (window.__app.trainModel._adam ? window.__app.trainModel._adam.t : 0) : 0
      };
    })()`);
    console.log(`[${String(sec).padStart(3)}s] #${info.i} ${info.mode.padEnd(5)} app=${info.appMode.padEnd(5)} big=${info.big ? 1 : 0} card=${info.card ? 1 : 0} trainT=${info.trainStep}`);
    console.log(`        ${info.act} / ${info.title}`);
    console.log(`        「${info.caption}」`);
    await shot('t' + String(sec).padStart(3, '0'));
  }

  console.log('errors:', logs.length ? logs.slice(0, 5).join(' || ') : '(none)');
  console.log('错误总数:', logs.length);
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
