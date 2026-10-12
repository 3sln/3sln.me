import { test } from 'node:test';
import assert from 'node:assert/strict';
const manifest = {version:'0',issuer:'https://self.example',authorization_endpoint:'https://self.example/login',token_endpoint:'https://self.example/token',rpc_endpoint:'https://self.example/rpc',jwks_uri:'https://self.example/keys',login_presentation:['redirect']};
const reply = value => ({status:200,ok:true,headers:{get:()=> 'application/json'},text:async()=>JSON.stringify(value)});
import { parseIdentity, discoverIdentity } from '../src/identity.mjs';
test('default host applies only before an explicit @', () => {
  assert.equal(parseIdentity('alex').handle, 'alex@3sln.me');
  assert.equal(parseIdentity('alex@self.example').manifestUrl, 'https://self.example/.well-known/bindle/manifest.json');
  assert.throws(() => parseIdentity('alex@'));
  assert.throws(() => parseIdentity('alex@evil.example/path'));
  for(const handle of ['alex@127.0.0.1','alex@2130706433','alex@0x7f000001','a\u0001@self.example'])assert.throws(()=>parseIdentity(handle));
});
test('only definite missing manifest allows email fallback', async () => {
  assert.equal((await discoverIdentity('alex@mail.example', { fetcher: async () => ({ status: 404 }) })).kind, 'email-fallback');
  await assert.rejects(discoverIdentity('alex@mail.example', { fetcher: async () => { throw new Error('offline'); } }), /offline/);
  await assert.rejects(discoverIdentity('alex@mail.example', { fetcher: async () => ({status:500,ok:false}) }), /500/);
});
test('discovery never embeds handle as HTTP URL credentials', async () => {
  let requested;
  await discoverIdentity('alex@self.example', { fetcher: async url => { requested=url; return reply(manifest); } });
  assert.equal(requested, 'https://self.example/.well-known/bindle/manifest.json');
});

test('rejects unsupported metadata and cross-origin endpoint delegation', async () => {
  for (const patch of [{version:'1'}, {issuer:'https://attacker.example'}, {rpc_endpoint:'https://attacker.example/rpc'}, {login_presentation:['iframe']}, {token_endpoint:7}]) {
    await assert.rejects(discoverIdentity('alex@self.example', {fetcher:async()=>reply({...manifest,...patch})}));
  }
});
