import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
await mkdir('artifacts/browser',{recursive:true});
// Isolated local persistence prevents fixture rate-limit history from affecting CI.
await mkdir('.output',{recursive:true});
const reservation=createServer();
await new Promise((resolve,reject)=>{reservation.once('error',reject);reservation.listen(0,'127.0.0.1',resolve);});
const port=reservation.address().port;
await new Promise((resolve,reject)=>reservation.close(error=>error?reject(error):resolve()));
const origin=`http://localhost:${port}`;
const persistence=await mkdtemp(`${tmpdir()}/3sln-browser-state-`);
const configDirectory=await mkdtemp(resolve('.output/e2e-run-'));
const configPath=resolve(configDirectory,'wrangler.json');
const config=JSON.parse(await readFile('wrangler.local.jsonc','utf8'));
config.main=resolve(config.main);config.assets.directory=resolve(config.assets.directory);delete config.$schema;
config.vars.APP_ORIGIN=origin;
// Only the app document is a fixture; OAuth, consent, token and RPC requests
// use real browser networking against the local Worker.
config.vars.FEDERATION_ENABLED='true';
config.vars.FEDERATION_CLIENTS=JSON.stringify([{id:'https://bindle-client.example/client',name:'Independent fixture app',origin:'https://bindle-client.example',redirectUris:['https://bindle-client.example/callback']}]);
const storageContract='https://3sln.me/artefacts/contracts/object-storage/v1';
config.vars.FEDERATION_SCHEMAS=JSON.stringify({
 'https://schema.example/sync/v1':{id:'https://schema.example/sync/v1',title:'Sync preferences',description:'Choose the values and storage used to keep your files in sync.',publisher:'https://schema.example',fields:{displayName:{title:'Display name',type:'string',maxLength:100},files:{title:'Storage resources',type:'resource',contracts:[storageContract],cardinality:{min:1,max:2}}}},
 'https://schema.example/optional/v1':{id:'https://schema.example/optional/v1',title:'Optional personalization',description:'An optional preference.',publisher:'https://schema.example',fields:{value:{title:'Optional value',type:'string',maxLength:100}}}
});
await writeFile(configPath,JSON.stringify(config));
const recoveryAuthority=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const recoverySigningKey=JSON.stringify({kid:crypto.randomUUID(),privateJWK:await crypto.subtle.exportKey('jwk',recoveryAuthority.privateKey)});
await writeFile(resolve(configDirectory,'.dev.vars'),`KEY_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\nRECOVERY_SIGNING_KEY=${recoverySigningKey}\n`,{mode:0o600});
const worker=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js','dev','--config',configPath,'--port',String(port),'--persist-to',persistence],{stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:resolve(configDirectory,'wrangler.log')}});
let failed;
worker.once('error',error=>{failed=error;});
worker.once('exit',code=>{failed=new Error(`Wrangler exited before checks completed (${code}).`);});
let logs='';for(const stream of [worker.stdout,worker.stderr])stream.on('data',chunk=>{logs+=chunk;});
try{
  let ready=false;for(let i=0;i<90;i++){if(failed)throw failed;try{const response=await fetch(`${origin}/api/config`);if(response.ok&&(await response.json()).origin===origin){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}
  if(!ready)throw new Error('Wrangler did not become ready.');
  const defaultTests=['tests/e2e/build-model.test.mjs','tests/e2e/identity-names.test.mjs','tests/e2e/recovery-crypto.test.mjs','tests/e2e/recovery-security.test.mjs','tests/e2e/worker-flow.test.mjs','tests/e2e/ui-adversarial.test.mjs','tests/e2e/plans-search.test.mjs','tests/e2e/beaming.test.mjs','tests/e2e/mcp-conversations.test.mjs','tests/e2e/app-connections.test.mjs','tests/e2e/browser-automation.test.mjs','tests/e2e/browser-automation-native.test.mjs','tests/e2e/resource-verification.test.mjs','tests/e2e/google-drive.test.mjs','tests/e2e/branding.test.mjs','tests/browser/recovery-layout.mjs'];
  const suite=spawn(process.execPath,['--test','--test-concurrency=1',...(process.argv.length>2?process.argv.slice(2):defaultTests)],{stdio:'inherit',env:{...process.env,E2E_BASE_URL:origin,E2E_ARTIFACTS:'artifacts/browser'}});
  const code=await new Promise(resolve=>suite.once('exit',resolve));if(code!==0)process.exitCode=code||1;
}finally{worker.kill('SIGTERM');await new Promise(resolve=>{if(worker.exitCode!==null)return resolve();worker.once('exit',resolve);setTimeout(resolve,5000).unref();});await writeFile('artifacts/browser/wrangler.log',logs.replace(/([?&]sig=)[^\s]*/g,'$1[redacted]'));await rm(persistence,{recursive:true,force:true});await rm(configDirectory,{recursive:true,force:true});}

// Keep real signup admission policy intact. The original portal suite already
// uses the regional allowance; federation gets its own fresh durable state.
if(process.argv.length===2){
 const federationSuite=spawn(process.execPath,[process.argv[1],'tests/e2e/federation.test.mjs'],{stdio:'inherit',env:process.env});
 const code=await new Promise((resolve,reject)=>{federationSuite.once('error',reject);federationSuite.once('exit',resolve);});
 if(code!==0)process.exitCode=process.exitCode||code||1;
}
