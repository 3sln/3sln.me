import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeServer } from '../apps/node/server.mjs';
import { injectPreview,oembed,contactIntent,canonicalContactLink,BINDLE_INTENT_SCHEME } from '../packages/runtime/contact-preview.mjs';

// Default HTML representation of contact links: previews, intents and robots (real Node adapter).
const origin='http://localhost:8793';
let app,directory,owner;
let lane=0;const fetchURL=(url,init={})=>{const request=new Request(new URL(url,origin),init);if(!request.headers.has('CF-Connecting-IP'))request.headers.set('CF-Connecting-IP',`203.0.113.${++lane%250}`);return app.fetch(request);};
test.before(async()=>{
 directory=await mkdtemp(join(tmpdir(),'bindle-preview-'));app=await createNodeServer({directory,config:{APP_ORIGIN:origin,BRAND_NAME:'3sln.me'}});
 const post=(path,value,headers={})=>fetchURL(path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(value)});
 const signup=await post('/api/auth/signup',{method:'password',password:'Private preview account password!',termsAccepted:true,termsVersion:'2026-10-11',turnstileToken:'local-browser-test-token'}),pending=await signup.json(),setup={Cookie:signup.headers.get('Set-Cookie').split(';')[0]};
 const recovery=await (await post('/api/auth/recovery/download',{pendingToken:pending.pendingToken},setup)).json(),active=await post('/api/auth/recovery/confirm',{pendingToken:pending.pendingToken,recoveryToken:recovery.recoveryToken,downloadConfirmed:true},setup);
 const session=await active.json(),headers={Origin:origin,Cookie:active.headers.getSetCookie().find(c=>c.startsWith('bindle_session=')).split(';')[0],'X-CSRF-Token':session.csrfToken};
 owner={id:session.account.id,call:(path,value,method='POST')=>fetchURL(path,{method,headers:{...headers,...value===undefined?{}:{'Content-Type':'application/json'}},...value===undefined?{}:{body:JSON.stringify(value)}})};
});
test.after(async()=>{await app?.close();if(directory)await rm(directory,{recursive:true,force:true});});
const html=async url=>{const response=await fetchURL(url,{headers:{Accept:'text/html'}});assert.equal(response.status,200);return {response,text:await response.text()};};
const metaContent=(text,name)=>new RegExp(`<meta (?:property|name)="${name}" content="([^"]*)">`).exec(text)?.[1];
const link=async(extra={})=>(await (await owner.call('/api/contact-links',{name:'Preview',mimeTypes:['text/plain'],expiresAt:Date.now()+86400000,maxMessages:5,maxMessageBytes:4096,...extra})).json());

test('generic card for links without profile disclosure: robots, Open Graph, oEmbed discovery and both web+bindle intents; unrelated params never reflected',async()=>{
 const issued=await link(),before=JSON.stringify([...await app.resources.accounts.get(owner.id).metadata.list()]);
 const {response,text}=await html(issued.url+'&utm_source=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E');
 assert.equal(response.headers.get('X-Robots-Tag'),'noindex, nofollow, nosnippet');assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('Referrer-Policy'),'no-referrer');
 assert.match(text,/<meta name="robots" content="noindex, nofollow">/);assert.equal(metaContent(text,'og:title'),'Send a private message on 3sln.me');assert.equal(metaContent(text,'og:url'),issued.url);assert.equal(metaContent(text,'og:image'),origin+'/branding/3sln-avatar.png');assert.equal(metaContent(text,'twitter:card'),'summary');
 assert.equal(text.includes('utm_source')||text.includes('<script>alert'),false);
 assert.match(text,new RegExp(`<link rel="alternate" type="application/json\\+oembed" href="${origin.replace(/[.]/g,'\\.')}/oembed\\?format=json&amp;url=${encodeURIComponent(issued.url).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}"`));
 for(const intent of ['send-message','add-contact'])assert.ok(text.includes(`href="${contactIntent(intent,issued.url).replaceAll('&','&amp;')}"`),intent);assert.equal(BINDLE_INTENT_SCHEME,'web+bindle');
 assert.equal(JSON.stringify([...await app.resources.accounts.get(owner.id).metadata.list()]),before,'previews never write');
});

test('owner-permitted profile appears escaped in the page, the previews and oEmbed; the avatar URL is a link-scoped redirect',async()=>{
 const issued=await link();assert.equal((await owner.call('/api/profile',{displayName:'Ray "<img src=x onerror=alert(1)>"',bio:'Private biography',avatar:'https://images.example/ray.png',discloseToContacts:true},'PUT')).status,200);
 assert.equal((await owner.call(`/api/contacts/${issued.id}/beam`,{profileFields:['displayName','avatar'],beamEnabled:false},'PUT')).status,200);
 const {text}=await html(issued.url);const title=metaContent(text,'og:title');
 assert.equal(title,'Send a private message to Ray &quot;&lt;img src=x onerror=alert(1)&gt;&quot;');assert.equal(text.includes('<img src=x'),false);assert.equal(text.includes('Private biography'),false,'bio is not part of previews');
 const image=metaContent(text,'og:image').replaceAll('&amp;','&');assert.ok(image.startsWith(`${issued.url.split('?')[0]}/avatar?bindle_meta=`));
 const redirect=await fetchURL(image,{redirect:'manual'});assert.equal(redirect.status,302);assert.equal(redirect.headers.get('Location'),'https://images.example/ray.png');assert.equal((await owner.call('/api/profile',{displayName:'Ray "<img src=x onerror=alert(1)>"',bio:'Private biography',avatar:'https://evil.example/login',discloseToContacts:true},'PUT')).status,200);assert.equal((await fetchURL(image,{redirect:'manual'})).headers.get('Location'),origin+'/branding/3sln-avatar.png','non-image avatar URLs never become redirect targets');assert.equal(redirect.headers.get('Cache-Control'),'no-store');
 const embedded=await (await fetchURL(`/oembed?format=json&url=${encodeURIComponent(issued.url)}`)).json();assert.equal(embedded.type,'link');assert.equal(embedded.author_name,'Ray "<img src=x onerror=alert(1)>"');assert.equal(embedded.thumbnail_url,origin+'/branding/3sln-avatar.png','a non-image avatar falls back to the generic card');assert.equal(embedded.html,undefined);
});

test('revoked, expired, conditional-with-data and malformed links fall back to the generic card; oEmbed is link-only',async()=>{
 const issued=await link();await owner.call(`/api/contacts/${issued.id}`,undefined,'DELETE');
 const {text}=await html(issued.url);assert.equal(metaContent(text,'og:url'),origin);assert.equal(text.includes('data-bindle-intent'),false);assert.equal(text.includes('application/json+oembed'),false);
 const embedded=await (await fetchURL(`/oembed?format=json&url=${encodeURIComponent(issued.url)}`)).json();assert.equal(embedded.title,'Send a private message on 3sln.me');assert.equal(embedded.type,'link');assert.equal(embedded.thumbnail_url,origin+'/branding/3sln-avatar.png');
 assert.equal((await fetchURL(`/oembed?format=xml&url=${encodeURIComponent(issued.url)}`)).status,501);assert.equal((await fetchURL('/oembed?format=json')).status,400);assert.equal((await fetchURL('/oembed',{method:'POST'})).status,405);
 const avatar=await fetchURL(`${issued.url.split('?')[0]}/avatar?${issued.url.split('?')[1]}`,{redirect:'manual'});assert.equal(avatar.headers.get('Location'),origin+'/branding/3sln-avatar.png');
 assert.equal((await fetchURL(issued.url+'&bindle_data=a.b.c',{headers:{Accept:'text/html'}})).status,400,'data is never evaluated by the HTML representation');
});

test('pure helpers escape every attribute and only canonical same-origin capability URLs are used',()=>{
 const page=injectPreview('<html><head><meta name="description" content="x"><title>t</title></head><body></body></html>',{brand:'B&"',origin,title:'<T>',description:'"D"',image:'https://i.example/a.png?x=1&y=2',imageSize:512,link:origin+'/u'});
 assert.match(page,/<title>&lt;T&gt;<\/title>/);assert.match(page,/content="&quot;D&quot;"/);assert.match(page,/x=1&amp;y=2/);assert.equal((page.match(/<meta name="description"/g)??[]).length,1);
 assert.equal(canonicalContactLink(origin,'https://evil.example/users/abc/contact/11111111-1111-4111-8111-111111111111?sig=a.b.c'),null);
 assert.equal(canonicalContactLink(origin,origin+'/users/abc/contact/11111111-1111-4111-8111-111111111111?sig=a.b.c&x=1'),null);
 assert.deepEqual(Object.keys(oembed({brand:'B',origin,title:'T',image:'i',imageSize:512})).sort(),['provider_name','provider_url','thumbnail_height','thumbnail_url','thumbnail_width','title','type','version']);
});

test('this provider declares contact intents and its intent login endpoint in the Bindle manifest',async()=>{
 const {default:application}=await import('../packages/runtime/http.mjs'),issuer='https://provider.example';
 const env={APP_ORIGIN:issuer,FEDERATION_ENABLED:'true',KEY_ENCRYPTION_KEY:'isolated-manifest-test',ABUSE:{consume:async()=>true},FEDERATION_AUTHORITY:{clients:[],ready:async()=>true,manifest:async()=>({version:'0',issuer,features:{'authorization-entry.v1':{endpoint:issuer+'/api/oauth/entries',intents:['login']}}})}};
 const response=await application.fetch(new Request(issuer+'/.well-known/bindle/manifest.json'),env);assert.equal(response.status,200);assert.equal(response.headers.get('Access-Control-Allow-Origin'),'*');
 const manifest=await response.json();assert.deepEqual(manifest.features['intents.v1'],{intents:['send-message','add-contact'],login_endpoint:issuer+'/console'});assert.ok(manifest.features['authorization-entry.v1'],'other features are preserved');assert.equal(manifest.intents_supported,undefined);assert.equal(manifest.issuer,issuer);
});

test('only the contact page widens connect-src, for credentialless manifest discovery',async()=>{
 const issued=await link(),{response}=await html(issued.url);assert.match(response.headers.get('Content-Security-Policy'),/connect-src 'self' https: http:\/\/localhost:\*/);
 const console=await fetchURL('/console');assert.equal(console.headers.get('Content-Security-Policy').includes("connect-src 'self' https: "),false);
});
