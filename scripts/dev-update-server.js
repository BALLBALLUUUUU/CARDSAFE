'use strict';
/**
 * 本地更新服务器（联调 / 内网分发演示）
 * 用法：node scripts/dev-update-server.js [端口]
 * 然后设置更新源为 http://127.0.0.1:8787/latest.json
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || 8787);
const ROOT = path.join(__dirname, '..', 'dist');

const MIME = {
  '.json': 'application/json; charset=utf-8',
  '.zip': 'application/zip',
  '.dmg': 'application/x-apple-diskimage',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.blockmap': 'application/octet-stream',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const rel = urlPath === '/' ? 'latest.json' : urlPath.replace(/^\/+/, '');
  const file = path.join(ROOT, rel);

  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 ' + rel);
  }

  const st = fs.statSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Accept-Ranges': 'bytes',
  });
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${rel} → ${(st.size / 1024).toFixed(0)}KB`);
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`更新服务器已启动：http://127.0.0.1:${PORT}/latest.json`);
  console.log('目录：' + ROOT);
});
