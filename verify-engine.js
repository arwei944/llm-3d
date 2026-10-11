/* =============================================================================
 * verify-engine.js —— 科普引擎回归（CDP 驱动 headless Chrome）
 *
 * 验证：导航与模块注册 / 每个互动模块的控件与真实计算 / overlay 卡片与迷你 demo /
 *       切回内置模式后老行为不变 / 全程零控制台异常
 *
 * 用法：先起 chrome（--remote-debugging-port=9334），再 node verify-engine.js
 * ========================================================================== */
const fs = require('fs'), path = require('path');
const PORT = process.env.PORT || '9334';
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
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || '').slice(0, 160));
    else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push('[log] ' + m.params.entry.text.slice(0, 160));
  };
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: `(function(){${expr}})()`, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return 'EXC: ' + r.result.exceptionDetails.text;
    return r.result?.result?.value;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
    fs.writeFileSync(path.join(OUT, name + '.jpg'), Buffer.from(r.result.data, 'base64'));
  };

  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'about:blank' });
  await new Promise(r => setTimeout(r, 300));
  await send('Page.navigate', { url: PAGE });
  let booted = false;
  for (let i = 0; i < 90; i++) { if (await ev('return !!(window.__app && window.__app.bootDone)')) { booted = true; break; } await new Promise(r => setTimeout(r, 1000)); }
  console.log('bootDone:', booted);
  await new Promise(r => setTimeout(r, 1200));

  // 1) 导航
  console.log('导航按钮:', await ev(`return Array.from(document.querySelectorAll('#modTabs button')).map(b=>b.textContent.trim()).join(' | ')`));
  console.log('注册模块:', await ev(`return window.LLMEngine.list.map(m=>m.id).join(',')`));

  // 2) 采样实验室
  console.log('\n[采样实验室]', await ev(`
    window.__app.setMode('explore');
    return 'mode=' + window.__app.mode + ' panel=' + (document.getElementById('modPanel').style.display!=='none') + ' fwdVisible=' + window.__app.fwd.root.visible + ' rootVisible=' + window.LLMEngine.inst('explore').root.visible;`));
  await new Promise(r => setTimeout(r, 700));
  console.log('  初始 HUD:', await ev(`return window.LLMEngine.getHud().desc`));
  console.log('  温度滑到 2.6:', await ev(`
    var s=document.getElementById('exTemp'); s.value='2.6'; s.dispatchEvent(new Event('input'));
    return document.getElementById('exTempVal').textContent + ' | ' + document.getElementById('exRead').textContent.trim().slice(0,90);`));
  console.log('  Top-K=3:', await ev(`
    var k=document.getElementById('exK'); k.value='3'; k.dispatchEvent(new Event('input'));
    return document.getElementById('exRead').textContent.trim().slice(0,60);`));
  console.log('  采样 3 步:', await ev(`
    var b=document.getElementById('exStep'); b.click(); b.click(); b.click();
    return '序列=' + window.LLMEngine.getSeq() + ' | 板条高度=' + window.LLMEngine.inst('explore').root.children.length;`));
  await new Promise(r => setTimeout(r, 500));
  await shot('engine-explore');

  // 3) 注意力探针
  console.log('\n[注意力探针]', await ev(`
    window.__app.setMode('attn');
    return 'mode=' + window.__app.mode + ' | ' + document.getElementById('atRead').textContent.trim().replace(/\\s+/g,' ').slice(0,110);`));
  await new Promise(r => setTimeout(r, 500));
  console.log('  换头 3 / 换层 2:', await ev(`
    document.querySelectorAll('#atHead button')[2].click();
    document.querySelectorAll('#atLayer button')[1].click();
    return document.getElementById('atRead').textContent.trim().replace(/\\s+/g,' ').slice(0,110);`));
  console.log('  切换输入预设:', await ev(`
    document.querySelectorAll('#atPresets button')[2].click();
    return window.LLMEngine.getSeq();`));
  await new Promise(r => setTimeout(r, 400));
  await shot('engine-attn');

  // 4) 上下文与缓存
  console.log('\n[上下文与缓存]', await ev(`
    window.__app.setMode('kv');
    return document.getElementById('kvRead').textContent.replace(/\\s+/g,' ').trim().slice(0,120);`));
  console.log('  T 拉到 16:', await ev(`
    var t=document.getElementById('kvT'); t.value='16'; t.dispatchEvent(new Event('input'));
    return document.getElementById('kvRead').textContent.replace(/\\s+/g,' ').trim().slice(0,120);`));
  await new Promise(r => setTimeout(r, 400));
  await shot('engine-kv');

  // 5) 科普图谱
  console.log('\n[科普图谱]', await ev(`
    window.__app.setMode('topics');
    return 'overlay=' + !document.getElementById('topicsOverlay').classList.contains('hidden') + ' 卡片=' + document.querySelectorAll('.tcard').length + ' body标记=' + document.body.classList.contains('mod-overlay');`));
  await new Promise(r => setTimeout(r, 900));
  console.log('  迷你 demo 画布是否已绘制:', await ev(`
    var out=[];
    ['tdEmbed','tdScale','tdHallu'].forEach(function(id){
      var c=document.getElementById(id); if(!c){out.push(id+':缺');return;}
      var d=c.getContext('2d').getImageData(0,0,c.width,c.height).data, n=0;
      for(var i=3;i<d.length;i+=4) if(d[i]>0) n++;
      out.push(id+':'+(n>500?'已绘制('+n+'px)':'空'));
    });
    return out.join(' | ');`));
  console.log('  缩放定律滑杆联动:', await ev(`
    var r=document.getElementById('tdScaleN'); r.value='12'; r.dispatchEvent(new Event('input'));
    return document.getElementById('tdScaleVal').textContent;`));
  await shot('engine-topics');

  // 6) 回到内置模式
  console.log('\n[内置模式回归]', await ev(`
    window.__app.setMode('fwd');
    return 'mode=' + window.__app.mode + ' fwdVisible=' + window.__app.fwd.root.visible + ' overlay隐藏=' + document.getElementById('topicsOverlay').classList.contains('hidden') + ' panel隐藏=' + (document.getElementById('modPanel').style.display==='none');`));
  await new Promise(r => setTimeout(r, 400));
  console.log('  切 train:', await ev(`window.__app.setMode('train'); return window.__app.mode + ' 提示=' + document.getElementById('modeHint').textContent.slice(0,24);`));

  console.log('\n控制台异常:', errors.length ? errors.join('\n  ') : '(none)');
  console.log('错误总数:', errors.length);
  ws.close();
  process.exit(errors.length ? 2 : 0);
}
main().catch(e => { console.error('PROBE FAIL:', e); process.exit(1); });