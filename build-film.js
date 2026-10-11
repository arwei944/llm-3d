/* 生成回放页 dist/film.html + 把 mp4/vtt 拷进 dist/，让 dist/ 成为可整体搬走的目录。
 *
 * 字幕不走 <track>：file:// 下不少浏览器会因 CORS 拒加载外部 vtt，
 * 这里把台词数组直接内联进 HTML，由 JS 按 currentTime 自己渲染 —— 离线双击即可用。
 *
 * 用法： node build-film.js
 */
const fs = require('fs'), path = require('path');

const OUT = path.join(__dirname, 'out');
const DIST = path.join(__dirname, 'dist');
fs.mkdirSync(DIST, { recursive: true });

const chapters = JSON.parse(fs.readFileSync(path.join(OUT, 'chapters.json'), 'utf8'));

// 从 SRT 反解析台词（make-subs.js 已经把时间算好了，直接复用避免第二套逻辑）
const srt = fs.readFileSync(path.join(OUT, 'llm-narration.srt'), 'utf8');
const parseTs = (s) => {
  const m = s.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return NaN;
  return ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000 + (+m[4]);
};
const lines = [];
const blocks = srt.replace(/\r/g, '').split(/\n\n+/).filter(Boolean);
for (const b of blocks) {
  const ls = b.split('\n');
  const idx = ls.findIndex(l => l.includes('-->'));
  if (idx < 0) continue;
  const [a, z] = ls[idx].split('-->');
  lines.push({ a: parseTs(a), z: parseTs(z), text: ls.slice(idx + 1).join('\n') });
}
if (!lines.length) throw new Error('SRT 解析结果为空');

// 拷贝媒体
for (const f of ['llm-narration.mp4', 'llm-narration.vtt']) {
  fs.copyFileSync(path.join(OUT, f), path.join(DIST, f));
  console.log('拷贝 dist/' + f, (fs.statSync(path.join(DIST, f)).size / 1048576).toFixed(1) + ' MB');
}

const fmt = (s) => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

// 按幕分组章节
const acts = [];
chapters.chapters.forEach(c => { if (!acts.length || acts[acts.length - 1].name !== c.act) acts.push({ name: c.act, items: [] }); acts[acts.length - 1].items.push(c); });

const chaptersHtml = acts.map(a => `
    <div class="act">${a.name}</div>
    ${a.items.map(c => `<button class="ch" data-t="${c.t}" data-i="${c.i}">
      <span class="no">${String(c.i).padStart(2, '0')}</span>
      <span class="tt">${c.title}</span>
      <span class="du">${fmt(c.t)}</span>
    </button>`).join('')}`).join('\n');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>一个微型 Transformer 的全部内部 · 讲解动画</title>
<style>
  :root{
    --paper:#f7f2e9; --card:#fffdf9; --ink:#2b2723; --ink2:#6b6259;
    --jade:#2f7d63; --jade2:#3d8f9c; --rust:#b85c38; --line:#e2d9c8;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);
    font:15px/1.7 "Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif;
    -webkit-font-smoothing:antialiased}
  .wrap{max-width:1500px;margin:0 auto;padding:26px 22px 60px}
  header{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:16px}
  h1{font-size:22px;margin:0;letter-spacing:.5px}
  .meta{color:var(--ink2);font-size:13px}
  .meta b{color:var(--jade);font-weight:600}
  .grid{display:grid;grid-template-columns:1fr 328px;gap:18px;align-items:start}
  @media (max-width:1100px){.grid{grid-template-columns:1fr}}

  .stage{position:relative;background:var(--card);border:1px solid var(--line);
    border-radius:14px;overflow:hidden;box-shadow:0 1px 2px rgba(60,50,30,.06)}
  .vwrap{position:relative;background:#0d0c0a}
  video{display:block;width:100%;background:#0d0c0a}
  .sub{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);
    max-width:86%;text-align:center;background:rgba(255,253,249,.92);color:var(--ink);
    font-size:19px;line-height:1.5;padding:8px 16px;border-radius:12px;
    pointer-events:none;box-shadow:0 1px 6px rgba(40,30,20,.12)}
  .sub:empty{display:none}

  .bar{display:flex;align-items:center;gap:10px;padding:10px 12px;border-top:1px solid var(--line);flex-wrap:wrap}
  button{font:inherit;color:var(--ink);background:#fff;border:1px solid var(--line);
    border-radius:8px;padding:6px 12px;cursor:pointer;transition:.12s}
  button:hover{border-color:var(--jade);color:var(--jade)}
  button.on{background:var(--jade);border-color:var(--jade);color:#fff}
  .sp{flex:1}
  .clock{font-variant-numeric:tabular-nums;color:var(--ink2);font-size:13px;min-width:96px;text-align:right}
  input[type=range]{flex:1;min-width:160px;accent-color:var(--jade);height:22px}
  .hint{color:var(--ink2);font-size:12.5px;margin-top:10px}
  kbd{background:#fff;border:1px solid var(--line);border-bottom-width:2px;border-radius:5px;
    padding:0 5px;font:12px/1.5 ui-monospace,Consolas,monospace}

  .toc{background:var(--card);border:1px solid var(--line);border-radius:14px;
    max-height:78vh;overflow:auto;padding:10px 8px;position:sticky;top:16px}
  .act{font-size:12px;color:var(--jade2);letter-spacing:1px;padding:10px 8px 4px;font-weight:600}
  .ch{display:flex;align-items:center;gap:9px;width:100%;text-align:left;background:none;
    border:0;border-left:3px solid transparent;border-radius:0 8px 8px 0;padding:6px 8px}
  .ch:hover{background:#f4efe4}
  .ch.on{border-left-color:var(--jade);background:#eef4ef}
  .ch .no{font-variant-numeric:tabular-nums;color:var(--ink2);font-size:12px;min-width:20px}
  .ch .tt{flex:1;font-size:13.5px;line-height:1.45}
  .ch .du{color:var(--ink2);font-size:11.5px;font-variant-numeric:tabular-nums}
  .legend{padding:8px 8px 4px;color:var(--ink2);font-size:12px;line-height:1.6}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>一个微型 Transformer 的全部内部</h1>
    <span class="meta">${fmt(chapters.total)} · 1920×1080 · 24fps · ${chapters.chapters.length} 个场景 ·
      <b>所有数字均为真实运算</b>（约 2.8k 参数模型，页面内训练 900 步）</span>
  </header>

  <div class="grid">
    <div class="stage">
      <div class="vwrap">
        <video id="v" src="llm-narration.mp4" preload="metadata" playsinline></video>
        <div class="sub" id="sub"></div>
      </div>
      <div class="bar">
        <button id="pp" title="空格">▶ 播放</button>
        <button id="b10" title="←">−10s</button>
        <button id="f10" title="→">+10s</button>
        <input type="range" id="seek" min="0" max="${Math.round(chapters.total * 1000)}" value="0" step="1">
        <span class="clock" id="clock">0:00 / ${fmt(chapters.total)}</span>
        <button id="sp" title="S">1.0×</button>
        <button id="fs" title="F">全屏</button>
      </div>
      <div class="hint">
        快捷键 <kbd>空格</kbd>播放/暂停 · <kbd>←</kbd><kbd>→</kbd>±10s · <kbd>F</kbd>全屏 · <kbd>S</kbd>倍速 ·
        点右侧章节跳转。字幕由脚本台词直接渲染，离线可用。
      </div>
    </div>

    <nav class="toc" id="toc">
      <div class="legend">完整覆盖：原理 → 一次推理 → 真实张量 → 训练闭环。<br>点击任意场景跳转。</div>
${chaptersHtml}
    </nav>
  </div>
</div>

<script>
var LINES = ${JSON.stringify(lines)};
var CHAPTERS = ${JSON.stringify(chapters.chapters)};
function fmt(s){ s = Math.max(0, Math.round(s||0)); return Math.floor(s/60) + ':' + String(s%60).padStart(2,'0'); }

var v = document.getElementById('v'), sub = document.getElementById('sub'),
    pp = document.getElementById('pp'), seek = document.getElementById('seek'),
    clock = document.getElementById('clock'), sp = document.getElementById('sp');
var SPEEDS = [1, 1.25, 1.5, 2, 0.75], si = 0;

function setPP() { pp.textContent = v.paused ? '▶ 播放' : '⏸ 暂停'; pp.classList.toggle('on', !v.paused); }
pp.onclick = function () { v.paused ? v.play() : v.pause(); };
document.getElementById('b10').onclick = function () { v.currentTime = Math.max(0, v.currentTime - 10); };
document.getElementById('f10').onclick = function () { v.currentTime = Math.min(v.duration, v.currentTime + 10); };
sp.onclick = function () { si = (si + 1) % SPEEDS.length; v.playbackRate = SPEEDS[si]; sp.textContent = SPEEDS[si].toFixed(2).replace(/\\.?0+$/, '') + '×'; };
document.getElementById('fs').onclick = function () {
  var st = document.querySelector('.stage');
  if (document.fullscreenElement) document.exitFullscreen(); else st.requestFullscreen && st.requestFullscreen();
};
seek.addEventListener('input', function () { v.currentTime = seek.value / 1000; });
function tick() {
  if (!seek.matches(':active')) seek.value = Math.round(v.currentTime * 1000);
  clock.textContent = fmt(v.currentTime) + ' / ' + fmt(v.duration || 0);
  // 字幕
  var t = v.currentTime * 1000, hit = null;
  for (var i = 0; i < LINES.length; i++) { if (t >= LINES[i].a && t < LINES[i].z) { hit = LINES[i]; break; } }
  sub.textContent = hit ? hit.text : '';
  // 高亮当前章节
  var cur = 0;
  for (var k = 0; k < CHAPTERS.length; k++) { if (t / 1000 >= CHAPTERS[k].t) cur = k; }
  var bs = document.querySelectorAll('.ch');
  for (var j = 0; j < bs.length; j++) bs[j].classList.toggle('on', +bs[j].dataset.i === cur);
}
/* timeupdate 在暂停/程序化 seek 时不一定触发，所以再加一个 250ms 的兜底轮询 */
v.addEventListener('timeupdate', tick);
setInterval(tick, 250); tick();
v.addEventListener('play', setPP); v.addEventListener('pause', setPP); setPP();

var toc = document.getElementById('toc');
toc.addEventListener('click', function (e) {
  var b = e.target.closest('.ch'); if (!b) return;
  v.currentTime = +b.dataset.t; v.play();
});
document.addEventListener('keydown', function (e) {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); v.paused ? v.play() : v.pause(); }
  else if (e.code === 'ArrowLeft') v.currentTime = Math.max(0, v.currentTime - 10);
  else if (e.code === 'ArrowRight') v.currentTime = Math.min(v.duration, v.currentTime + 10);
  else if (e.key === 'f' || e.key === 'F') document.getElementById('fs').click();
  else if (e.key === 's' || e.key === 'S') sp.click();
});
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(DIST, 'film.html'), html);
console.log('写出 dist/film.html', (fs.statSync(path.join(DIST, 'film.html')).size / 1024).toFixed(0) + ' KB',
  '| 台词', lines.length, '条 | 章节', chapters.chapters.length, '个');
