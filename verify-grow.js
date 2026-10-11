/* 验证 growTokens：影片 ⑯/⑰ 场景是否真的把生成出的 token 追加进序列 */
const path = require('path');
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
  const send = (m, p) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  return { send, logs, clear: () => { logs.length = 0; } };
}

(async () => {
  const { send, logs, clear } = await cdp();
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
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

  await wait(3500);
  for (let i = 0; i < 60; i++) { if (await probe('window.__app && window.__app.bootDone')) break; await wait(1000); }
  await probe('window.__app.toggleCinema(true)');
  await wait(800);

  // 打印 ⑯/⑰ 场景的时间窗口
  console.log('场景窗口:', await probe(`(function(){var C=window.LLMCine;var o=[];for(var i=15;i<=18;i++){o.push('#'+i+' ['+Math.round(C.cum[i]/1000)+'-'+Math.round((C.cum[i]+C.scenes[i].dur)/1000)+'s] grow='+(C.scenes[i].growTokens||0)+' '+C.scenes[i].title)}return o.join(' | ')})()`));

  // 在若干时间点采样序列长度
  const marks = [];
  for (let s = 195; s <= 275; s += 5) marks.push(s);
  let prev = null;
  for (const sec of marks) {
    const info = await probe(`(function(){var C=window.LLMCine;C.seek(${sec * 1000});C.render();var S=window.__app.fwd.S;return {len:(S.seq?S.seq.length:0), grown:S.seq.map(window.TinyLM.detok).join('')}})()`);
    const tag = info.len !== prev ? '  <<< 变化' : '';
    console.log(`[${String(sec).padStart(3)}s] seq.length=${info.len} seq=${info.grown}${tag}`);
    prev = info.len;
  }

  console.log('errors:', logs.length ? logs.slice(0, 5).join(' || ') : '(none)');
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
