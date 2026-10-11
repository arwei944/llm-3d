/* 基建测试：CDP 截图 → 管道喂给 ffmpeg image2pipe → mp4（全程不落盘中间帧）
 * 验证两件事：① spawn 带 stdin 管道在本机 PTY 环境下是否可用；② ffmpeg 能否从管道解 mjpeg
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, 'out', 'pipe-test.mp4');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const URL = 'file:///' + path.join(__dirname, 'dist', 'index.html').replace(/\\/g, '/');
const W = 960, H = 540, FPS = 12, N = 36;

async function cdp() {
  const list = await (await fetch('http://127.0.0.1:9334/json/list')).json();
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  return { send };
}

(async () => {
  const { send } = await cdp();
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: 'about:blank' }); await new Promise(r => setTimeout(r, 300));
  await send('Page.navigate', { url: URL });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await wait(3000);
  for (let i = 0; i < 60; i++) {
    const r = await send('Runtime.evaluate', { expression: 'window.__app && window.__app.bootDone', returnByValue: true });
    if (r.result && r.result.result && r.result.result.value) break;
    await wait(1000);
  }
  console.log('bootDone ok');

  // 起 ffmpeg，从 stdin 读 mjpeg 序列
  const ff = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', OUT,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });

  let spawnErr = null;
  ff.on('error', e => { spawnErr = e; });
  await wait(300);
  if (spawnErr) { console.log('SPAWN_FAILED:', spawnErr.message); process.exit(1); }
  console.log('ffmpeg spawned, stdin writable =', !!ff.stdin.writable);

  let bytes = 0;
  for (let i = 0; i < N; i++) {
    // 每帧改一点内容，确认帧序列真的是变化的
    await send('Runtime.evaluate', { expression: `window.__app.fwd.gotoStep(${i % 25}, 1); window.__app.fwd.applyCam('overview'); 1`, returnByValue: true });
    const s = await send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
    const buf = Buffer.from(s.result.data, 'base64');
    bytes += buf.length;
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    process.stdout.write(`\r  frame ${i + 1}/${N}  ${(bytes / 1024).toFixed(0)} KB`);
  }
  console.log('');
  ff.stdin.end();
  const code = await new Promise(r => ff.on('close', r));
  console.log('ffmpeg exit code:', code);
  console.log('output size:', fs.existsSync(OUT) ? (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB' : 'MISSING');
  process.exit(code === 0 ? 0 : 1);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
