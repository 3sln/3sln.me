import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {generateServiceWorker} from '../scripts/build-service-worker.mjs';
const hash=body=>createHash('sha256').update(body).digest('hex');
async function fixture(){
 const out=await mkdtemp(join(tmpdir(),'3sln-public-cache-'));await mkdir(join(out,'assets','vendor'),{recursive:true});
 const bodies=new Map([['/assets/main.1234567890.js','import "./other.js";'],['/assets/other.abcdef1234.js','export const value=1;'],['/assets/vendor/chunk-ABCDEFGH.js','export const vendor=true;'],['/assets/recovery.0987654321.js','self.onmessage=()=>{};'],['/assets/app.0123456789.css','body{}'],['/assets/wireup-app.abcde12345.js','document.write("public app");'],['/icon.svg','<svg/>'],['/console.html','<!doctype html><script src="/assets/wireup-app.abcde12345.js"></script>']]);
 bodies.set('/index.html','<!doctype html><h1>Static landing</h1>');bodies.set('/index.es.html','<!doctype html><h1>Portada</h1>');
 for(const [url,body]of bodies)await writeFile(join(out,url.slice(1)),body);
 const result={buildId:'1234567890',config:{out,assetRoot:'assets'},imports:{'/assets/main.js':'/assets/main.1234567890.js','/assets/other.js':'/assets/other.abcdef1234.js'},entries:{app:{module:'/assets/main.1234567890.js',css:'/assets/app.0123456789.css',wireup:'/assets/wireup-app.abcde12345.js'}},workers:{recovery:'/assets/recovery.0987654321.js'},html:['console.html','index.html','index.es.html']};
 const manifest=await generateServiceWorker(result,{publicAssets:['/icon.svg']});for(const path of Object.values(manifest.offlineLandings))bodies.set(path,await readFile(join(out,path.slice(1)),'utf8'));bodies.set(manifest.offlineDocument,await readFile(join(out,manifest.offlineDocument.slice(1)),'utf8'));
 return{out,result,bodies,manifest,source:await readFile(join(out,'sw.js'),'utf8'),close:()=>rm(out,{recursive:true,force:true})};
}
function harness(source,bodies,{failure,mutate,headers}={}){
 const listeners=new Map(),rows=new Map(),calls=[],deleted=[];let offline=false,putFailure=false;
 const key=value=>new URL(typeof value==='string'?value:value.url,'https://app.example').pathname;
 const caches={keys:async()=>[...rows.keys()],delete:async name=>{deleted.push(name);return rows.delete(name);},open:async name=>{if(!rows.has(name))rows.set(name,new Map());const store=rows.get(name);return{put:async(url,response)=>{if(putFailure)throw new Error('storage full');store.set(key(url),response.clone());},match:async url=>store.get(key(url))?.clone()};}};
 const fetch=async request=>{const url=key(request);calls.push({url,credentials:request.credentials});if(offline||url===failure)throw new Error('offline');if(!bodies.has(url))return new Response('missing',{status:404});return new Response(mutate?.url===url?mutate.body:bodies.get(url),{headers:headers?.url===url?headers.values:{}});};
 const context=vm.createContext({self:{location:{origin:'https://app.example'},addEventListener:(type,fn)=>listeners.set(type,fn)},caches,fetch,Request,Response,URL,crypto,console});vm.runInContext(source,context);
 const lifecycle=async type=>{let work;listeners.get(type)({waitUntil:promise=>work=promise});await work;};
 const request=async(path,mode='cors',method='GET')=>{let response;listeners.get('fetch')({request:{url:'https://app.example'+path,method,mode},respondWith:promise=>response=promise,waitUntil:()=>{}});return response?await response:undefined;};
 return{listeners,rows,calls,deleted,lifecycle,request,setOffline:value=>offline=value,setPutFailure:value=>putFailure=value};
}
test('manifest includes actual hashed graph, worker, vendor shared chunks and matching offline HTML',async()=>{
 const f=await fixture();try{
  const urls=f.manifest.assets.map(asset=>asset.url);assert(urls.includes('/assets/vendor/chunk-ABCDEFGH.js'));assert(urls.includes(f.result.workers.recovery));assert(urls.includes(f.manifest.offlineDocument));assert(!urls.includes('/index.html'));assert(!urls.includes('/'));
  for(const asset of f.manifest.assets)assert.equal(asset.sha256,hash(f.bodies.get(asset.url)));
  assert(f.source.includes(f.result.buildId));assert(!f.source.includes('/*__3SLN_PUBLIC_BUILD__*/null'));
  const first=f.manifest.cacheVersion;await writeFile(join(f.out,'icon.svg'),'<svg>changed</svg>');const changed=await generateServiceWorker(f.result,{publicAssets:['/icon.svg']});assert.notEqual(changed.cacheVersion,first);
 }finally{await f.close();}
});
test('generator rejects private endpoints, unhashed graph targets and unsafe copied files',async()=>{
 const f=await fixture();try{
  for(const path of ['/api/config','/recovery/file.json','/users/owner','/contact/token','https://other.example/icon.svg','/assets/../api/config'])await assert.rejects(generateServiceWorker(f.result,{publicAssets:[path]}));
  await assert.rejects(generateServiceWorker({...f.result,imports:{bad:'/src/main.mjs'}}));
  await writeFile(join(f.out,'assets','config.json'),'{}');await assert.rejects(generateServiceWorker(f.result),/Unfingerprinted/);
 }finally{await f.close();}
});
test('install is complete or rejected on missing changed private or uncacheable dependency; prior caches survive',async()=>{
 const f=await fixture();try{
  for(const options of [{failure:'/assets/other.abcdef1234.js'},{mutate:{url:'/assets/other.abcdef1234.js',body:'different graph'}},{headers:{url:'/assets/other.abcdef1234.js',values:{'cache-control':'private, no-store'}}},{headers:{url:'/assets/other.abcdef1234.js',values:{'set-cookie':'session=private'}}}]){
   const h=harness(f.source,f.bodies,options);h.rows.set('3sln-public-shell:older',new Map());h.rows.set('unrelated-cache',new Map());await assert.rejects(h.lifecycle('install'));assert.deepEqual([...h.rows.keys()],['3sln-public-shell:older','unrelated-cache']);assert.equal(h.deleted.length,0);
  }
  const h=harness(f.source,f.bodies);await h.lifecycle('install');assert.equal([...h.rows.values()][0].size,f.manifest.assets.length);assert(h.calls.every(call=>call.credentials==='omit'));
  h.rows.set('3sln-public-shell:older',new Map());h.rows.set('unrelated-cache',new Map());await h.lifecycle('activate');assert.equal(h.deleted.length,0);
 }finally{await f.close();}
});
test('offline navigation uses only its own matching HTML; immutable fetches never cache private responses',async()=>{
 const f=await fixture();try{
  const h=harness(f.source,f.bodies);await h.lifecycle('install');h.setOffline(true);
  assert.equal(await(await h.request('/','navigate')).text(),f.bodies.get(f.manifest.offlineLandings.en));
  assert.equal(await(await h.request('/console','navigate')).text(),f.bodies.get(f.manifest.offlineDocument));
  assert.equal(await(await h.request('/?lang=es','navigate')).text(),f.bodies.get(f.manifest.offlineLandings.es));
  assert.equal(await(await h.request('/assets/main.1234567890.js')).text(),f.bodies.get('/assets/main.1234567890.js'));
  for(const path of ['/api/config','/api/identity/recover','/users/alice','/authorize','/recovery','/contact/token','/?account=alice','/assets/main.1234567890.js?token=secret'])assert.equal(await h.request(path,'navigate'),undefined);
  assert.equal(await h.request('/assets/main.1234567890.js','cors','POST'),undefined);
  const own=[...h.rows.values()][0];own.delete(f.manifest.offlineDocument);h.rows.set('3sln-public-shell:older',new Map([[f.manifest.offlineDocument,new Response('mismatched old HTML')]]));assert.equal((await h.request('/console','navigate')).type,'error');
 }finally{await f.close();}
});
test('live navigation remains uncached and storage failures cannot delete an existing generation',async()=>{
 const f=await fixture();try{
  f.bodies.set('/','<html>nonce-bearing live document</html>');const h=harness(f.source,f.bodies);await h.lifecycle('install');
  assert.equal(await(await h.request('/','navigate')).text(),f.bodies.get('/'));assert.equal([...h.rows.values()][0].has('/'),false);
  h.setPutFailure(true);await assert.rejects(h.lifecycle('install'));assert.equal(h.deleted.length,0);assert.equal([...h.rows.values()][0].size,f.manifest.assets.length);
  const fresh=harness(f.source,f.bodies);fresh.setPutFailure(true);await assert.rejects(fresh.lifecycle('install'));assert.equal(fresh.rows.size,0);
 }finally{await f.close();}
});
