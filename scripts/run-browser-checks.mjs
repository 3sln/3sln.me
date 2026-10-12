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
const config=JSON.parse(await readFile('wrangler.local.jsonc','utf8'));
config.main=resolve(config.main);config.assets.directory=resolve(config.assets.directory);delete config.$schema;
config.vars.APP_ORIGIN=origin;
await writeFile('.output/e2e-wrangler.json',JSON.stringify(config));
await writeFile('.output/.dev.vars',`KEY_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\n`,{mode:0o600});
const worker=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js','dev','--config','.output/e2e-wrangler.json','--port',String(port),'--persist-to',persistence],{stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:resolve('.output/e2e-wrangler.log')}});
let failed;
worker.once('error',error=>{failed=error;});
worker.once('exit',code=>{failed=new Error(`Wrangler exited before checks completed (${code}).`);});
let logs='';for(const stream of [worker.stdout,worker.stderr])stream.on('data',chunk=>{logs+=chunk;});
try{
  let ready=false;for(let i=0;i<90;i++){if(failed)throw failed;try{const response=await fetch(`${origin}/api/config`);if(response.ok&&(await response.json()).origin===origin){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}
  if(!ready)throw new Error('Wrangler did not become ready.');
  const suite=spawn(process.execPath,['--test','--test-concurrency=1','tests/e2e/recovery-crypto.test.mjs','tests/e2e/recovery-security.test.mjs','tests/e2e/worker-flow.test.mjs','tests/e2e/ui-adversarial.test.mjs','tests/e2e/plans-search.test.mjs','tests/browser/recovery-layout.mjs'],{stdio:'inherit',env:{...process.env,E2E_BASE_URL:origin,E2E_ARTIFACTS:'artifacts/browser'}});
  const code=await new Promise(resolve=>suite.once('exit',resolve));if(code!==0)process.exitCode=code||1;
}finally{worker.kill('SIGTERM');await new Promise(resolve=>{if(worker.exitCode!==null)return resolve();worker.once('exit',resolve);setTimeout(resolve,5000).unref();});await writeFile('artifacts/browser/wrangler.log',logs.replace(/([?&]sig=)[^\s]*/g,'$1[redacted]'));await rm(persistence,{recursive:true,force:true});}
