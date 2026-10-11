const http = require('http');
const fs = require('fs');
const path = require('path');
const root = __dirname;
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = path.join(root, p);
  if (!fp.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (e, d) => {
    if (e) { res.writeHead(404); return res.end('404 ' + p); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(d);
  });
}).listen(8712, '127.0.0.1', () => console.log('serving 8712 from ' + root));