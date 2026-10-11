/* 分段导出全片，最后无损拼接。
 *
 * 为什么要分段：headless Chrome 在软件光栅下连续渲染上千帧后偶尔会崩，
 * 一次性跑完 8000+ 帧风险太高。分段后每段几分钟，崩了只损失一段。
 *
 * 用法： node render-all.js
 *       SEG=75 FPS=24 node render-all.js
 */
const fs = require('fs'), path = require('path');
const { spawnSync } = require('child_process');

const NODE = process.execPath;
const FPS = parseFloat(process.env.FPS || '24');
const SEG = parseFloat(process.env.SEG || '75');      // 每段秒数
const TOTAL = parseFloat(process.env.TOTAL || '0');   // 0 = 向页面问
const OUTDIR = path.join(__dirname, 'out');
const ENV = Object.assign({}, process.env, { NO_PROXY: '*', no_proxy: '*', http_proxy: '', https_proxy: '' });

/* 注意：本机 Node 在 PTY 会话下用管道捕获子进程输出会 EBUSY，
 * 所以一律用 stdio:'inherit'，跨进程传值走文件。 */
function run(cmd, args, env) {
  return spawnSync(cmd, args, { stdio: 'inherit', env: env || ENV });
}

// 先问页面总时长（子进程把结果写进 out/_total.txt）
function totalSeconds() {
  const f = path.join(OUTDIR, '_total.txt');
  try { fs.unlinkSync(f); } catch (_) { }
  const r = run(NODE, [path.join(__dirname, 'probe-total.js')]);
  const raw = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '';
  const v = parseFloat(raw);
  if (!isFinite(v) || v <= 0) throw new Error('拿不到影片总时长（probe 退出码 ' + r.status + '，读到「' + raw + '」）');
  return v;
}

(function main() {
  const total = TOTAL > 0 ? TOTAL : totalSeconds();
  const nSeg = Math.ceil(total / SEG);
  console.log(`总时长 ${total.toFixed(1)}s → 分 ${nSeg} 段（每段 ${SEG}s），${FPS}fps`);
  const parts = [];
  for (let i = 0; i < nSeg; i++) {
    const a = i * SEG, b = Math.min(total, (i + 1) * SEG);
    const out = path.join(OUTDIR, `seg-${String(i).padStart(2, '0')}.mp4`);
    parts.push(out);
    console.log(`\n===== 第 ${i + 1}/${nSeg} 段  ${a.toFixed(0)}s ~ ${b.toFixed(0)}s =====`);
    const t0 = Date.now();
    const r = run(NODE, [path.join(__dirname, 'record-film.js')], Object.assign({}, ENV, {
      START: String(a), END: String(b), OUT: out, FPS: String(FPS),
    }));
    const ok = fs.existsSync(out) && fs.statSync(out).size > 10000;
    console.log(`段 ${i + 1} 退出码 ${r.status}, 产物 ${ok ? (fs.statSync(out).size / 1048576).toFixed(1) + ' MB' : '缺失'}, 用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }

  const good = parts.filter(p => fs.existsSync(p) && fs.statSync(p).size > 10000);
  console.log(`\n可用分段 ${good.length}/${nSeg}`);
  if (good.length !== nSeg) {
    console.log('有分段缺失，先不拼接。缺失:', parts.filter(p => !good.includes(p)).map(p => path.basename(p)).join(', '));
    process.exit(2);
  }
  const listFile = path.join(OUTDIR, 'concat.txt');
  fs.writeFileSync(listFile, good.map(p => "file '" + p.replace(/\\/g, '/') + "'").join('\n') + '\n');
  const final = path.join(OUTDIR, 'llm-narration.mp4');
  console.log('拼接 →', path.basename(final));
  const c = run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', final]);
  if (c.status !== 0) { console.log('拼接失败，退出码', c.status); process.exit(3); }
  console.log(`完成 ${(fs.statSync(final).size / 1048576).toFixed(1)} MB  -> ${final}`);
})();
