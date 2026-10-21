import {createLocalTestKeyHolder} from './local-test-key-holder.mjs';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {mkdir,readdir,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {SqliteMailboxStore} from './storage.mjs';
import {createMailbox,enabled} from '../worker/mailbox.mjs';
import {createHTTP,httpError} from '../worker/http.mjs';
import {servicePorts} from '../worker/ports.mjs';
import {metadataPort} from '../worker/metadata.mjs';
import {createEdgeIndex,flushEdgeOutbox} from '../../../packages/bindlebox-engine/store/edge-index.mjs';
import {createConversationEdge,flushConversationEdge} from '../../../packages/bindlebox-engine/domains/conversations.mjs';
import {fault} from '../../../packages/bindlebox-engine/faults.mjs';
export async function createNodeShell({directory='.output/bindlebox',BINDLEBOX_ENABLED=false,services,egress,secret,clientId,portsFor,clock,assetsDirectory=resolve('.output/bindlebox-public'),localTestArchiveKeys=false}={}){
 const on=enabled(BINDLEBOX_ENABLED),boxes=new Map();let indexStore,edge,conversationEdge;
 if(on){await mkdir(directory,{recursive:true,mode:0o700});indexStore=new SqliteMailboxStore(join(directory,'links.sqlite'),{clock});edge={check:header=>createEdgeIndex(indexStore).check(header),publish:entry=>indexStore.transaction(tx=>createEdgeIndex(tx).publish(entry))};conversationEdge={check:(...args)=>createConversationEdge(indexStore,{now:clock?.now}).check(...args),route:token=>createConversationEdge(indexStore).route(token),publish:entry=>indexStore.transaction(tx=>createConversationEdge(tx).publish(entry))};}
 const flush=async(store,owner)=>{await flushEdgeOutbox(store,edge,owner);await flushConversationEdge(store,conversationEdge,owner);};
 const mailbox=async owner=>{
  if(!on)fault('not_found','Messaging is disabled.',404);if(!/^[a-f0-9-]{36}$/.test(owner))fault('unauthorized','Invalid owner.',401);
  if(!boxes.has(owner)){const store=new SqliteMailboxStore(join(directory,owner+'.sqlite'),{clock}),ports=portsFor?portsFor(owner,store):servicePorts({services,egress,store,secret,clientId,clock});
   // Publish the promise before the first await: simultaneous HTTP calls share one engine/SQLite writer.
   const ready=(async()=>{if(localTestArchiveKeys&&!ports.ownerKeys)ports.ownerKeys=await createLocalTestKeyHolder({store,clock});const box=createMailbox({store,ports,clock,BINDLEBOX_ENABLED:on});await box.open(owner);store.onAlarm=async()=>{await box.alarm();await flush(store,owner);};await store.recover();return {store,box,async run(owner,name,params){const result=await box.run(owner,name,params);await flush(store,owner);return result;}};})();boxes.set(owner,ready);ready.catch(()=>boxes.delete(owner));
  }return boxes.get(owner);
 };
 // Restore timers for ALL persisted mailboxes on process startup, including users with no incoming HTTP traffic.
 if(on)for(const file of await readdir(directory))if(/^[a-f0-9-]{36}\.sqlite$/.test(file))await mailbox(file.slice(0,-7));
 const fetch=createHTTP({BINDLEBOX_ENABLED:on,services,assets:async request=>{const path=new URL(request.url).pathname;try{return new Response(await readFile(join(assetsDirectory,path.slice(1))),{headers:{'Content-Type':path.endsWith('.mjs')?'text/javascript; charset=utf-8':'text/css; charset=utf-8','X-Content-Type-Options':'nosniff'}});}catch{return new Response('Not found',{status:404});}},edge,conversationEdge,mailbox,metadata:metadataPort({clientId,services}),authenticate:services?.authenticate?request=>services.authenticate({authorization:request.headers.get('Authorization'),method:request.method,url:request.url}):undefined});
 return {fetch,mailbox,async provision(owner,input){const {box}=await mailbox(owner);return box.provision(owner,input);},async close(){for(const ready of boxes.values()){const {box,store}=await ready;await box.dispose();await store.close();}await indexStore?.close();}};
}
export async function listenNodeShell(options={}){
 const shell=await createNodeShell(options),origin=options.origin??'http://127.0.0.1:8790';
 const server=createServer(async(req,res)=>{try{const request=new Request(new URL(req.url,origin),{method:req.method,headers:req.headers,...['GET','HEAD'].includes(req.method)?{}:{body:Readable.toWeb(req),duplex:'half'}}),response=await shell.fetch(request);res.writeHead(response.status,Object.fromEntries(response.headers));if(!response.body)return res.end();Readable.fromWeb(response.body).pipe(res);}catch(error){const response=httpError(error);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());}});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(options.port??8790,options.host??'127.0.0.1',resolve);});return {shell,server,async close(){await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await shell.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const adapters=process.env.BINDLEBOX_ADAPTER_MODULE?await import(pathToFileURL(resolve(process.env.BINDLEBOX_ADAPTER_MODULE)).href):{},host=await listenNodeShell({BINDLEBOX_ENABLED:process.env.BINDLEBOX_ENABLED??false,directory:process.env.BINDLEBOX_DATA_DIRECTORY??'.output/bindlebox',secret:process.env.BINDLEBOX_KEY_ENCRYPTION_KEY,clientId:process.env.BINDLEBOX_CLIENT_ID,services:adapters.services,egress:adapters.egress,localTestArchiveKeys:process.env.BINDLEBOX_LOCAL_TEST_KEY_HOLDER==='1'});for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await host.close();process.exitCode=0;});}
