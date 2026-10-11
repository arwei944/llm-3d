/* 零依赖 CDP 驱动：加载页面 → 收集报错 → 等待训练完成 → 截图 */
const fs = require('fs');
const SHOTDIR = require('path').join(__dirname, 'shots');
fs.mkdirSync(SHOTDIR, { recursive: true });

async function cdp() {
  const list = await (await fetch('http://127.0.0.1:9334/json/list')).json();
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push({ type: m.params.type, text: m.params.args.map(a => a.value !== undefined ? a.value : (a.description || a.type)).join(' ') });
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push({ type: 'exception', text: (d.exception && (d.exception.description || d.exception.value)) || d.text });
    }
    if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error' || e.level === 'warning') logs.push({ type: 'log:' + e.level, text: e.text + ' @' + (e.url || '') });
    }
  });
  const send = (method, params) => new Promise(res => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  return { send, logs, ws };
}

(async () => {
  const { send, logs } = await cdp();
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

  const url = 'http://127.0.0.1:8712/index.html?_=' + Date.now();
  await send('Page.navigate', { url });
  await send('Page.setCacheDisabled', { cacheDisabled: true });
  await new Promise(r => setTimeout(r, 3000));

  const probe = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return 'EXC:' + JSON.stringify(r.result.exceptionDetails.text);
    return r.result && r.result.result ? r.result.result.value : null;
  };

  console.log('--- 早期状态 ---');
  console.log('TinyLM?', await probe('typeof window.TinyLM'));
  console.log('viz?', await probe('typeof window.__viz'));
  console.log('THREE?', await probe('typeof window.THREE'));
  console.log('progress:', await probe('window.__viz ? window.__viz.S.trainProgress : "no viz"'));

  // 等待训练完成
  for (let i = 0; i < 60; i++) {
    const t = await probe('window.__viz && window.__viz.S.trained');
    if (t === true) { console.log('\n训练完成，用时约', i, '秒'); break; }
    if (i % 6 === 0) console.log('  进度', await probe('window.__viz ? (window.__viz.S.trainProgress*100).toFixed(0)+"%" : "-"'));
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('\n--- 训练后状态 ---');
  console.log('trained:', await probe('window.__viz && window.__viz.S.trained'));
  console.log('seq:', await probe('window.__viz ? window.__viz.S.seq.join(",") : "-"'));
  console.log('step:', await probe('window.__viz ? window.__viz.S.step : "-"'));
  console.log('scene children:', await probe('document.querySelector("#scene canvas") ? "canvas ok" : "NO CANVAS"'));
  console.log('layer grid rows:', await probe('document.getElementById("layerGrid").children.length'));
  console.log('stage text:', await probe('document.getElementById("stage").textContent'));

  // 逐个相机视角截图
  const cams = ['overview', 'layer', 'matrix', 'mlp', 'head', 'tokens'];
  for (const cam of cams) {
    await probe(`document.querySelector('[data-cam="${cam}"]').click()`);
    await new Promise(r => setTimeout(r, 1400));
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result && shot.result.data) {
      fs.writeFileSync(SHOTDIR + '/shot-' + cam + '.png', Buffer.from(shot.result.data, 'base64'));
      console.log('shot', cam, 'ok');
    }
  }

  console.log('\n--- 控制台消息 ---');
  const seen = new Set();
  for (const l of logs) {
    const k = l.type + '|' + l.text.slice(0, 160);
    if (seen.has(k)) continue;
    seen.add(k);
    console.log('[' + l.type + ']', l.text.slice(0, 400));
  }
  if (!logs.length) console.log('(无)');
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });