// Islands channel protocol v1 (packages/sdk/src/islands-protocol.mjs): fragment-only part selection, name grammar,
// plain-data and size rules, exact inbound/outbound schemas per part, theme allowlist and contrast, monogram.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../packages/sdk/src/islands-protocol.mjs';

const issuer='https://provider.example',app='https://app.example',nonce='AAAAAAAAAAAAAAAAAAAAAA',b43='a'.repeat(43);
const init=(over={})=>({v:1,type:'bindle-island-init',nonce,part:'sign-in',version:1,theme:{seq:0,tokens:{}},locale:'en',colorScheme:'light',props:{seq:0},...over});
const inbound=(part,data)=>P.validateInbound(data,{part,issuer,origins:[app]});
const outbound=(part,data)=>P.validateOutbound(data,{part,version:1,issuer});

test('the fragment alone selects an allowlisted part and version',()=>{
  assert.deepEqual(P.parseFragment('#avatar'),{part:'avatar',version:1});
  assert.deepEqual(P.parseFragment('#sign-in.v1'),{part:'sign-in',version:1});
  assert.deepEqual(P.parseFragment('#account-switcher.v1'),{part:'account-switcher',version:1});
  for(const hash of ['','#','#avatar.v2','#avatar.v0','#Avatar','#publications','#avatar?x','#avatar.v1#x','#avatar&part=sign-in','#__proto__','#constructor','avatar','#sign-in.v01',`#${'a'.repeat(60)}`,null,undefined])assert.equal(P.parseFragment(hash),null,String(hash));
  assert.equal(P.islandURL('https://embed.provider.example','https://app.example/client','avatar'),'https://embed.provider.example/embed?client=https%3A%2F%2Fapp.example%2Fclient#avatar.v1');
});

test('window.name carries only nonce, locale and scheme in the exact grammar',()=>{
  assert.deepEqual(P.parseIslandName(`bindle-island;v=1;n=${nonce};l=es-MX;cs=dark`),{nonce,lang:'es-MX',colorScheme:'dark'});
  for(const name of ['',`bindle-island;v=2;n=${nonce};l=en;cs=dark`,`bindle-island;v=1;n=${nonce.slice(1)};l=en;cs=dark`,`bindle-island;v=1;n=${nonce};l=en;cs=dim`,`bindle-island;v=1;n=${nonce};l=e;cs=dark`,`x;bindle-island;v=1;n=${nonce};l=en;cs=dark`])assert.equal(P.parseIslandName(name),null);
  assert.throws(()=>P.formatIslandName({nonce:'short',lang:'en',colorScheme:'light'}));
});

test('only plain structured-clone data is accepted, within the size budget',()=>{
  const {port1}=new MessageChannel();
  for(const bad of [new Blob(['x']),new ArrayBuffer(2),new Uint8Array(2),port1,new Date(),new Map(),Object.create(null),new (class X{})(),{get x(){return 1;}},[1,,3],{a:{b:{c:{d:{e:{f:{g:{h:{i:{j:1}}}}}}}}}},NaN,()=>{},Symbol('s')])assert.equal(P.isPlainData(bad),false);
  port1.close();
  assert.equal(P.isPlainData({a:[1,'x',true,null,{b:2}]}),true);
  assert.equal(P.validateInit(init({props:{seq:0,label:'continue',pad:'x'.repeat(9000)}}),{part:'sign-in',version:1,nonce}),null);
  assert.equal(P.validateInbound({v:1,type:'locale',lang:'en',x:'y'.repeat(3000)},{part:'avatar',issuer}),null);
});

test('init: exact keys, constant-time nonce, part and version from the fragment',()=>{
  assert.deepEqual(P.validateInit(init(),{part:'sign-in',version:1,nonce}).props,{seq:0});
  for(const bad of [init({nonce:'BAAAAAAAAAAAAAAAAAAAAA'}),init({part:'avatar'}),init({version:2}),init({extra:1}),init({locale:'not a tag'}),init({colorScheme:'dim'}),init({theme:{seq:-1,tokens:{}}}),init({props:{seq:0,label:'Free text'}}),{...init(),v:2},(({props,...rest})=>rest)(init())])assert.equal(P.validateInit(bad,{part:'sign-in',version:1,nonce}),null);
  assert.equal(P.constantTimeEqual('abc','abc'),true);assert.equal(P.constantTimeEqual('abc','abd'),false);assert.equal(P.constantTimeEqual('abc','abcd'),false);
});

test('inbound messages are presentation inputs and public flow inputs only, per part',()=>{
  assert.deepEqual(inbound('avatar',{v:1,type:'session',subject:`${issuer}/entities/1`}),{type:'session',subject:`${issuer}/entities/1`});
  assert.deepEqual(inbound('avatar',{v:1,type:'session',subject:null}),{type:'session',subject:null});
  assert.equal(inbound('avatar',{v:1,type:'session',subject:'https://other.example/entities/1'}),null);
  assert.equal(inbound('avatar',{v:1,type:'session'}),null);
  const prepare={v:1,type:'prepare',redirectUri:`${app}/callback`,challenge:b43,state:b43,requests:[]};
  assert.equal(inbound('avatar',prepare),null,'avatar takes no flow inputs');
  assert.equal(inbound('sign-in',prepare).redirectUri,`${app}/callback`);
  assert.equal(inbound('sign-in',{...prepare,redirectUri:'https://evil.example/callback'}),null,'redirect origin must be an allowed parent');
  assert.equal(inbound('sign-in',{...prepare,intent:'consent'}),null,'the intent never comes from the app');
  assert.equal(inbound('sign-in',{...prepare,entry:b43}),null,'no entry identifiers from the app');
  assert.equal(inbound('sign-in',{...prepare,embedJkt:b43}),null,'no thumbprints from the app');
  assert.equal(inbound('account-switcher',{...prepare,loginHint:'x'.repeat(321)}),null);
  assert.equal(inbound('account-switcher',{v:1,type:'props',seq:1,density:'compact',actions:['manage','manage']}),null);
  assert.deepEqual(inbound('account-switcher',{v:1,type:'props',seq:1,density:'compact',actions:['remove']}).props,{seq:1,density:'compact',actions:['remove']});
  assert.equal(inbound('sign-in',{v:1,type:'props',seq:1,label:'Click here'}),null,'labels are catalogue keys only');
  assert.equal(inbound('avatar',{v:1,type:'props',seq:1,label:'continue'}),null);
  assert.deepEqual(inbound('avatar',{v:1,type:'forget'}),{type:'forget'});
  assert.equal(inbound('avatar',{v:1,type:'forget',subject:null}),null);
  for(const type of ['select','open','navigate','focus','start','code','ready','flow'])assert.equal(inbound('account-switcher',{v:1,type}),null,type);
  assert.equal(inbound('avatar',{v:1,type:'theme',seq:1,tokens:Object.fromEntries(Array.from({length:17},(_,i)=>[`t${i}`,'#000000']))}),null);
});

test('outbound messages follow the per-part events contract; #avatar emits only ready',()=>{
  const ready=P.readyMessage({part:'avatar',version:1,issuer});
  assert.deepEqual({...ready,protocol:[...ready.protocol]},{v:1,type:'ready',part:'avatar',version:1,protocol:[1],issuer});
  assert.ok(outbound('avatar',ready));
  for(const message of [{v:1,type:'flow',phase:'started'},{v:1,type:'select',subject:`${issuer}/entities/1`},{v:1,type:'escape'},{v:1,type:'dismiss'},{v:1,type:'code',code:'c',state:b43,iss:issuer}])assert.equal(outbound('avatar',message),null,message.type);
  assert.equal(outbound('sign-in',{v:1,type:'select',subject:`${issuer}/entities/1`}),null);
  assert.ok(outbound('account-switcher',{v:1,type:'select',subject:`${issuer}/entities/1`}));
  assert.equal(outbound('sign-in',{v:1,type:'code',code:'c',state:b43,iss:'https://evil.example'}),null);
  assert.equal(outbound('sign-in',{v:1,type:'flow',phase:'ended'}),null);
  assert.equal(outbound('sign-in',{v:1,type:'flow',phase:'ended',outcome:'storage-blocked'}),null,'outcomes are generic');
  assert.equal(outbound('sign-in',{v:1,type:'flow',phase:'started',outcome:'completed'}),null);
  assert.equal(outbound('account-switcher',{v:1,type:'escape',rows:3}),null,'no extra fields can carry state');
  assert.equal(outbound('sign-in',{...P.readyMessage({part:'sign-in',version:1,issuer}),issuer:'https://other.example'}),null);
});

test('theme tokens: allowlist, grammar and the full contrast matrix; a failing pair reverts both',()=>{
  for(const scheme of ['light','dark'])for(const [fore,back,min] of P.CONTRAST_PAIRS)assert.ok(P.contrastRatio(P.THEME_DEFAULTS[scheme][fore],P.THEME_DEFAULTS[scheme][back])>=min,`${scheme} ${fore}/${back}`);
  assert.equal(P.CONTRAST_PAIRS.length,13);
  assert.deepEqual(P.validateThemeTokens({accent:'#1d4ed8',radius:12}).tokens,{accent:'#1d4ed8',radius:12});
  const {tokens,rejected}=P.validateThemeTokens({font:'serif','font-scale':'2',density:'compact','color-scheme':'dark',accent:'#ABCDEF',radius:17,surface:'red'});
  assert.deepEqual(tokens,{});assert.deepEqual([...rejected].sort(),['accent','color-scheme','density','font','font-scale','radius','surface'].sort());
  const faint=P.validateThemeTokens({danger:'#fefefe'},{scheme:'light'});assert.equal(faint.tokens.danger,undefined,'an invisible Remove is refused');
  const pair=P.validateThemeTokens({'text-muted':'#777777','surface-raised':'#888888'});assert.deepEqual(pair.tokens,{});
  assert.deepEqual(P.validateThemeTokens(Object.fromEntries(Array.from({length:17},(_,i)=>[`x${i}`,1]))).tokens,{});
});

test('monogram follows Appendix A: 15 pattern bits, colour index b mod 24, ≥4.5:1 in both schemes',()=>{
  const subject='https://provider.example/entities/0c0ffee0-0000-4000-8000-000000000000',p=P.monogramPattern(subject);
  assert.equal(p.cells.length,25);for(let r=0;r<5;r++)for(let c=0;c<5;c++)assert.equal(p.cells[r*5+c],p.cells[r*5+(4-c)]);
  assert.deepEqual(P.monogramPattern(subject),p);assert.equal(p.hue,p.index*15+7.5);assert.ok(p.index>=0&&p.index<24);
  assert.equal(P.monogramPattern(''),null);assert.equal(P.monogramPattern('x'.repeat(2049)),null);
  for(const scheme of ['light','dark'])for(let i=0;i<24;i++){const tone=scheme==='light'?[[0.93,0.03],[0.40,0.065]]:[[0.36,0.06],[0.93,0.03]];assert.ok(P.contrastRatio(P.oklchToHex(...tone[0],i*15+7.5),P.oklchToHex(...tone[1],i*15+7.5))>=4.5,`${scheme} ${i}`);}
  assert.match(P.monogramColors(subject,'dark').background,/^#[0-9a-f]{6}$/);
});

test('avatar buckets depend only on the embedder-set box and device pixel ratio',()=>{
  assert.equal(P.avatarBucket(40,40,1),64);assert.equal(P.avatarBucket(40,40,2),128);assert.equal(P.avatarBucket(300,120,2),256);assert.equal(P.avatarBucket(512,512,3),512);assert.equal(P.avatarBucket(16,16,NaN),64);
});
