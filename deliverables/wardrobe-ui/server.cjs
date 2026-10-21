const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (!['/', '/index.html'].includes(url.pathname)) { res.writeHead(404); res.end('Not found'); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
}).listen(4175, '127.0.0.1', () => console.log('Wardrobe prototype: http://127.0.0.1:4175/'));
