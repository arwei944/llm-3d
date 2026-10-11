/* 讲解动画导出：CDP 逐帧截图 → image2pipe → ffmpeg → MP4（中间帧不落盘）
 *
 * 原理：narration.js 的 seek(t) 是纯函数——给定时刻 t，画面完全确定。
 * 因此同一套脚本既能驱动"页面里实时播放"，也能驱动"逐帧离线导出"，
 * 两者产出的画面逐帧一致。
 *
 * 用法：
 *   node record-film.js                 # 全片 1920x1080 @ 24fps
 *   W=1600 H=900 FPS=15 node record-film.js
 *   BENCH=24 node record-film.js        # 只录 24 帧测速，输出到 out/_bench.mp4
 *   START=100 END=140 node record-film.js   # 只录 100s~140s（用于分段/续录）
 */
const fs = require('fs'), path = require('path');
const { spawn } = require('child_process');

const W = parseInt(process.env.W || '1920', 10);
const H = parseInt(process.env.H || '1080', 10);
const FPS = parseFloat(process.env.FPS || '24');
const Q = parseInt(process.env.Q || '92', 10);
const BENCH = parseInt(process.env.BENCH || '0', 10);
const START = parseFloat(process.env.START || '0');
const END = parseFloat(process.env.END || '0');   // 0 = 到片尾
const OUT = process.env.OUT || path.join(__dirname, 'out', BENCH ? '_bench.mp4' : 'llm-narration.mp4');
const PAGE = process.env.PAGE || path.join(__dirname, 'dist', 'index.html');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const URL = 'file:///' + PAGE.replace(/\\/g, '/');

async function cdp() {
  const list = await (await fetch('http://127.0.0.1:9334/json/list')).json();
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error('没有可用的 page 目标，请确认 Chrome 以 --remote-debugging-port=9334 启动');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let id = 0; const pending = new Map(); const logs = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
    }
  });
  const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  return { send, ws, logs };
}

const wait = ms => new Promise(r => setTimeout(r, ms));
const hhmmss = s => { const t = Math.max(0, Math.round(s)); return String((t / 60) | 0).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };

(async () => {
  const { send, logs } = await cdp();
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: 'about:blank' }); await wait(400);
  logs.length = 0;
  await send('Page.navigate', { url: URL });

  const evalv = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' :: ' + expr.slice(0, 80));
    return r.result && r.result.result ? r.result.result.value : null;
  };

  await wait(3000);
  let booted = false;
  for (let i = 0; i < 90; i++) {
    if (await evalv('window.__app && window.__app.bootDone')) { booted = true; break; }
    await wait(1000);
  }
  if (!booted) throw new Error('bootDone 超时：模型没训练完或页面报错');
  console.log('bootDone ok');

  // 进入影片模式并切到"录制态"：暂停自动播放、隐藏控制条与底部渐变
  await evalv('window.LLMCine.setOn(true, {recording:true})');
  await wait(700);
  // 冻结主循环：逐帧导出期间不渲染，把 CPU 全部让给截图+编码
  await evalv('window.__app.recFreeze = true');
  await wait(120);
  const canvas = await evalv('(function(){var c=window.__app.core.renderer.domElement;return c.clientWidth+"x"+c.clientHeight})()');
  const TOTAL = await evalv('window.LLMCine.total');
  console.log(`影片 ${(TOTAL / 1000).toFixed(0)}s  |  画布 ${canvas}  |  ${FPS}fps  |  ${W}x${H}`);

  let t0 = START * 1000;
  let t1 = END > 0 ? END * 1000 : TOTAL;
  const totalFrames = BENCH > 0 ? BENCH : Math.round((t1 - t0) / 1000 * FPS);
  if (totalFrames <= 0) throw new Error('帧数为 0，检查 START/END');
  console.log(`导出 ${totalFrames} 帧 → ${path.relative(__dirname, OUT)}`);

  const ff = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', process.env.PRESET || 'medium', '-crf', process.env.CRF || '19',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', OUT,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  let spawnErr = null; ff.on('error', e => { spawnErr = e; });
  await wait(250);
  if (spawnErr) throw new Error('ffmpeg 启动失败: ' + spawnErr.message);

  const writeFrame = (buf) => new Promise(res => {
    if (ff.stdin.write(buf)) return res();
    ff.stdin.once('drain', res);
  });

  const tStart = Date.now();
  let bytes = 0;
  for (let i = 0; i < totalFrames; i++) {
    const t = t0 + (i / FPS) * 1000;
    await evalv(`window.LLMCine.seek(${t}); window.LLMCine.render(); 1`);
    const s = await send('Page.captureScreenshot', { format: 'jpeg', quality: Q });
    const buf = Buffer.from(s.result.data, 'base64');
    bytes += buf.length;
    await writeFrame(buf);

    if (i % 5 === 0 || i === totalFrames - 1) {
      const el = (Date.now() - tStart) / 1000;
      const rate = (i + 1) / el;
      const eta = (totalFrames - i - 1) / rate;
      process.stdout.write(`\r  帧 ${i + 1}/${totalFrames}  t=${hhmmss(t / 1000)}  ${rate.toFixed(1)} 帧/s  ETA ${hhmmss(eta)}  已投喂 ${(bytes / 1048576).toFixed(0)}MB   `);
    }
  }
  console.log('');
  ff.stdin.end();
  const code = await new Promise(r => ff.on('close', r));
  const wall = ((Date.now() - tStart) / 1000).toFixed(0);
  console.log(`ffmpeg 退出码 ${code}，用时 ${wall}s`);
  if (fs.existsSync(OUT)) {
    const sz = fs.statSync(OUT).size;
    console.log(`输出 ${path.relative(__dirname, OUT)}  ${(sz / 1048576).toFixed(1)} MB`);
  } else { console.log('输出缺失！'); }
  if (logs.length) console.log('页面异常:', logs.slice(0, 5).join(' || '));
  process.exit(code === 0 ? 0 : 1);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
