import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoServer } from '../apps/server/server.mjs';
import { Readable } from 'node:stream';
function request(server, path, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise(resolve => {
    const req = Readable.from([Buffer.from(body)]);
    Object.assign(req, { method, url: path, headers: {host:'127.0.0.1:3000',...headers} });
    const res = { socket: {localPort:3000}, writeHead(status, responseHeaders) { this.status = status; this.headers = responseHeaders; }, end(data) { resolve({status:this.status, json:async()=>JSON.parse(data)}); } };
    server.emit('request',req,res);
  });
}
test('HTTP adapter rejects cross-origin mutations and validates JSON', async () => {
  const server = createDemoServer();
    const snapshot = await (await request(server, '/api/demo')).json();
    assert.equal(snapshot.resources.length, 1);
    const cross = await request(server, '/api/demo/preferences', {method:'POST',headers:{'content-type':'application/json',origin:'https://attacker.example'},body:'{"storage":[]}'});
    assert.equal(cross.status,403);
    const malformed = await request(server, '/api/demo/preferences', {method:'POST',headers:{'content-type':'application/json'},body:'{'});
    assert.equal(malformed.status,400);
    const consent = await request(server, '/api/demo/consent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client:'https://app.example',acknowledged:true,methods:['get','put'],resources:[snapshot.resources[0].id]})});
    const token = await consent.json(); assert.equal(consent.status,200);
    const created=await request(server,'/rpc',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token.access_token}`},body:JSON.stringify({tx:'seed',resource:snapshot.resources[0].id,contract:snapshot.resources[0].contracts[0],method:'put',args:{key:'known',value:'seed',ifMatch:null}})});assert.equal(created.status,200);
    const rpc = await request(server, '/rpc',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token.access_token}`},body:JSON.stringify({tx:'http-test',resource:snapshot.resources[0].id,contract:snapshot.resources[0].contracts[0],method:'get',args:{key:'known'}})});
    assert.equal(rpc.status,200);assert.equal((await rpc.json()).result.value,'seed');
    const unknown = await request(server, '/.well-known/bindle/manifest.json'); assert.equal(unknown.status,404);
});
