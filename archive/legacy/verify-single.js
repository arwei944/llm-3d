/* 验证单文件版：file:// 直接打开，主线程训练，能完成推理循环 */
const fs = require('fs');
const path = require('path');
const SHOTDIR = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTDIR, { recursive: true });
const FILE = 'file:///' + path.join(__dirname, 'llm-3d-visualization.html').replace(/\\/g, '/');

async function cdp() {
  const list = await (await fetch('http://127.0.0.1:9334/json/list')).json();
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
  const send = (method, params) => new Promise(res => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  return { send, logs };
}

(async () => {
  const { send, logs } = await cdp();
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: FILE });
  const probe = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : null;
  };
  const wait = ms => new Promise(r => setTimeout(r, ms));

  // 等文档真正加载完成（此前探针可能落在旧上下文）
  let ready = false;
  for (let i = 0; i < 30; i++) {
    const rs = await probe('document.readyState + "|" + location.protocol');
    if (rs && String(rs).indexOf('file:') === 0 && String(rs).indexOf('complete') > 0) { ready = true; break; }
    await wait(500);
  }
  console.log('doc ready:', ready, await probe('document.readyState + " @" + location.protocol'));
  await wait(1500);
  console.log('THREE:', await probe('typeof THREE'), '| TinyLM:', await probe('typeof TinyLM'), '| viz:', await probe('typeof window.__viz'));
  console.log('canvas:', await probe('!!document.querySelector("#scene canvas")'));

  const t0 = Date.now();
  let ok = false;
  for (let i = 0; i < 120; i++) {
    if (await probe('window.__viz && window.__viz.S.trained')) { ok = true; break; }
    await wait(1000);
  }
  console.log('trained:', ok, '耗时', ((Date.now() - t0) / 1000).toFixed(0) + 's');
  console.log('final loss:', await probe('window.__viz && window.__viz.S.trainLoss ? window.__viz.S.trainLoss[window.__viz.S.trainLoss.length-1].toFixed(3) : "-"'));
  // 让它跑几轮生成
  await wait(12000);
  console.log('seq:', await probe('window.__viz.S.seq.join("")'));
  console.log('gen rounds:', await probe('window.__viz.S.step'));

  const s = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(SHOTDIR + '/single-file.png', Buffer.from(s.result.data, 'base64'));
  console.log('shot saved');
  console.log('errors:', logs.length ? logs.slice(0, 5).join(' || ') : '(none)');
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });