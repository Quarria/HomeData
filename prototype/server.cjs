const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const allowed = {'/':'index.html','/index.html':'index.html','/style.css':'style.css','/app.js':'app.js','/assets/bricolage.ttf':'assets/bricolage.ttf'};
http.createServer((req,res)=>{
  const file=allowed[new URL(req.url,'http://localhost').pathname];
  if(!file){res.writeHead(404);res.end('Not found');return;}
  res.setHeader('Content-Type',file.endsWith('.ttf')?'font/ttf':file.endsWith('.css')?'text/css; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  fs.createReadStream(path.join(__dirname,file)).pipe(res);
}).listen(4173,'127.0.0.1',()=>console.log('家常账原型：http://127.0.0.1:4173/'));
