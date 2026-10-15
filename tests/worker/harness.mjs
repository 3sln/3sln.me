import {ShardedIdentityRepository} from '../../packages/runtime/identity-shards.mjs';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const harness = `
import worker, { IdentityDirectory, AccountObject, AbuseGuard, McpAuthorizationObject, FederationObject, PlanCatalogObject } from './apps/worker/index.mjs';
import {createWorkerArgon2Hasher}from'./apps/worker/password.mjs';
import {createPushTransport}from'./packages/messaging/web-push.mjs';
export {McpAuthorizationObject,PlanCatalogObject};
export class TestDirectory extends IdentityDirectory {
  async pushVector(config,subscription,payload){let sent;const transport=createPushTransport(config,{fetcher:async(url,options)=>{sent=options;return new Response(null,{status:201});}}),result=await transport.send(subscription,payload);return {accepted:result.accepted,encrypted:!Buffer.from(sent.body).includes(Buffer.from(payload.proof)),encoding:new Headers(sent.headers).get('Content-Encoding'),redirect:sent.redirect};}
  async rows(){return [...await this.ctx.storage.list()];}
  async alarmAt(){return this.ctx.storage.getAlarm();}
  async fireAlarm(){await this.ctx.storage.deleteAlarm();await super.alarm();}
  async passwordVector(password, encoded){const hasher=createWorkerArgon2Hasher();return {match:await hasher.verify(password,encoded),wrong:await hasher.verify(password+'wrong',encoded)};}
}
export class TestAccount extends AccountObject {
  async seed(owner, records){await this.warm(owner);for(const [key,value]of records)await this.ctx.storage.put(key,value);}
  async rows(){return [...await this.ctx.storage.list()];}
  async blobReadCounter(){this.blobReads=0;const original=this.originalBlobGet??=this.controller.blobs.get.bind(this.controller.blobs);this.controller.blobs.get=(...args)=>{this.blobReads++;return original(...args);};}
  async readCount(){return this.blobReads||0;}
  async evictCold(){await this.ctx.storage.put('lastOwnerActiveAt',0);await super.alarm();}
  async restoreCold(owner){await this.warm(owner);return [...await this.ctx.storage.list()];}
  async alarmAt(){return this.ctx.storage.getAlarm();}
}
export class TestAbuse extends AbuseGuard {async rows(){return [...await this.ctx.storage.list()];} async fireAlarm(){await this.ctx.storage.deleteAlarm();await super.alarm();} }
export class TestFederation extends FederationObject {
 async rows(){return [...await this.ctx.storage.list()];}
 async alarmAt(){return this.ctx.storage.getAlarm();}
 async expireEphemeral(){for(const [key,value]of await this.ctx.storage.list({prefix:'federation/'}))if(value.expiresAt){value.expiresAt=Date.now()-1;await this.ctx.storage.put(key,value);}}
 async fireAlarm(){await this.ctx.storage.deleteAlarm();await super.alarm();}
}
export default worker;`;
export async function createHarness(options={}){
let mf, directory, accounts, abuse, archives, temporary;
const origin='http://localhost:8787';
const authority=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const recoverySigningKey=JSON.stringify({kid:crypto.randomUUID(),privateJWK:await crypto.subtle.exportKey('jwk',authority.privateKey)});
  temporary = await mkdtemp(path.join(tmpdir(), '3sln-worker-contact-'));
  const out = path.join(temporary, 'worker.mjs');
  await build({ stdin: { contents: harness, resolveDir: process.cwd(), sourcefile: 'test-harness.mjs' }, outfile: out,
    bundle: true, format: 'esm', platform: 'browser', mainFields: ['browser', 'module', 'main'], conditions: ['workerd', 'worker', 'browser'],
    external: ['cloudflare:workers', 'node:*'], target: 'es2022', logLevel: 'silent',
    banner: { js: "import * as util from 'node:util'; import * as fs from 'node:fs'; import * as stream from 'node:stream'; import * as buffer from 'node:buffer'; import * as nodeAssertBuiltin from 'node:assert'; import * as zlib from 'node:zlib'; import * as nodeCrypto from 'node:crypto'; import * as nodeHttps from 'node:https'; import * as nodeUrl from 'node:url'; import * as nodeHttp from 'node:http'; import * as nodeNet from 'node:net'; import * as nodeTls from 'node:tls'; const nodeModules={'node:util':util,'node:fs':fs,'node:stream':stream,'node:buffer':buffer,'node:assert':nodeAssertBuiltin,'node:zlib':zlib,'node:crypto':nodeCrypto,'node:https':nodeHttps,'node:url':nodeUrl,'node:http':nodeHttp,'node:net':nodeNet,'node:tls':nodeTls}; const require=name=>{if(!nodeModules[name])throw new Error('Unexpected builtin '+name);return nodeModules[name].default??{...nodeModules[name]};};" },
    plugins: [{ name: 'worker-test-imports', setup(build) {
      build.onResolve({ filter: /^(?:util|fs|stream|buffer|assert|zlib|crypto|https|url|http|net|tls)$/ }, args => ({ path: `node:${args.path}`, external: true }));
      build.onResolve({ filter: /\.wasm$/ }, args => ({ path: `./${path.basename(args.path)}`, external: true }));
    } }] });
  for (const name of ['argon2', 'blake2b']) await copyFile(path.resolve(`vendor/hash-wasm/${name}.wasm`), path.join(temporary, `${name}.wasm`));
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'contact-integration-test', modulesRoot: temporary, modules: [{ type: 'ESModule', path: out }, ...['argon2', 'blake2b'].map(name => ({ type: 'CompiledWasm', path: path.join(temporary, `${name}.wasm`) }))],
    compatibilityDate: '2026-10-11', compatibilityFlags: ['nodejs_compat'], log: new Log(LogLevel.ERROR),
    bindings: { APP_ORIGIN: origin, RP_ID: 'localhost', TERMS_VERSION: '2026-10-11', LOCAL_DEVELOPMENT: 'true', IDENTITY_LAYOUT:'v1-64-fresh', STORAGE_WRITE_ENABLED:'true', MCP_ENABLED:'true',MCP_LAYOUT:'mcp-auth-v1-64',MCP_CLIENTS:JSON.stringify([{id:'agent.example',name:'Example agent',redirectUris:['https://agent.example/callback']}]), SIGNUP_IP_WINDOW_MS:'1000', SIGNUP_IP_DAILY_LIMIT:'20',
      RECOVERY_SIGNING_KEY:recoverySigningKey, KEY_ENCRYPTION_KEY: Buffer.alloc(32, 42).toString('base64'), ABUSE_HASH_KEY: 'isolated-test-rate-limit-key',...options.bindings },
    durableObjects: { PLAN_CATALOG:{className:'PlanCatalogObject',useSQLite:true}, FEDERATION:{className:'TestFederation',useSQLite:true}, MCP_AUTH:{className:'McpAuthorizationObject',useSQLite:true}, IDENTITIES: { className: 'TestDirectory', useSQLite: true }, ACCOUNTS: { className: 'TestAccount', useSQLite: true }, ABUSE: { className: 'TestAbuse', useSQLite: true } },
    r2Buckets: ['BLOBS', 'ARCHIVES'], serviceBindings: { ASSETS: options.assets ?? (async () => new Response('<!doctype html><title>Test</title>', { headers: { 'Content-Type': 'text/html' } })) } }));
  const identities = await mf.getDurableObjectNamespace('IDENTITIES'); directory = new ShardedIdentityRepository({shard:name=>identities.get(identities.idFromName(name)),layout:'v1-64-fresh'});directory.passwordVector=(...args)=>identities.get(identities.idFromName('password-vector-test')).passwordVector(...args);
  accounts = await mf.getDurableObjectNamespace('ACCOUNTS'); abuse = await mf.getDurableObjectNamespace('ABUSE'); archives = await mf.getR2Bucket('ARCHIVES');

async function request(route, { method = 'GET', value, headers = {}, raw, form } = {}) {
  return mf.dispatchFetch(`${origin}${route}`, { method, headers: { ...(value !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(form ? { body:form } : value !== undefined || raw !== undefined ? { body: raw ?? JSON.stringify(value) } : {}) });
}
async function signup(handle = `test_${crypto.randomUUID().slice(0, 8)}`) {
  const start = await request('/api/auth/signup', { method: 'POST', value: { handle, method: 'password', password: 'isolated test account password', termsAccepted: true, termsVersion: '2026-10-11', turnstileToken: 'local-browser-test-token' }, headers: { Origin: origin } });
  assert.equal(start.status, 200); const pending = await start.json();
  const download = await request('/api/auth/recovery/download', { method: 'POST', value: { pendingToken: pending.pendingToken }, headers: { Origin: origin } });
  assert.equal(download.status, 200); const file = await download.json();
  const activation = await request('/api/auth/recovery/confirm', { method: 'POST', value: { pendingToken: pending.pendingToken, recoveryToken: file.recoveryToken, downloadConfirmed: true }, headers: { Origin: origin } });
  assert.equal(activation.status, 200); const result = await activation.json();
  return { result, pending, file, cookie: activation.headers.get('Set-Cookie').split(';')[0] };
}

return {mf,origin,directory,accounts,abuse,archives,request,signup,close:async()=>{await mf?.dispose();if(temporary)await rm(temporary,{recursive:true,force:true});}};
}
