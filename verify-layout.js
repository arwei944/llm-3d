/* 三栏布局 + 矢量图标专项验证（CDP）
 * 用法：PORT=9335 node verify-layout.js
 */
const fs = require('fs'), path = require('path');
const PORT = process.env.PORT || '9335';
const PAGE = 'file:///' + path.join(__dirname, 'dist', 'index.html').replace(/\\/g, '/');
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  let id = 0; const pend = new Map(); const errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 200));
    else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push('[log] ' + m.params.entry.text.slice(0, 200));
  };
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: `(function(){${expr}})()`, returnByValue: true, awaitPromise: true });
    return r.result?.exceptionDetails ? 'EXC: ' + r.result.exceptionDetails.text : r.result?.result?.value;
  };
  const shot = async (n) => {
    const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 84 });
    fs.writeFileSync(path.join(OUT, n + '.jpg'), Buffer.from(r.result.data, 'base64'));
  };

  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1720, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'about:blank' });
  await new Promise(r => setTimeout(r, 300));
  await send('Page.navigate', { url: PAGE });
  for (let i = 0; i < 90; i++) { if (await ev('return !!(window.__app && window.__app.bootDone)')) break; await new Promise(r => setTimeout(r, 1000)); }
  await new Promise(r => setTimeout(r, 1500));

  // 1) 三栏几何
  console.log('三栏几何:', await ev(`
    var g=function(s){var e=document.querySelector(s); if(!e) return null; var r=e.getBoundingClientRect();
      return {x:Math.round(r.x),w:Math.round(r.width),h:Math.round(r.height)};};
    var cs=getComputedStyle(document.getElementById('app'));
    return JSON.stringify({cols:cs.gridTemplateColumns, rail:g('#rail'), main:g('#main'), panel:g('#panel'),
      canvas:!!document.querySelector('#scene canvas'), canvasW: document.querySelector('#scene canvas')?document.querySelector('#scene canvas').width:0});`));

  // 2) 矢量图标覆盖
  console.log('图标统计:', await ev(`
    var svgs=document.querySelectorAll('svg.ic');
    var emoji=/[\\u2190-\\u21FF\\u2300-\\u27BF\\u2B00-\\u2BFF\\uFE0F\\u{1F300}-\\u{1FAFF}]/u;
    var bad=[];
    document.querySelectorAll('button').forEach(function(b){
      if (emoji.test(b.textContent) && !b.querySelector('svg.ic')) bad.push(b.textContent.trim().slice(0,14));
    });
    return 'svg.ic='+svgs.length+' 个 | 带文字符号且无图标的按钮: '+(bad.length?bad.join(','):'无');`));

  // 3) 模块导航卡片
  console.log('导航卡片:', await ev(`
    return Array.from(document.querySelectorAll('#modTabs button')).map(function(b){
      return b.querySelector('.m-ic svg')?'✓':'✗';}).join('')+' | '+
      Array.from(document.querySelectorAll('#modTabs button b')).map(function(b){return b.textContent;}).join(' / ');`));

  await shot('layout-fwd');

  // 4) 各模块切换 + 截图
  for (const [id, name] of [['explore', 'explore'], ['attn', 'attn'], ['kv', 'kv']]) {
    await ev(`window.__app.setMode('${id}'); return 1;`);
    await new Promise(r => setTimeout(r, 900));
    await shot('layout-' + name);
  }
  await ev(`window.__app.setMode('topics'); return 1;`);
  await new Promise(r => setTimeout(r, 900));
  await shot('layout-topics');

  // 5) 影片模式：两栏收起
  await ev(`window.__app.setMode('fwd'); window.__app.toggleCinema(true); return 1;`);
  await new Promise(r => setTimeout(r, 1200));
  console.log('影片模式:', await ev(`
    var vis=function(s){var e=document.querySelector(s); return e? getComputedStyle(e).display!=='none' : null;};
    return 'rail隐藏='+(!vis('#rail'))+' panel隐藏='+(!vis('#panel'))+' 播放按钮含图标='+(!!document.querySelector('#cinePlay svg.ic'));`));
  await shot('layout-cinema');
  await ev(`window.__app.toggleCinema(false); return 1;`);
  await new Promise(r => setTimeout(r, 600));

  // 6) 窄屏折叠
  await send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
  await new Promise(r => setTimeout(r, 900));
  console.log('窄屏 1180px:', await ev(`return getComputedStyle(document.getElementById('app')).gridTemplateColumns;`));
  await shot('layout-narrow');
  await send('Emulation.setDeviceMetricsOverride', { width: 1720, height: 1000, deviceScaleFactor: 1, mobile: false });

  console.log('\n异常:', errors.length ? errors.join('\n  ') : '(none)');
  console.log('错误总数:', errors.length);
  ws.close();
  process.exit(errors.length ? 2 : 0);
}
main().catch(e => { console.error('FAIL:', e); process.exit(1); });