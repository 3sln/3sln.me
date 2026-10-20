// Island document runtime (apps/embed): channel rules, the single Trusted Types policy, the sandbox probe, the
// popup bridge's origin/handle/entry checks, the island string catalogue, and static P8/CSP source checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {within} from './helpers/async.mjs';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createChannel} from '../apps/embed/src/channel.mjs';
import {createScriptURLPolicy,allowedScriptPath,POLICY_NAME} from '../apps/embed/src/trusted-types.mjs';
import {probeSandbox} from '../apps/embed/src/sandbox.mjs';
import {openPopup,runPopupFlow,validateHello,validateDone} from '../apps/embed/src/bridge.mjs';
import {readConfig} from '../apps/embed/src/boot.mjs';
import {islandCatalogues,signInLabels,createIslandLocalization} from '../packages/i18n/islands-catalogue.mjs';
import {readyMessage} from '../packages/sdk/src/islands-protocol.mjs';

const issuer='https://provider.example',app='https://app.example',b43='b'.repeat(43);
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
// Every test is bounded: a regression fails fast with a clear message instead of hanging the file (an open
// MessagePort or a polling interval keeps the process alive, so cleanup is also registered with t.after).
const T={timeout:10000};
// Waits on observed delivery rather than wall-clock ticks: under CPU load a MessageChannel delivery can take far
// longer than any fixed sleep. `until` re-checks after each delivered message / flushed task.
function signal(){
  const waiters=new Set();
  return {
    notify(){for(const poll of [...waiters])poll();},
    async until(check,what){
      let poll;
      try{await within(new Promise((resolve,reject)=>{
        poll=()=>{try{if(check())resolve();}catch(error){reject(error);}};
        waiters.add(poll);poll();
      }),what);}
      finally{waiters.delete(poll);}
    }
  };
}
function channelPair(t,part,options={}){
  const {port1,port2}=new MessageChannel(),states=[],forgets=[],received=[],seen=signal();const timers=new Set();let delivered=0,flushes=0;
  port1.onmessage=e=>{received.push(e.data);seen.notify();};
  // The island's port, observed: count each inbound delivery after the channel has handled it.
  const port={set onmessage(fn){port2.onmessage=fn?event=>{fn(event);delivered++;seen.notify();}:null;},get onmessage(){return port2.onmessage;},start:()=>port2.start(),close:()=>port2.close(),postMessage:m=>port2.postMessage(m)};
  const defer=fn=>{const timer=setTimeout(()=>{timers.delete(timer);fn();flushes++;seen.notify();},0);timers.add(timer);};
  const channel=createChannel(port,{part,version:1,issuer,origins:[app],onState:m=>states.push(m),onForget:m=>forgets.push(m),defer,...options});
  const close=()=>{port1.close();channel.close();for(const timer of timers)clearTimeout(timer);timers.clear();};t.after(close);
  return {element:port1,channel,states,forgets,received,close,until:seen.until,get delivered(){return delivered;},get flushes(){return flushes;}};
}

test('state messages are last-value-wins on the next task; forget is never rate-limited',T,async t=>{
  let flush;const c=channelPair(t,'account-switcher',{defer:fn=>{flush=fn;}});
  for(let seq=1;seq<=30;seq++)c.element.postMessage({v:1,type:'theme',seq,tokens:{}});
  c.element.postMessage({v:1,type:'session',subject:null});c.element.postMessage({v:1,type:'session',subject:`${issuer}/entities/2`});
  for(let i=0;i<15;i++)c.element.postMessage({v:1,type:'forget'});
  // Control the next-task boundary explicitly: delivery may span many host tasks.
  await c.until(()=>c.delivered===47&&flush,'all 47 inbound messages and the queued state flush');
  assert.deepEqual(c.states,[],'state is deferred until the next task');flush();
  assert.deepEqual(c.states.filter(m=>m.type==='theme').map(m=>m.seq),[30]);
  assert.deepEqual(c.states.filter(m=>m.type==='session').map(m=>m.subject),[`${issuer}/entities/2`]);
  assert.equal(c.forgets.length,15);assert.deepEqual(c.received,[],'no replies, ever');
});

test('three schema violations within a minute stop the island reading the port',T,async t=>{
  const c=channelPair(t,'avatar');
  for(const bad of [{v:1,type:'select',subject:'x'},{v:1,type:'prepare'},{v:2,type:'locale',lang:'en'}])c.element.postMessage(bad);
  await c.until(()=>c.delivered===3,'three schema violations');assert.equal(c.channel.closed,true);
  c.element.postMessage({v:1,type:'locale',lang:'es'});await tick();assert.equal(c.delivered,3,'a stopped island no longer reads the port');assert.deepEqual(c.states,[]);
});

test('the island can send only its part’s outbound types; #avatar only ready',T,async t=>{
  const c=channelPair(t,'avatar');
  assert.equal(c.channel.send(readyMessage({part:'avatar',version:1,issuer})),true);
  for(const message of [{v:1,type:'flow',phase:'started'},{v:1,type:'select',subject:`${issuer}/entities/1`},{v:1,type:'escape'},{v:1,type:'size',width:40},{v:1,type:'ready',part:'avatar',version:1,protocol:[1],issuer,leader:true}])assert.equal(c.channel.send(message),false);
  await c.until(()=>c.received.length>=1,'the avatar ready message');assert.deepEqual(c.received.map(m=>m.type),['ready']);
});

test('one narrow Trusted Types policy: createScriptURL only, exact same-origin allowlisted paths',T,()=>{
  const created=[];const tt={createPolicy:(name,rules)=>{created.push({name,rules:Object.keys(rules)});return {createScriptURL:value=>({trusted:rules.createScriptURL(value)})};}};
  const policy=createScriptURLPolicy(['/embed/assets/apps/embed/src/worker/index.mjs','/embed/sw.js','/elsewhere.js'],{tt,origin:'https://embed.provider.example'});
  assert.deepEqual(created,[{name:POLICY_NAME,rules:['createScriptURL']}]);
  assert.equal(policy.scriptURL('/embed/sw.js').trusted,'https://embed.provider.example/embed/sw.js');
  for(const bad of ['/elsewhere.js','https://evil.example/embed/sw.js','/embed/sw.js?x=1','/embed/sw.js#x','/embed/assets/apps/embed/src/../../../x.js','data:text/javascript,1','javascript:1'])assert.throws(()=>policy.scriptURL(bad),bad);
  assert.equal(allowedScriptPath('/embed/assets/a/../b.js'),false);
  assert.equal(createScriptURLPolicy(['/embed/sw.js'],{tt:undefined,origin:'https://embed.provider.example'}).scriptURL('/embed/sw.js'),'https://embed.provider.example/embed/sw.js');
});

test('sandbox detection degrades on an opaque origin or a document.domain SecurityError',T,()=>{
  assert.deepEqual(probeSandbox({origin:'null',doc:{}}),{sandboxed:true});
  const throwing={get domain(){return 'embed.provider.example';},set domain(_){throw Object.assign(new Error('x'),{name:'SecurityError'});}};
  assert.deepEqual(probeSandbox({origin:'https://embed.provider.example',doc:throwing}),{sandboxed:true});
  assert.deepEqual(probeSandbox({origin:'https://embed.provider.example',doc:{domain:'embed.provider.example'}}),{sandboxed:false});
});

// Close every popup and await its flow before teardown ends, including assertion failures.
function fakeWindow(t){
  const flows=[],listeners=new Set(),win={opened:[],addEventListener:(t,f)=>t==='message'&&listeners.add(f),removeEventListener:(t,f)=>listeners.delete(f),emit:event=>{for(const f of [...listeners])f(event);},get listening(){return listeners.size;}};
  win.open=(url,target,features)=>{const popup={closed:false,posted:[],url,target,features,location:{replace(u){popup.url=u;}},postMessage(data,origin){popup.posted.push({data,origin});},close(){popup.closed=true;}};win.opened.push(popup);return popup;};
  win.flow=options=>{const flow=runPopupFlow({win,timeoutMs:2000,pollMs:5,...options});flows.push(flow);return flow;};
  t?.after(async()=>{for(const popup of win.opened)popup.closed=true;await within(Promise.all(flows),'popup flows to stop during teardown');assert.equal(win.listening,0);});
  return win;
}
test('the popup is unnamed, opened in the activation, and a null or throwing window.open is unavailable',T,()=>{
  const win=fakeWindow(),popup=openPopup(win);assert.equal(popup.target,'_blank');assert.equal(popup.url,'about:blank');assert.ok(!/noopener/.test(popup.features));
  assert.equal(openPopup({open:()=>null}),null);assert.equal(openPopup({open:()=>{throw Object.assign(new Error('x'),{name:'InvalidAccessError'});}}),null);
});

test('the bridge answers only its own popup, from the issuer origin, for its own entry, and replies only to the issuer',T,async t=>{
  const win=fakeWindow(t),popup=openPopup(win),entry='e'.repeat(43),proofs=[];
  const prepare={redirectUri:`${app}/callback`,challenge:b43,state:b43,requests:[]};
  const flow=win.flow({popup,issuer,prepare,createEntry:async()=>entry,prove:async args=>{proofs.push(args);return 'proof.jws.sig';},pollMs:5});
  await tick();assert.equal(popup.url,`${issuer}/oauth/authorize?entry=${entry}`);
  const hello={v:1,type:'bindle-embed-hello',entry,challenge:'c'.repeat(22)},other={closed:false};
  win.emit({source:other,origin:issuer,data:hello});                                  // another window (e.g. an app-opened popup)
  win.emit({source:popup,origin:app,data:hello});                                     // wrong origin
  win.emit({source:popup,origin:issuer,data:{...hello,entry:'f'.repeat(43)}});        // another entry
  win.emit({source:popup,origin:issuer,data:{...hello,extra:1}});                     // inexact schema
  await tick();assert.equal(proofs.length,0);
  win.emit({source:popup,origin:issuer,data:hello});await tick();
  assert.equal(proofs.length,1);assert.deepEqual(popup.posted,[{data:{v:1,type:'bindle-embed-proof',proof:'proof.jws.sig'},origin:issuer}]);
  const done={v:1,type:'bindle-embed-done',entry,code:'code-1',state:b43,iss:issuer,claim:'k'.repeat(43)};
  win.emit({source:popup,origin:issuer,data:{...done,state:'s'.repeat(43)}});win.emit({source:popup,origin:issuer,data:{...done,iss:app}});
  win.emit({source:popup,origin:issuer,data:done});
  const result=await flow;assert.deepEqual(result,{outcome:'completed',code:'code-1',state:b43,iss:issuer,claim:'k'.repeat(43)});
  assert.deepEqual(popup.posted.at(-1),{data:{v:1,type:'bindle-embed-ack',entry},origin:issuer});
  assert.ok(popup.posted.every(p=>p.origin===issuer),'never targetOrigin *');assert.equal(win.listening,0);
  assert.equal(validateHello({...hello,challenge:'<x>'},entry),false);assert.equal(validateDone({...done,code:'a b'},{entry,state:b43,issuer}),false);
});

test('a closed popup or a failed entry ends the flow without completing',T,async t=>{
  const win=fakeWindow(t),prepare={redirectUri:`${app}/callback`,challenge:b43,state:b43,requests:[]};
  const p1=openPopup(win),closed=win.flow({popup:p1,issuer,prepare,createEntry:async()=>'e'.repeat(43),prove:async()=>'p',pollMs:5});p1.closed=true;
  assert.equal((await closed).outcome,'unavailable','closed before any hello: opener lost (plain mode), not a cancel');
  const p3=openPopup(win),after=win.flow({popup:p3,issuer,prepare,createEntry:async()=>'e'.repeat(43),prove:async()=>'p',pollMs:5});await tick();
  win.emit({source:p3,origin:issuer,data:{v:1,type:'bindle-embed-hello',entry:'e'.repeat(43),challenge:'c'.repeat(22)}});await tick();p3.closed=true;
  assert.equal((await after).outcome,'canceled');
  const p2=openPopup(win);assert.equal((await win.flow({popup:p2,issuer,prepare,createEntry:async()=>{throw new Error('429');},prove:async()=>'p',pollMs:5})).outcome,'unavailable');assert.equal(p2.closed,true);
});

test('the per-client config block is validated; anything unexpected is inert',T,()=>{
  const doc=json=>({getElementById:()=>({getAttribute:()=> 'application/json',textContent:JSON.stringify(json)})});
  const good={v:1,issuer,clientId:`${app}/client`,origins:[app],parts:['avatar','sign-in'],worker:'/embed/assets/apps/embed/src/worker/index.mjs',sw:'/embed/sw.js',manageUrl:`${issuer}/console/apps`};
  assert.equal(readConfig(doc(good)).manage,`${issuer}/console/apps`);
  for(const bad of [{...good,v:2},{...good,issuer:'http://provider.example'},{...good,origins:['*']},{...good,parts:['publications']},{...good,worker:'https://evil.example/w.js'},{...good,manageUrl:'https://evil.example/'},{...good,origins:[]}])assert.equal(readConfig(doc(bad)),null);
});

test('island catalogue: every key translated, labels are catalogue keys, Spanish resolves',T,()=>{
  assert.deepEqual(Object.keys(islandCatalogues.en['']).sort(),Object.keys(islandCatalogues.es['']).sort());
  for(const key of Object.values(signInLabels))assert.ok(Object.hasOwn(islandCatalogues.es[''],key));
  const l=createIslandLocalization('es-MX');assert.equal(l.locale,'es');assert.equal(l.t('Continue with {host}',{host:'provider.example'}),'Continuar con provider.example');
  assert.equal(createIslandLocalization('zz').locale,'en');
});

async function sources(dir){const out=[];for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())out.push(...await sources(path));else if(/\.(mjs|js|html|css)$/.test(entry.name))out.push({path,text:await readFile(path,'utf8')});}return out;}
test('no P8 behaviours and no HTML/script sinks anywhere in the island sources',T,async()=>{
  const files=await sources('apps/embed');assert.ok(files.length>10);
  const forbidden=[/\balert\s*\(/,/\bconfirm\s*\(/,/\bprompt\s*\(/,/\bprint\s*\(/,/requestStorageAccess/,/top\.location/,/parent\.postMessage/,/top\.postMessage/,/\.download\b/,/innerHTML|outerHTML|insertAdjacentHTML|document\.write/,/\beval\s*\(|new Function\b/,/h\(\s*['"](input|textarea|select|iframe|form)['"]/,/<(input|textarea|form|iframe)\b/i,/location\.hash\s*=/,/(?:^|[^.])location\.(assign|replace|reload)\s*\(/m,/postMessage\([^)]*['"]\*['"]/,/SharedWorker/,/localStorage|sessionStorage|document\.cookie/,/\.showModal\(|\.requestFullscreen\(/,/createPolicy\(['"](?!bindle-embed)/];
  for(const {path,text} of files)for(const pattern of forbidden)assert.equal(pattern.test(text.replace(/^\s*\/\/.*$/gm,'')),false,`${path} matches ${pattern}`);
  const shell=files.find(f=>f.path.endsWith('shell.html')).text;
  assert.equal((shell.match(/<script/g)??[]).length,2);assert.match(shell,/<script type="application\/json" id="config">\{\{CONFIG\}\}<\/script>/);assert.doesNotMatch(shell,/\sstyle=|\son[a-z]+=/i);
  assert.equal(files.filter(f=>/createPolicy\(/.test(f.text)).length,1,'exactly one Trusted Types policy');
});
