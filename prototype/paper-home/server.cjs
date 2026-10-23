const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
http.createServer((req,res)=>{
  if (!['/','/index.html'].includes(new URL(req.url,'http://localhost').pathname)) {res.writeHead(404);res.end();return;}
  res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
  fs.createReadStream(path.join(__dirname,'index.html')).pipe(res);
}).listen(4185,'127.0.0.1',()=>console.log('http://127.0.0.1:4185'));
