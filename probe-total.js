/* 只读探针：取影片总时长（秒），供 render-all.js 分段用 */
const path = require('path');
const URL = 'file:///' + path.join(__dirname, 'dist', 'index.html').replace(/\\/g, '/');

async function cdp() {
  const list = await (await fetch('http://127.0.0.1:9334/json/list')).json();
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (m, p) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  return { send };
}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const { send } = await cdp();
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: 'about:blank' }); await wait(300);
  await send('Page.navigate', { url: URL });
  const probe = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true });
    return r.result && r.result.result ? r.result.result.value : null;
  };
  await wait(2500);
  for (let i = 0; i < 90; i++) { if (await probe('window.LLMCine && window.LLMCine.total')) break; await wait(500); }
  const total = await probe('window.LLMCine.total');
  // 注意：本机 Node 在 PTY 会话下用管道捕获子进程输出会 EBUSY，
  // 所以不往 stdout 吐值，改写文件让父进程读。（run 脚本用 stdio:'inherit'。）
  require('fs').writeFileSync(require('path').join(__dirname, 'out', '_total.txt'), String(total / 1000));
  process.exit(0);
})().catch(e => { process.stderr.write(String(e.message)); process.exit(1); });
