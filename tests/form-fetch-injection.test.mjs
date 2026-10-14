import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configuredFormOrigins} from '../packages/apps/form-fetch-policy.mjs';
import {nodeResources} from '../apps/node/resources.mjs';
import {createNodeServer} from '../apps/node/server.mjs';
const origin='https://app.example',owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const clients=[{id:origin+'/client',origin,name:'App',redirectUris:[origin+'/callback']}];
const config={APP_ORIGIN:'https://provider.example',KEY_ENCRYPTION_KEY:Buffer.alloc(32,1).toString('base64'),FEDERATION_CLIENTS:JSON.stringify(clients)};
async function directory(t){const dir=await mkdtemp(join(tmpdir(),'bindle-form-injection-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('form egress config is a strict separate origin approval intersected with exact client origins',()=>{
 assert.deepEqual(configuredFormOrigins(config),[]);assert.deepEqual(configuredFormOrigins({...config,FORM_POSTBACK_ORIGINS:'[]'}),[]);
 assert.deepEqual(configuredFormOrigins({...config,FORM_POSTBACK_ORIGINS:JSON.stringify([origin,'https://unregistered.example'])}),[origin]);
 assert.deepEqual(configuredFormOrigins({FORM_POSTBACK_ORIGINS:JSON.stringify([origin]),FEDERATION_CLIENTS:'[]'}),[]);
 for(const value of ['',{},'{}','not-json',['*'],[origin,origin],['https://*.example'],[' https://app.example'],['https://app.example/'],['https://app.example:444'],['http://localhost:8787']])assert.throws(()=>configuredFormOrigins({...config,LOCAL_DEVELOPMENT:'true',FORM_POSTBACK_ORIGINS:value}));
 for(const FEDERATION_CLIENTS of ['{}','not-json',[{origin:'https://app.example/path'}],[{origin:'https://APP.example'}],[{}]])assert.throws(()=>configuredFormOrigins({...config,FORM_POSTBACK_ORIGINS:[origin],FEDERATION_CLIENTS}));
 assert.deepEqual(configuredFormOrigins({...config,LOCAL_DEVELOPMENT:'true',FORM_POSTBACK_ORIGINS:[origin],FEDERATION_CLIENTS:[...clients,{origin:'http://localhost:8787'}]}),[origin]);
});
test('actual Node resources inject the pinned port only for explicitly approved registered origins',async t=>{
 for(const approved of [[],[origin],['https://unregistered.example']]){const resources=await nodeResources({directory:await directory(t),config:{...config,FORM_POSTBACK_ORIGINS:approved,FORM_POSTBACK_TRANSPORT:{send(){throw Error('Untrusted override');}}}});try{const account=resources.accounts.get(owner);await account.metadata.get('@alarm');const port=account.config.FORM_POSTBACK_TRANSPORT;assert.equal(typeof port?.send==='function',approved.includes(origin));if(port)await assert.rejects(port.send({url:'http://localhost:8787/forbidden'}));}finally{resources.close();}}
 const malformed=await nodeResources({directory:await directory(t),config:{...config,FORM_POSTBACK_ORIGINS:'*'}});try{const account=malformed.accounts.get(owner);await account.touch(owner);assert.equal(account.config.FORM_POSTBACK_TRANSPORT,undefined);assert.equal(await account.metadata.get('owner'),owner);assert((await account.snapshot(owner)).collections.length>0);}finally{malformed.close();}
});
test('actual Node server forwards environment approval and explicit config can keep it disabled',async t=>{
 const previous=process.env.FORM_POSTBACK_ORIGINS;process.env.FORM_POSTBACK_ORIGINS=JSON.stringify([origin]);t.after(()=>{if(previous===undefined)delete process.env.FORM_POSTBACK_ORIGINS;else process.env.FORM_POSTBACK_ORIGINS=previous;});
 for(const overrides of [{},{FORM_POSTBACK_ORIGINS:'[]'}]){const app=await createNodeServer({directory:await directory(t),config:{...config,APP_ORIGIN:'http://localhost:8788',STORAGE_WRITE_ENABLED:'false',...overrides}});try{assert.equal(typeof app.resources.accounts.get(owner).config.FORM_POSTBACK_TRANSPORT?.send==='function',overrides.FORM_POSTBACK_ORIGINS===undefined);}finally{await app.close();}}
});
test('Node host accepts an explicit code-injected transport without accepting a config override',async t=>{
 const transport={async send(){throw Error('Controlled fixture only');}};
 const app=await createNodeServer({directory:await directory(t),config:{...config,APP_ORIGIN:'http://localhost:8788',FORM_POSTBACK_ORIGINS:'[]',STORAGE_WRITE_ENABLED:'false'},formTransport:transport});
 try{assert.equal(app.resources.accounts.get(owner).config.FORM_POSTBACK_TRANSPORT,transport);}finally{await app.close();}
 await assert.rejects(nodeResources({directory:await directory(t),config,formTransport:{}}),TypeError);
});
