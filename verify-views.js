/* 逐视角取景验证：把动画停在「该视角真正要看的那个原子步骤」上再截图。
 * 之前在步骤①就点 matrix 视角，矩阵还没画出来，截出来的图没有参考价值。
 * 用法： node verify-views.js
 */
const fs = require('fs');
const path = require('path');
const SHOTDIR = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTDIR, { recursive: true });
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
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push('EXC ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
    }
  });
  const send = (method, params) => new Promise(res => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  return { send, logs, clear: () => { logs.length = 0; } };
}

(async () => {
  const { send, logs, clear } = await cdp();
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: 'about:blank' });
  await new Promise(r => setTimeout(r, 400));
  clear();
  await send('Page.navigate', { url: URL });

  const probe = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : null;
  };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async (n) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    if (s.result && s.result.data) { fs.writeFileSync(SHOTDIR + '/' + n + '.png', Buffer.from(s.result.data, 'base64')); console.log('  shot', n); }
  };

  await wait(3500);
  let ok = false;
  for (let i = 0; i < 60; i++) { if (await probe('window.__app && window.__app.bootDone')) { ok = true; break; } await wait(1000); }
  if (!ok) { console.log('boot 超时'); process.exit(1); }

  // 确认步骤总数已修好（应为 25：2 全局 + 2 层 × 9 + 5 输出）
  console.log('推理步骤总数:', await probe('window.__app.fwd.STEPS.length'));
  console.log('层1 步骤名:', await probe(`window.__app.fwd.STEPS.slice(2,11).map(function(s){return s.id}).join(' > ')`));

  // [视角, 步骤索引, 文件名]
  const VIEWS = [
    ['overview', 0, 'v1-overview-embed'],
    ['tokens', 1, 'v2-tokens-rope'],
    ['layer', 3, 'v3-layer-qkv'],
    ['matrix', 5, 'v4-matrix-attnvis'],
    ['mlp', 9, 'v5-mlp-neurons'],
    ['head', 22, 'v6-head-softmax'],
    ['overview', 24, 'v7-overview-emit'],
  ];

  for (const [cam, idx, name] of VIEWS) {
    const r = await probe(`(function(){
      var A = window.__app; if (A.mode !== 'fwd') { document.querySelector('[data-mode="fwd"]').click(); }
      A.fwd.gotoStep(${idx}, 1);
      A.fwd.applyCam('${cam}');
      A.fwd.update(performance.now());
      return A.fwd.STEPS[${idx}].name;
    })()`);
    console.log('视角', cam, '@', r);
    await wait(900);
    // 再刷一帧确保视觉状态已按该步骤更新
    await probe(`(function(){ window.__app.fwd.update(performance.now()); return 1; })()`);
    await wait(300);
    await shot(name);
  }

  // ---- 训练模式：在对应阶段停留后再取景 ----
  await probe(`document.querySelector('[data-mode="train"]').click()`);
  await wait(6000);   // 让训练真实推进，loss 曲线有多个点
  console.log('训练迭代数:', await probe('window.__app.trainModel._adam.t'));

  const TVIEWS = [
    ['batch', 't1-batch'],
    ['forward', 't2-forward'],
    ['backward', 't3-backward'],
    ['optim', 't4-optim'],
    ['curve', 't5-curve'],
  ];
  for (const [cam, name] of TVIEWS) {
    await probe(`window.__app.train.applyCam('${cam}')`);
    await wait(1000);
    await shot(name);
  }

  console.log('errors:', logs.length ? logs.slice(0, 4).join(' || ') : '(none)');
  console.log('错误总数:', logs.length);
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
