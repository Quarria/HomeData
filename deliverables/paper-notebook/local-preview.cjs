const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const root=path.resolve(__dirname,'../..');
const localRequire=createRequire(path.join(root,'apps/web/package.json'));
const ts=localRequire('typescript');
const source=fs.readFileSync(path.join(root,'apps/web/tests/e2e/life-calendar.spec.ts'),'utf8');
const head=source.slice(0,source.indexOf('\nfunction navigation(')).replace(/^import .*?;\r?\n/gm,'');
const js=ts.transpile(head+'\nreturn setup;', {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None});
const setup=new Function("path",js)(path);
let handler;
(async()=>{
 await setup({clock:{install:async()=>{}},route:async(pattern,callback)=>handler=callback});
 http.createServer(async(req,res)=>{
  try {
   if(req.url.startsWith('/api/v1/')) {
    const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks).toString();
    const request={url:()=>`http://127.0.0.1:5180${req.url}`,method:()=>req.method,postDataJSON:()=>body?JSON.parse(body):{},headers:()=>req.headers};
    const fulfill=async({status=200,json})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(json));};
    if(req.url.startsWith('/api/v1/wardrobe/')||req.url.startsWith('/api/v1/ai/status'))return fulfill({json:{data:req.url.includes('/ai/status')?{enabled:false}:{items:[],nextCursor:null}}});
    return await handler({request:()=>request,fulfill});
   }
   const upstream=await fetch(`http://127.0.0.1:5173${req.url}`);
   res.writeHead(upstream.status,{'Content-Type':upstream.headers.get('content-type')||'text/plain','Cache-Control':'no-store'});
   res.end(Buffer.from(await upstream.arrayBuffer()));
  }catch(error){res.writeHead(500);res.end('Local preview error');console.error(error.message)}
 }).listen(5180,'127.0.0.1',()=>console.log('新版正式前端 · 隔离演示数据 http://127.0.0.1:5180/'));
})();

