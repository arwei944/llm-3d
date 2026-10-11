const fs = require('fs');
let s = fs.readFileSync('src/model.js', 'utf8');

// 移除调试字段
s = s.replace(/\n\s*m\._dxBoundary = m\._dxBoundary \|\| \{\};/, '');
s = s.replace(/\n\s*m\._dxBoundary\[l\] = Float32Array\.from\(dxout\);.*\n/, '\n');
s = s.replace(/\n\s*m\._dbg = m\._dbg \|\| \{\};\n\s*m\._dbg\['dxn1_' \+ l\] = Float32Array\.from\(dxn1\);/, '');

// 移除 xn1 注入钩子（整块）
s = s.replace(/\n\s*\/\/ 测试钩子：注入到 RMSNorm1 之后[^\n]*\n\s*if \(inject && inject\['xn1_' \+ l\]\) \{\n[^}]*\n\s*\}\n/, '\n');

fs.writeFileSync('src/model.js', s);

const hooks = (s.match(/inject && inject/g) || []).length;
const dbg = (s.match(/_dbg|_dxBoundary/g) || []).length;
const sig = (s.match(/function forward\(m, ids, inject\)/g) || []).length;
console.log('inject hooks left:', hooks, '| debug refs left:', dbg, '| forward signature:', sig);