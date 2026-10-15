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
// Each fixture signs up from its own documentation-range IP pseudonym, so the per-IP cooldown and daily
// windows keep their configured values. All fixtures share one /24, one region ("unknown" under wrangler dev)
// and the global windows, which a full suite of ~40 signups would exhaust; only those aggregate windows are
// sized for this isolated, throwaway Worker. Production limits live in wrangler.jsonc and are untouched.
Object.assign(config.vars,{SIGNUP_SUBNET_DAILY_LIMIT:'500',SIGNUP_REGION_HOURLY_LIMIT:'500',SIGNUP_REGION_DAILY_LIMIT:'500',SIGNUP_GLOBAL_HOURLY_LIMIT:'500',SIGNUP_GLOBAL_DAILY_LIMIT:'500'});
// Only the app document is a fixture; OAuth, consent, token and RPC requests
// use real browser networking against the local Worker.
config.vars.FEDERATION_ENABLED='true';
// The authorization-entry suite runs in its own Worker with the entry store and a dedicated loopback embed origin.
if(process.env.E2E_AUTHORIZATION_ENTRIES==='1')Object.assign(config.vars,{FEDERATION_ENTRY_ENABLED:'true',EMBED_ORIGIN:`http://127.0.0.1:${port}`});
config.vars.FEDERATION_CLIENTS=JSON.stringify([{id:'https://bindle-client.example/client',name:'Independent fixture app',origin:'https://bindle-client.example',redirectUris:['https://bindle-client.example/callback']}]);
const storageContract='https://3sln.me/artefacts/contracts/object-storage/v1';
config.vars.FEDERATION_SCHEMAS=JSON.stringify({
 'https://3sln.me/artefacts/preferences/app-messages/v1':JSON.parse(await readFile('docs/artefacts/app-message-preferences-v1.json','utf8')),
 'https://schema.example/sync/v1':{id:'https://schema.example/sync/v1',title:'Sync preferences',description:'Choose the values and storage used to keep your files in sync.',publisher:'https://schema.example',fields:{displayName:{title:'Display name',type:'string',maxLength:100},files:{title:'Storage resources',type:'resource',contracts:[storageContract],cardinality:{min:1,max:2}}}},
 'https://schema.example/optional/v1':{id:'https://schema.example/optional/v1',title:'Optional personalization',description:'An optional preference.',publisher:'https://schema.example',fields:{value:{title:'Optional value',type:'string',maxLength:100}}}
});
const recoveryAuthority=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const recoverySigningKey=JSON.stringify({kid:crypto.randomUUID(),privateJWK:await crypto.subtle.exportKey('jwk',recoveryAuthority.privateKey)});
const appMessageAuthority=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const appMessageKid='fixture-'+crypto.randomUUID();
const appMessagePrivate={...await crypto.subtle.exportKey('jwk',appMessageAuthority.privateKey),kid:appMessageKid,alg:'ES256',use:'sig'};
config.vars.APP_NOTIFICATION_PUBLIC_JWKS=JSON.stringify({keys:[{...await crypto.subtle.exportKey('jwk',appMessageAuthority.publicKey),kid:appMessageKid,alg:'ES256',use:'sig'}]});
// Host administration walkthrough (tests/e2e/admin-console.test.mjs, run first because the
// token's mint window is 30 minutes): a fresh
// single-use boot token for this exact origin; only its digest reaches the Worker.
const {mintBootToken,bootTokenDigest}=await import('../packages/identity/boot.mjs');
const bootToken=mintBootToken(origin);config.vars.BOOTSTRAP_TOKEN_SHA256=await bootTokenDigest(bootToken);
const onboardingKey=randomBytes(32).toString('base64url');
await writeFile(configPath,JSON.stringify(config));
await writeFile(resolve(configDirectory,'.dev.vars'),`KEY_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\nSESSION_COOKIE_KEY=${randomBytes(32).toString('base64url')}\nRECOVERY_SIGNING_KEY=${recoverySigningKey}\nAPP_NOTIFICATION_SIGNING_JWK=${JSON.stringify(appMessagePrivate)}\nONBOARDING_KEY=${onboardingKey}\n`,{mode:0o600});
const worker=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js','dev','--config',configPath,'--port',String(port),'--persist-to',persistence],{stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:resolve(configDirectory,'wrangler.log')}});
let failed;
worker.once('error',error=>{failed=error;});
worker.once('exit',code=>{failed=new Error(`Wrangler exited before checks completed (${code}).`);});
let logs='';for(const stream of [worker.stdout,worker.stderr])stream.on('data',chunk=>{logs+=chunk;});
try{
  let ready=false;for(let i=0;i<90;i++){if(failed)throw failed;try{const response=await fetch(`${origin}/api/config`);if(response.ok&&(await response.json()).origin===origin){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}
  if(!ready)throw new Error('Wrangler did not become ready.');
  const defaultTests=['tests/e2e/admin-console.test.mjs','tests/e2e/multi-account.test.mjs','tests/e2e/multi-account-source.test.mjs','tests/e2e/host-badges-source.test.mjs','tests/e2e/token-onboarding-source.test.mjs','tests/e2e/message-frame.test.mjs','tests/e2e/message-submissions.test.mjs','tests/e2e/signup-views.test.mjs','tests/e2e/static-landing.test.mjs','tests/e2e/build-model.test.mjs','tests/e2e/identity-names.test.mjs','tests/e2e/recovery-crypto.test.mjs','tests/e2e/recovery-security.test.mjs','tests/e2e/worker-flow.test.mjs','tests/e2e/setup-contact-native.test.mjs','tests/e2e/ui-adversarial.test.mjs','tests/e2e/ui-chaos.test.mjs','tests/e2e/ui-chaos-scale.test.mjs','tests/e2e/ui-chaos-contention.test.mjs','tests/e2e/plans-search.test.mjs','tests/e2e/beaming.test.mjs','tests/e2e/mcp-conversations.test.mjs','tests/e2e/app-connections.test.mjs','tests/e2e/browser-automation.test.mjs','tests/e2e/browser-automation-native.test.mjs','tests/e2e/resource-verification.test.mjs','tests/e2e/google-drive.test.mjs','tests/e2e/branding.test.mjs','tests/e2e/links-worker.test.mjs','tests/e2e/links-conditional.test.mjs','tests/browser/recovery-layout.mjs'];
  const suite=spawn(process.execPath,['--test','--test-concurrency=1',...(process.argv.length>2?process.argv.slice(2):defaultTests)],{stdio:'inherit',env:{...process.env,E2E_BASE_URL:origin,E2E_ARTIFACTS:'artifacts/browser',E2E_BOOT_TOKEN:bootToken}});
  const code=await new Promise(resolve=>suite.once('exit',resolve));if(code!==0)process.exitCode=code||1;
}finally{worker.kill('SIGTERM');await new Promise(resolve=>{if(worker.exitCode!==null)return resolve();worker.once('exit',resolve);setTimeout(resolve,5000).unref();});await writeFile('artifacts/browser/wrangler.log',logs.replace(/([?&]sig=)[^\s]*/g,'$1[redacted]'));await rm(persistence,{recursive:true,force:true});await rm(configDirectory,{recursive:true,force:true});}

// Federation and the authorization-entry slice each get their own fresh Worker and durable state.
if(process.argv.length===2){
 for(const [suite,extra] of [['tests/e2e/federation.test.mjs',{}],['tests/e2e/authorization-entry.test.mjs',{E2E_AUTHORIZATION_ENTRIES:'1'}],['tests/e2e/authorization-entry-ui.test.mjs',{E2E_AUTHORIZATION_ENTRIES:'1'}]]){
  const child=spawn(process.execPath,[process.argv[1],suite],{stdio:'inherit',env:{...process.env,...extra}});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  if(code!==0)process.exitCode=process.exitCode||code||1;
 }
 // The islands suites start their own Worker (embed origin, dedicated client; islands-sw adds real HTTPS through a test
 // proxy), so they run once, directly, after the shared Worker has stopped. The embeddable-element and provider-matrix
 // suites need no Worker: they serve the SDK from this checkout against testing.mjs mock providers behind page.route.
 for(const suite of ['tests/browser/islands-embed.mjs','tests/browser/islands-sw.mjs','tests/browser/islands-chaos.mjs','tests/browser/embed-elements.mjs','tests/browser/provider-matrix.mjs']){
  const child=spawn(process.execPath,['--test',suite],{stdio:'inherit',env:{...process.env,E2E_ARTIFACTS:'artifacts/browser'}});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  if(code!==0)process.exitCode=process.exitCode||code||1;
 }
}
