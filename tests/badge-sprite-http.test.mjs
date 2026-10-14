import test from 'node:test';
import assert from 'node:assert/strict';
import application from '../packages/runtime/http.mjs';
const origin='https://personal.example';
function fixture(extra={}){
 const env={APP_ORIGIN:origin,SIGNUP_ENABLED:'false',...extra,IDENTITY_ENGINE:()=>{throw Error('Sprite must not access identities');},IDENTITY_REPOSITORY:{get:()=>{throw Error('Sprite must not access accounts');}}};
 return path=>application.fetch(new Request(origin+path),env);
}
test('generated sprite is versioned, cacheable, conditional and independent of accounts',async()=>{
 const env={APP_ORIGIN:origin,SIGNUP_ENABLED:'false',ONBOARDING_NAMES:'["private-name"]',BADGE_DEFINITIONS:JSON.stringify([{id:'team',name:'Host team',description:'Local team badge',svg:'<svg viewBox="0 0 24 24"><path d="M2 2h20v20H2z" fill="currentColor"/></svg>'}]),IDENTITY_ENGINE:()=>{throw Error('Must not access identity');}};
 const get=(path,options={})=>application.fetch(new Request(origin+path,options),env);
 const configResponse=await get('/api/config');assert.equal(configResponse.status,200);const config=await configResponse.json();assert.match(config.badgePolicy.path,/^\/api\/badges\/sprite\.svg\?v=[a-f0-9]{64}$/);
 assert.deepEqual(config.badgePolicy.definitions,[{id:'team',name:'Host team',description:'Local team badge'}]);assert(!JSON.stringify(config.badgePolicy).includes('private-name'));assert(!JSON.stringify(config.badgePolicy).includes('<svg'));
 const sprite=await get(config.badgePolicy.path);assert.equal(sprite.status,200);assert.match(sprite.headers.get('Content-Type'),/^image\/svg\+xml/);assert.match(sprite.headers.get('Cache-Control'),/immutable/);assert.equal(sprite.headers.get('Set-Cookie'),null);
 const svg=await sprite.text();assert.match(svg,/<symbol[^>]*id="team"/);assert(svg.includes('Host team'));assert(!svg.includes('private-name'));
 const etag=sprite.headers.get('ETag');const conditional=await get(config.badgePolicy.path,{headers:{'If-None-Match':'W/'+etag}});assert.equal(conditional.status,304);assert.equal(await conditional.text(),'');
 const head=await get(config.badgePolicy.path,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('ETag'),etag);assert.equal(await head.text(),'');
 assert.equal((await get('/api/badges/sprite.svg?v='+'0'.repeat(64))).status,404);
 assert.equal((await get(config.badgePolicy.path+'&v='+etag.slice(1,-1))).status,404);
 assert.equal((await get('/api/badges/sprite.svg',{method:'POST'})).status,405);
 const plain=await get('/api/badges/sprite.svg');assert.equal(plain.headers.get('Cache-Control'),'public, max-age=0, must-revalidate');
});
test('malformed optional badges leave sign-in configuration readable and sprite fails closed',async()=>{
 const get=fixture({BADGE_DEFINITIONS:'[invalid]',HOST_NAME_POLICY:'{invalid}'});
 const configResponse=await get('/api/config');assert.equal(configResponse.status,200);const config=await configResponse.json();assert.deepEqual(config.badgePolicy,{path:null,definitions:[]});assert.equal(config.passwordEnabled,true);assert.equal(config.passkeyEnabled,true);
 const sprite=await get('/api/badges/sprite.svg');assert.equal(sprite.status,503);assert.equal((await sprite.json()).error,'badges_unavailable');
});
