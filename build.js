/* 打包：把模块化项目压成 dist/index.html 单文件（便于分发 / 离线双击）
 * 用法： node build.js
 */
const fs = require('fs');
const path = require('path');
const root = __dirname;

let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// 1) 内联 CSS
// 注意：必须用「函数式替换」。若直接传字符串，源码里的 $& / $1 / $' 等
// 会被 String.replace 当成特殊替换模式，从而损坏内联内容（three.min.js 大量含 $）。
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
html = html.replace('<link rel="stylesheet" href="styles.css">', () => '<style>\n' + css + '\n</style>');

// 2) 内联所有 JS（含 data/trace.js 参考值）
const files = [
  'src/three.min.js',
  'src/orbit-controls.js',
  'src/model.js',
  'src/icons.js',
  'src/core.js',
  'src/engine.js',
  'src/viz-forward.js',
  'src/viz-train.js',
  'src/viz-explore.js',
  'src/viz-attn.js',
  'src/viz-kv.js',
  'src/topics.js',
  'src/trace.js',
  'data/trace.js',
  'src/narration.js',
  'src/app.js',
];
for (const f of files) {
  let src = fs.readFileSync(path.join(root, f), 'utf8');
  src = src.replace(/<\/script>/gi, '<\\/script>');
  // index.html 中带 ?v=3 之类的版本号，逐一匹配
  const re = new RegExp('<script src="' + f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\?v=\\d+)?"\\></script>');
  if (!re.test(html)) throw new Error('script tag not found: ' + f);
  html = html.replace(re, () => '<script>\n' + src + '\n</script>');
}

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', 'index.html');
fs.writeFileSync(out, html);
console.log('built', out, (fs.statSync(out).size / 1024).toFixed(0) + ' KB');