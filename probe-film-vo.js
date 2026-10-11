/* CDP 验证配音版回放页：时长/音频轨/章节/字幕联动/控制台异常。
 * 用法: node probe-film-vo.js   （需 9334 端口已有 headless Chrome）
 */
const fs = require('fs'), path = require('path');
const URL_ = 'file:///' + path.join(__dirname, 'dist', 'film.html').replace(/\\/g, '/');

async function main() {
  const list = await (await fetch('http://127.0.0.1:9334/json/list', { signal: AbortSignal.timeout(5000) })).json();
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(res => ws.onopen = res);
  let id = 0;
  const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

  await send('Page.enable');
  const errors = [];
  await send('Runtime.enable');
  // 先 about:blank 清缓存再导航（避免命中上次构建的 file:// 内存缓存）
  await send('Page.navigate', { url: 'about:blank' });
  await new Promise(r => setTimeout(r, 400));
  await send('Page.navigate', { url: URL_ });
  await new Promise(r => setTimeout(r, 3500));

  const info = await ev(`(async () => {
    const v = document.getElementById('v');
    if (!v) return { err: 'no video' };
    let guard = 0;
    while (v.readyState < 1 && guard++ < 100) await new Promise(r => setTimeout(r, 100));
    return {
      readyState: v.readyState,
      duration: +v.duration.toFixed(3),
      hasAudio: !!(v.mozHasAudio || v.audioTracks?.length || v.webkitAudioDecodedByteCount > 0),
      chapters: document.querySelectorAll('#toc button.ch').length,
      lines: (window.__SUBS || []).length || document.querySelectorAll('.sub').length,
    };
  })()`);

  // 跳到 100s 看字幕与章节高亮
  const mid = await ev(`(async () => {
    const v = document.getElementById('v');
    v.currentTime = 100;
    await new Promise(r => setTimeout(r, 600));
    const sub = document.querySelector('.sub');
    const active = document.querySelector('#toc button.ch.on, #toc button.ch.active');
    return { t: v.currentTime, sub: sub ? sub.textContent.trim().slice(0, 40) : null, chapter: active ? active.textContent.trim().slice(0, 24) : null };
  })()`);

  console.log('回放页检查:', JSON.stringify({ ...info, mid }, null, 1));
  console.log('异常:', errors.length ? errors.join(' | ') : '(none)');
  ws.close();
}
main().catch(e => { console.error('PROBE FAIL:', e.message); process.exit(1); });
