import {createPushTransport} from '../../packages/messaging/web-push.mjs';
import {identityBackupPort} from '../../packages/runtime/identity-backup.mjs';
import http from 'node:http';
import { Readable } from 'node:stream';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import application from '../../packages/runtime/http.mjs';
import {createNodeMetadataFetch} from '../../packages/apps/node-metadata-fetch.mjs';
import {parseClients} from '../../packages/mcp/service.mjs';
import { createIdentityEngine, createArgon2Hasher, createWebAuthnAdapter } from '../../packages/identity/index.mjs';
import { nodeResources } from './resources.mjs';

export async function createNodeServer({directory=resolve('.data'),config={},mailer}={}){
 const origin=config.APP_ORIGIN||process.env.APP_ORIGIN||'http://localhost:8788';const parsed=new URL(origin);const local=parsed.protocol==='http:'&&parsed.hostname==='localhost';
 await mkdir(directory,{recursive:true,mode:0o700});let secret=config.KEY_ENCRYPTION_KEY||process.env.KEY_ENCRYPTION_KEY;
 if(!secret){try{secret=await readFile(resolve(directory,'encryption-key'),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;secret=randomBytes(32).toString('base64');await writeFile(resolve(directory,'encryption-key'),secret,{mode:0o600,flag:'wx'});}}
 const settings={...Object.fromEntries(['STORAGE_WRITE_SERVICE_MONTHLY_LIMIT','STORAGE_WRITE_FREE_PER_HOUR','STORAGE_WRITE_FREE_PER_DAY','STORAGE_WRITE_PAID_PER_HOUR','STORAGE_WRITE_PAID_PER_DAY','STORAGE_WRITE_OWNER_PER_MINUTE','STORAGE_WRITE_APP_PER_MINUTE','STORAGE_WRITE_MAINTENANCE_MONTHLY_LIMIT','STORAGE_WRITE_MAINTENANCE_PERCENT'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]])),STORAGE_WRITE_ENABLED:process.env.STORAGE_WRITE_ENABLED??'true',APP_ORIGIN:origin,RP_ID:parsed.hostname,TERMS_VERSION:'2026-10-11',LOCAL_DEVELOPMENT:local?'true':'false',RELEASE_READY:'false',SIGNUP_ENABLED:process.env.SIGNUP_ENABLED||'false',SIGNUP_CONTACT_REQUIRED:process.env.SIGNUP_CONTACT_REQUIRED||'false',PUSH_ENABLED:process.env.PUSH_ENABLED||'false',VAPID_PUBLIC_KEY:process.env.VAPID_PUBLIC_KEY||'',VAPID_PRIVATE_KEY:process.env.VAPID_PRIVATE_KEY||'',BRAND_NAME:'Personal Space',KEY_ENCRYPTION_KEY:secret,TURNSTILE_SITE_KEY:process.env.TURNSTILE_SITE_KEY||'',TURNSTILE_SECRET_KEY:process.env.TURNSTILE_SECRET_KEY||'',GOOGLE_CLIENT_ID:process.env.GOOGLE_CLIENT_ID||'',GOOGLE_CLIENT_SECRET:process.env.GOOGLE_CLIENT_SECRET||'',ALLOWED_CONNECTOR_HOSTS:process.env.ALLOWED_CONNECTOR_HOSTS||'',BILLING_ENABLED:process.env.BILLING_ENABLED||'false',POLAR_SERVER:process.env.POLAR_SERVER||'sandbox',POLAR_METADATA_PREFIX:process.env.POLAR_METADATA_PREFIX||'3sln_me_',POLAR_CATALOG_MODE:process.env.POLAR_CATALOG_MODE||'static',POLAR_ORGANIZATION_ID:process.env.POLAR_ORGANIZATION_ID||'',POLAR_PRODUCT_ID_PAID:process.env.POLAR_PRODUCT_ID_PAID||'',POLAR_PRODUCT_ID_PLUS:process.env.POLAR_PRODUCT_ID_PLUS||'',POLAR_PRODUCT_ID_ULTRA:process.env.POLAR_PRODUCT_ID_ULTRA||'',POLAR_ACCESS_TOKEN:process.env.POLAR_ACCESS_TOKEN||'',POLAR_WEBHOOK_SECRET:process.env.POLAR_WEBHOOK_SECRET||'',WORK_LIMITS_ENABLED:process.env.WORK_LIMITS_ENABLED||'true',APP_METADATA_DISCOVERY_ENABLED:process.env.APP_METADATA_DISCOVERY_ENABLED||'false',MCP_ENABLED:process.env.MCP_ENABLED||'false',MCP_LAYOUT:process.env.MCP_LAYOUT||'mcp-auth-v1-64',MCP_CLIENTS:process.env.MCP_CLIENTS||'[]',CONVERSATION_PEER_ORIGINS:process.env.CONVERSATION_PEER_ORIGINS||'',BEAM_ENABLED:process.env.BEAM_ENABLED||'false',BEAM_MONTHLY_DELIVERY_BYTES:process.env.BEAM_MONTHLY_DELIVERY_BYTES||'1000000000',BEAM_MONTHLY_OFFERS:process.env.BEAM_MONTHLY_OFFERS||'20',BEAM_STUN_ENABLED:process.env.BEAM_STUN_ENABLED||'true',BEAM_TURN_ENABLED:process.env.BEAM_TURN_ENABLED||'false',CLOUDFLARE_TURN_KEY_ID:process.env.CLOUDFLARE_TURN_KEY_ID||'',CLOUDFLARE_TURN_API_TOKEN:process.env.CLOUDFLARE_TURN_API_TOKEN||'',FEDERATION_ENABLED:process.env.FEDERATION_ENABLED||'false',FEDERATION_REFRESH_ENABLED:process.env.FEDERATION_REFRESH_ENABLED||'true',FEDERATION_CLIENTS:process.env.FEDERATION_CLIENTS||'[]',FEDERATION_SCHEMAS:process.env.FEDERATION_SCHEMAS||'{}',...config};
 if(settings.APP_METADATA_DISCOVERY_ENABLED==='true'&&!settings.APP_METADATA_FETCH){const allowedOrigins=[...new Set(parseClients(settings).flatMap(client=>[...(client.origins??[]),...client.redirectUris.map(uri=>new URL(uri).origin)]))].filter(origin=>{const url=new URL(origin);return url.protocol==='https:'&&(!url.port||url.port==='443');});settings.APP_METADATA_FETCH=createNodeMetadataFetch({allowedOrigins});}
 settings.RECOVERY_SIGNING_KEY ||= process.env.RECOVERY_SIGNING_KEY;
 if(!settings.RECOVERY_SIGNING_KEY){
  const authorityPath=resolve(directory,'recovery-signing-key');
  try{settings.RECOVERY_SIGNING_KEY=await readFile(authorityPath,'utf8');}catch(error){
   if(error.code!=='ENOENT')throw error;
   const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
   settings.RECOVERY_SIGNING_KEY=JSON.stringify({kid:crypto.randomUUID(),privateJWK:await crypto.subtle.exportKey('jwk',pair.privateKey)});
   await writeFile(authorityPath,settings.RECOVERY_SIGNING_KEY,{mode:0o600,flag:'wx'});
  }
 }
 const resources=await nodeResources({directory,config:settings});const webauthn=await createWebAuthnAdapter(),passwordHasher=await createArgon2Hasher();
 if(local&&settings.SIGNUP_IP_WINDOW_MS===undefined)settings.SIGNUP_IP_WINDOW_MS='1000';if(local&&settings.SIGNUP_IP_DAILY_LIMIT===undefined)settings.SIGNUP_IP_DAILY_LIMIT='20';
 const ports={...settings,BILLING_CATALOG:resources.catalog,EMAIL_AVAILABLE:typeof mailer?.sendVerification==='function',IDENTITY_REPOSITORY:resources.repository,ACCOUNTS:resources.accounts,ABUSE:resources.abuse,ASSETS:resources.assets,MCP_AUTHORITY:resources.mcp,FEDERATION_AUTHORITY:resources.federation};
 const delivery=createPushTransport(settings),pushTransport=delivery?{...delivery,async register({owner,subscription}){const result=await resources.accounts.get(owner).invoke({method:'registerSignupPush',args:[owner,{subscription}]});if(result?.$fault)throw Object.assign(new Error(result.$fault.message),result.$fault);return result;}}:null;ports.PUSH_AVAILABLE=Boolean(pushTransport);ports.EMAIL_SETUP_AVAILABLE=typeof mailer?.sendSetupCode==='function';
 ports.IDENTITY_ENGINE=()=>createIdentityEngine({repository:resources.repository,deviceRequests:resources.deviceRequests,crypto,mailer,pushTransport,identityBackup:identityBackupPort({config:settings,accounts:resources.accounts}),paidHandleEligibility:async owner=>{const result=await resources.accounts.get(owner).invoke({method:'paidHandleEligibility',args:[owner]});if(result?.$fault)throw Object.assign(new Error(result.$fault.message),result.$fault);return result===true;},turnstile:{verify:input=>application.turnstile(ports,input)},rateLimiter:{check:input=>application.rateLimit(ports,input)},webauthn,passwordHasher,config:{requireReachability:settings.SIGNUP_CONTACT_REQUIRED==='true',origin,rpID:parsed.hostname,rpName:settings.BRAND_NAME,termsVersion:settings.TERMS_VERSION,allowInsecureLocalhost:local}});
 const server=http.createServer(async(req,res)=>{
  try{
   if(req.headers.host!==parsed.host)return void res.writeHead(403).end('Use the configured account host.');
   const headers=new Headers();for(const [key,value]of Object.entries(req.headers))if(value!==undefined&&!['cf-connecting-ip','cf-ipcountry','x-forwarded-for','x-real-ip'].includes(key))headers.set(key,Array.isArray(value)?value.join(', '):value);
   // Ignore spoofed proxy headers. Deploy behind a trusted reverse proxy with an
   // explicit network-identity adapter before relying on forwarded client IPs.
   headers.set('CF-Connecting-IP',req.socket.remoteAddress||'unknown');
   const request=new Request(new URL(req.url,origin),{method:req.method,headers,...['GET','HEAD'].includes(req.method)?{}:{body:Readable.toWeb(req),duplex:'half'}});
   const response=await application.fetch(request,ports,{waitUntil:promise=>promise.catch(()=>{})});
   res.writeHead(response.status,Object.fromEntries(response.headers));if(response.body)Readable.fromWeb(response.body).pipe(res);else res.end();
  }catch{res.writeHead(500,{'Content-Type':'application/json','Cache-Control':'no-store'}).end('{"error":"internal_error"}');}
 });
 return {server,resources,fetch:request=>application.fetch(request,ports,{waitUntil:promise=>promise.catch(()=>{})}),close:async()=>{await new Promise(resolve=>server.listening?server.close(resolve):resolve());resources.close();}};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const app=await createNodeServer();const port=Number(process.env.PORT||new URL(process.env.APP_ORIGIN||'http://localhost:8788').port||8788);
 app.server.listen(port,'127.0.0.1',()=>console.log(`Personal Space Node server ready on port ${port}.`));
 for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{await app.close();process.exit();});
}
