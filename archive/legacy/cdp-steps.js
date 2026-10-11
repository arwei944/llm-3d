/* 针对特定步骤截图：把播放头移到注意力/MLP/输出头，再拍对应视角 */
const fs = require('fs');
const path = require('path');
const SHOTDIR = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTDIR, { recursive: true });

async function cdp() {
  const list = await (await fetch('http://127.0.0.1:9334/json/list')).json();
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0; const pending = new Map(); const logs = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(m.params.exceptionDetails.text));
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
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: 'http://127.0.0.1:8712/index.html?_=' + Date.now() });

  const probe = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : null;
  };
  const wait = ms => new Promise(r => setTimeout(r, ms));

  for (let i = 0; i < 90; i++) {
    if (await probe('window.__viz && window.__viz.S.trained')) break;
    await wait(1000);
  }
  console.log('trained:', await probe('window.__viz && window.__viz.S.trained'));

  // 跳到指定 stepId
  const gotoStep = async (id, frac) => {
    await probe(`(function(){
      var V=window.__viz;
      var i=0; for(var k=0;k<V.STEPS.length;k++){ if(V.STEPS[k].id==='${id}'){ i=k; break; } }
      V.gotoStep(i, ${frac});
      return i;
    })()`);
    await wait(1500);
  };

  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    if (s.result && s.result.data) {
      fs.writeFileSync(SHOTDIR + '/' + name + '.png', Buffer.from(s.result.data, 'base64'));
      console.log('shot', name);
    }
  };

  const cases = [
    ['attn', 0.75, 'matrix', 's-attn-matrix'],
    ['attn', 0.35, 'layer', 's-attn-layer'],
    ['mlp', 0.85, 'mlp', 's-mlp'],
    ['softmax', 0.9, 'head', 's-softmax'],
    ['topp', 0.8, 'head', 's-topp'],
    ['embed', 0.8, 'tokens', 's-embed'],
  ];
  for (const [id, frac, cam, name] of cases) {
    await probe(`document.querySelector('[data-cam="${cam}"]').click()`);
    await wait(900);
    await gotoStep(id, frac);
    await shot(name);
  }
  console.log('errors:', logs.length ? logs.join('\n') : '(none)');
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });