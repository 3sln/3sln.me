// Island runtime (embed-islands §3.4, §4; profile §3–§5). One shell per client; the fragment alone selects the part.
// Boot order: read config, fragment and window.name (then clear it); render the part's static UI; probe the
// sandbox; accept exactly one valid init from window.parent; post `ready`; only then start the worker (for
// `sign-in`, only on activation). Unknown parts, a missing nonce, a top-level load or a bad config leave the
// document inert: it sends nothing, so the element's handshake times out. After the handshake the island never
// posts to any window but its own popup; everything else uses the port.
import {reconcile} from '../../../vendor/dodo/index.js';
import {Engine,Provider,Action,Query} from '../../../vendor/ngin/index.js';
import {parseFragment,parseIslandName,validateInit,readyMessage,avatarBucket,PART_NAMES} from '../../../packages/sdk/src/islands-protocol.mjs';
import {createIslandLocalization} from '../../../packages/i18n/islands-catalogue.mjs';
import {createChannel} from './channel.mjs';
import {createArming} from './arming.mjs';
import {createTheme} from './theme.mjs';
import {createScriptURLPolicy,allowedScriptPath} from './trusted-types.mjs';
import {createWorkerClient} from './worker-client.mjs';
import {probeSandbox} from './sandbox.mjs';
import {createFlows} from './parts/flow.mjs';
import {avatarPart} from './parts/avatar.mjs';
import {accountSwitcherPart} from './parts/account-switcher.mjs';
import {signInPart} from './parts/sign-in.mjs';
import {requestPart} from './parts/request.mjs';

const origin=value=>{try{return new URL(value).origin===value&&value.startsWith('https://')?value:null;}catch{return null;}};
/** The non-executable per-client config block. Anything unexpected makes the island inert. */
export function readConfig(doc){
  const element=doc.getElementById('config');if(!element||element.getAttribute('type')!=='application/json')return null;
  let c;try{c=JSON.parse(element.textContent);}catch{return null;}
  if(!c||typeof c!=='object'||c.v!==1||!origin(c.issuer)||typeof c.clientId!=='string'||!c.clientId||c.clientId.length>2048)return null;
  if(!Array.isArray(c.origins)||!c.origins.length||c.origins.length>16||!c.origins.every(origin)||!Array.isArray(c.parts)||!c.parts.every(p=>PART_NAMES.includes(p))||!allowedScriptPath(c.worker)||c.sw!==undefined&&!allowedScriptPath(c.sw))return null;
  let manage=c.issuer+'/';if(c.manageUrl!==undefined){try{const url=new URL(c.manageUrl);if(url.origin!==c.issuer||url.hash||url.username)return null;manage=url.href;}catch{return null;}}
  // Optional FedCM-in-frame endpoints (adaptive §11.3), both on the issuer origin; absent means popup only.
  const issuerURL=value=>{try{const url=new URL(value);return url.origin===c.issuer&&!url.hash&&!url.username&&!url.password?url.href:null;}catch{return null;}};
  let fedcm=null;if(c.fedcm!==undefined){fedcm={configUrl:issuerURL(c.fedcm?.configUrl),assertUrl:issuerURL(c.fedcm?.assertUrl)};if(!fedcm.configUrl||!fedcm.assertUrl||Object.keys(c.fedcm).length!==2)return null;fedcm=Object.freeze(fedcm);}
  return Object.freeze({issuer:c.issuer,clientId:c.clientId,origins:Object.freeze([...c.origins]),parts:Object.freeze([...c.parts]),worker:c.worker,sw:c.sw,manage,fedcm});
}

export function bootIsland({win=globalThis.window,doc=globalThis.document}={}){
  const config=readConfig(doc),fragment=parseFragment(win.location.hash);
  const name=win.name;try{win.name='';}catch{}
  const boot=parseIslandName(name);
  if(!config||!fragment||!config.parts.includes(fragment.part)||!boot||win.top===win)return null;
  const {part,version}=fragment,root=doc.getElementById(`${part}.v${version}`)??doc.getElementById(part);if(!root)return null;
  const html=doc.documentElement,host=new URL(config.issuer).host,embedOrigin=win.location.origin;
  let l10n=createIslandLocalization(boot.lang);
  // The avatar bucket depends only on the embedder-set frame size; switcher tiles have a fixed CSS size.
  const bucketFor=()=>part==='avatar'?avatarBucket(win.innerWidth,win.innerHeight,win.devicePixelRatio):avatarBucket(48,48,win.devicePixelRatio);
  const model={part,version,scheme:boot.colorScheme,props:{},tokens:{},subject:null,views:[],tiles:[],bucket:bucketFor(),
    prepare:null,flow:null,confirm:false,sandboxed:probeSandbox({doc,origin:win.origin}).sandboxed,armed:false,parentOrigin:null,live:false};
  const paint=()=>{html.lang=l10n.locale;html.dir=l10n.direction;html.dataset.part=part;html.dataset.scheme=model.scheme;html.dataset.armed=String(model.armed);html.style.colorScheme=model.scheme;};
  paint();
  const theme=createTheme(doc),policy=createScriptURLPolicy([config.worker,...config.sw?[config.sw]:[]],{tt:win.trustedTypes,origin:embedOrigin});
  const services={channel:null,client:null};
  let pendingClient=null,deferredForget=null,held=[];
  const worker=()=>pendingClient??=(async()=>{
    const instance=btoa(String.fromCharCode(...win.crypto.getRandomValues(new Uint8Array(16)))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
    const client=createWorkerClient(new win.Worker(policy.scriptURL(config.worker),{type:'module',name:'bindle-island'}));
    client.on(event=>{if(event.event==='views'){model.views=event.views;changed();}else if(event.event==='sessions')held=Array.isArray(event.tokens)?event.tokens.filter(token=>typeof token==='string'&&/^[\x21-\x7e]{1,512}$/.test(token)).slice(0,8):[];});
    await client.call('start',{config:{issuer:config.issuer,clientId:config.clientId,origin:embedOrigin},instance,role:['sign-in','request'].includes(part)?'none':'member',bucket:model.bucket,scheme:model.scheme,visible:doc.visibilityState!=='hidden'});
    if(deferredForget){await client.call('forget',deferredForget).catch(()=>{});deferredForget=null;}
    services.client=client;return client;
  })();
  // ngin engine: one model, one view query, actions for inbound state and forget.
  class IslandView extends Query{static deps=['model'];boot({model:m},{notify,engineFeed}){this.feed=engineFeed;this.on=()=>notify({...m});engineFeed.addEventListener('island-changed',this.on);this.on();}kill(){this.feed.removeEventListener('island-changed',this.on);}}
  class ApplyState extends Action{static deps=['model'];constructor(message){super();this.message=message;}async execute({model:m},{engineFeed}){applyState(m,this.message);engineFeed.dispatchEvent(new Event('island-changed'));}}
  // Sign-in and request controls touch no storage before activation, so forget waits for their worker.
  class Forget extends Action{static deps=['model'];constructor(message){super();this.message=message;}async execute(){const args=this.message.subject!==undefined?{subject:this.message.subject}:{};if(['sign-in','request'].includes(part)&&!pendingClient){deferredForget=!deferredForget||deferredForget.subject!==undefined&&deferredForget.subject===args.subject?args:{};return;}try{await(await worker()).call('forget',args);}catch{}}}
  const engine=new Engine({providers:{model:Provider.fromSingleton(model)}});
  const changed=()=>engine.feed.dispatchEvent(new Event('island-changed'));
  let ticket=0;
  /** Issued before a render request, so a slow stale response can never replace a newer picture. */
  const nextTicket=()=>++ticket;
  /** One off-screen decode per tile, then one swap in a single frame; failures keep the current picture. */
  async function swap(blobs,token){
    if(token!==ticket)return;const urls=blobs.map(blob=>win.URL.createObjectURL(blob)),drop=()=>{for(const url of urls)win.URL.revokeObjectURL(url);};
    try{await Promise.all(urls.map(url=>{const image=new win.Image();image.src=url;return image.decode();}));}catch{drop();return;}
    await new Promise(resolve=>win.requestAnimationFrame(resolve));if(token!==ticket){drop();return;}
    const old=model.tiles;model.tiles=urls;changed();win.setTimeout(()=>{for(const url of old)win.URL.revokeObjectURL(url);},0);
  }
  const send=message=>services.channel?.send(message)??false;
  const arming=createArming({win,doc,onChange:armed=>{model.armed=armed;paint();}});
  const openProvider=()=>{try{win.open(config.manage,'_blank','noopener,noreferrer');}catch{}};
  const startFlow=createFlows({model,send,worker,issuer:config.issuer,clientId:config.clientId,fedcm:config.fedcm,win,doc,refresh:changed});
  const context={model,issuer:config.issuer,enabled:part==='request'&&config.parts.includes('request'),t:(s,v)=>l10n.t(s,v),host,arming,worker,send,swap,nextTicket,startFlow,openProvider,refresh:changed,doc,win};
  const view=part==='avatar'?avatarPart(context):part==='sign-in'?signInPart(context):part==='request'?requestPart(context):accountSwitcherPart(context);
  function applyState(m,message){
    switch(message.type){
      case 'theme':if(message.seq>=(m.themeSeq??-1)){m.themeSeq=message.seq;m.tokenInput=message.tokens;m.tokens=theme.apply(message.tokens,m.scheme);}break;
      case 'props':if(message.props.seq>=(m.propsSeq??-1)){m.propsSeq=message.props.seq;const {seq,...props}=message.props;if(part==='request'&&m.props.kind!==props.kind){m.requestAbort?.abort();m.requestPrepare=null;}m.props=props;}break;
      case 'locale':l10n=createIslandLocalization(message.lang);paint();break;
      case 'scheme':m.scheme=message.colorScheme;m.tokens=theme.apply(m.tokenInput??{},m.scheme);paint();services.client?.notify('scheme',m.scheme);view.update();break;
      case 'session':if(part==='request'){view.apply(message);break;}m.subject=message.subject;view.update();break;
      case 'prepare-request':if(part==='request')view.apply(message);break;
      case 'prepare':{const {type,...inputs}=message;m.prepare=inputs;break;}
    }
  }
  view.engine?.feed.addEventListener('request-changed',changed);
  engine.query(new IslandView()).subscribe(()=>{reconcile(root,[view.view(model)]);});
  function onInit(event){
    if(event.source!==win.parent||!config.origins.includes(event.origin)||event.ports?.length!==1)return;
    const init=validateInit(event.data,{part,version,nonce:boot.nonce});if(!init)return;
    win.removeEventListener('message',onInit);
    model.parentOrigin=event.origin;
    applyState(model,{type:'scheme',colorScheme:init.colorScheme});applyState(model,{type:'locale',lang:init.locale});
    applyState(model,{type:'theme',...init.theme});applyState(model,{type:'props',props:init.props});
    services.channel=createChannel(event.ports[0],{part,version,issuer:config.issuer,origins:config.origins,onState:message=>engine.dispatch(new ApplyState(message)),onForget:message=>engine.dispatch(new Forget(message))});
    // `ready` precedes any storage access, leader election or credentialed request, and is identical in every state.
    services.channel.send(readyMessage({part,version,issuer:config.issuer}));model.live=true;changed();
    if(!['sign-in','request'].includes(part)){view.start();registerServiceWorker();}
  }
  function registerServiceWorker(){if(!config.sw||!win.navigator.serviceWorker)return;try{win.navigator.serviceWorker.register(policy.scriptURL(config.sw),{scope:'/embed'}).catch(()=>{});}catch{}}
  win.addEventListener('message',onInit);
  win.addEventListener('resize',()=>{const bucket=bucketFor();if(bucket!==model.bucket){model.bucket=bucket;services.client?.notify('bucket',bucket);view.update();}});
  doc.addEventListener('visibilitychange',()=>services.client?.notify('visible',doc.visibilityState!=='hidden'));
  // Same teardown in every state (EIR-4). The leader's embed sessions are ended from here with keepalive, because the
  // worker is often terminated before it reads `pagehide`; followers hold none. Bearer only (server: endSession).
  win.addEventListener('pagehide',()=>{
    for(const token of held.splice(0))win.fetch('/embed/api/session/end',{method:'POST',headers:{'X-Bindle-Embed':'1',Authorization:`BindleEmbedSession ${token}`},mode:'same-origin',credentials:'omit',cache:'no-store',referrerPolicy:'same-origin',keepalive:true}).catch(()=>{});
    services.client?.notify('pagehide');
  });
  win.addEventListener('pageshow',event=>{if(event.persisted)services.client?.notify('pageshow');});
  return Object.freeze({model,engine});
}
if(typeof document!=='undefined'&&document.currentScript===null&&document.getElementById('config'))bootIsland();
