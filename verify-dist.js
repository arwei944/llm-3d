/* 验证重构后的项目：两个模式 + 真实运算示例比对 */
const fs = require('fs');
const path = require('path');
const SHOTDIR = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTDIR, { recursive: true });
const URL = 'file:///' + require('path').join(__dirname,'dist','index.html').replace(/\\/g,'/');

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

  // 先清空页面再导航到产物：避免上一次运行遗留的旧构建（同一 file:// URL 命中内存缓存）
  // 把异常混进本次日志里，造成"明明已经修好却仍报错"的假象。
  await send('Page.navigate', { url: 'about:blank' });
  await new Promise(r => setTimeout(r, 400));
  clear();

  const probe = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : null;
  };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async (n) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    if (s.result && s.result.data) { fs.writeFileSync(SHOTDIR + '/' + n + '.png', Buffer.from(s.result.data, 'base64')); console.log('shot', n); }
  };

  await send('Page.navigate', { url: URL });
  await wait(3500);
  console.log('modules:', await probe('[typeof THREE, typeof TinyLM, typeof LLMCore, typeof FwdViz, typeof TrainViz, typeof LLMTrace, typeof LLM_TRACE_REF].join(",")'));

  let ok = false;
  for (let i = 0; i < 90; i++) { if (await probe('window.__app && window.__app.bootDone')) { ok = true; break; } await wait(1000); }
  console.log('bootDone:', ok, '(约', 's)');

  // ---- 真实运算示例比对 ----
  console.log('trace ref loaded:', await probe('!!window.LLM_TRACE_REF'));
  const cmp = await probe(`(function(){
    var m = window.__app.model;
    var R = window.LLMTrace.compute(m);
    var c = window.LLMTrace.compare(R, window.LLM_TRACE_REF.tensors);
    return c.msg + ' | ok=' + c.ok + ' | attnConsistent=' + R.attnConsistent + ' | pSum=' + R.pSum;
  })()`);
  console.log('真实运算比对:', cmp);
  console.log('面板渲染行数:', await probe('document.querySelectorAll("#traceBox .ex-step").length'));

  // 视角按钮必须按「当前模式」限定作用域：
  // fwd / train 各有一套「全景」，querySelector 会命中隐藏的那一套从而误切模式。
  const camClick = (formode, cam) =>
    probe(`(function(){var b=document.querySelector('.camrow[data-formode="${formode}"] [data-cam="${cam}"]'); if(!b) return 'MISSING'; b.click(); return b.dataset.cam;})()`);

  // ---- 推理模式截图 ----
  await wait(1000); await shot('r1-fwd-overview');
  console.log('点击 fwd matrix ->', await camClick('fwd', 'matrix'));
  await wait(1200); await shot('r2-fwd-matrix');

  // ---- 切到训练模式 ----
  console.log('点击 train 模式 ->', await probe(`(function(){document.querySelector('[data-mode="train"]').click(); return document.querySelector('[data-mode="train"]').classList.contains('on');})()`));
  await wait(1500);
  console.log('mode:', await probe('window.__app.mode'));
  console.log('训练视角行可见性:', await probe(`(function(){var r=document.querySelector('.camrow[data-formode="train"]'); return getComputedStyle(r).display;})()`));
  await camClick('train', 'overview'); await wait(1000);
  await shot('r3-train-overview');
  // 让它真跑几轮
  await wait(20000);
  console.log('训练迭代数:', await probe('window.__app.trainModel._adam.t'));
  console.log('loss 历史点数:', await probe('window.__app.mode + " / " + (window.__app.trainModel._adam ? window.__app.trainModel._adam.t : "-")'));
  await camClick('train', 'backward'); await wait(1200); await shot('r4-train-backward');
  await camClick('train', 'optim'); await wait(1200); await shot('r5-train-optim');
  await camClick('train', 'curve'); await wait(1200); await shot('r6-train-curve');
  console.log('训练指标:', await probe(`document.getElementById('layerGrid').textContent.replace(/\\s+/g,' ').slice(0,120)`));

  // ---- 切回推理，验证面板结构能正确复原 ----
  await probe(`document.querySelector('[data-mode="fwd"]').click()`);
  await wait(2000);
  console.log('切回 fwd 后 mode:', await probe('window.__app.mode'));
  console.log('切回 fwd 后层进度行数:', await probe(`document.querySelectorAll('#layerGrid .lp').length`));
  await shot('r7-back-to-fwd');

  console.log('errors:', logs.length ? logs.slice(0, 6).join(' || ') : '(none)');
  console.log('错误总数:', logs.length);
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });