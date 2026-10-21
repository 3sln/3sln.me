// IA-4 mounter. Separate from login's prepare/exchange loop: incremental flows never log the app in.
import {formatIslandName,islandURL,validateOutbound,LIMITS,validateThemeTokens} from '../islands-protocol.mjs';
import {localeFor,schemeFor} from './shared.mjs';
import {requestText} from './request-protocol.mjs';
export function mountRequestIsland({element,container,session,spec,prepare,onFlow,onCode,onState=()=>{}}){
 const win=element.ownerDocument.defaultView,{issuer,embedOrigin,version}=spec,client=session.client,clientId=client.clientIdFor(issuer);
 if(!clientId||!win.MessageChannel)return null;
 const nonce=btoa(String.fromCharCode(...win.crypto.getRandomValues(new Uint8Array(16)))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
 const lang=()=>{const l=localeFor(element);return /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/.test(l)&&l.length<=35?l:'en';};
 const scheme=()=>{const {theme}=schemeFor(element,session);return ['light','dark'].includes(theme)?theme:win.matchMedia?.('(prefers-color-scheme: dark)').matches?'dark':'light';};
 const props=()=>({kind:element.kind,label:element.kind==='configure'?'review-settings':'review-access',variant:element.getAttribute('island-variant')==='outline'?'outline':'filled'});
 const tokens=()=>{const style=win.getComputedStyle(element),input={};for(const key of spec.themeTokens){const value=style.getPropertyValue(`--bindle-${key}`).trim();if(value)input[key]=key==='radius'?Number(value):value;}return validateThemeTokens(input,{scheme:scheme()}).tokens;};
 const frame=element.ownerDocument.createElement('iframe');frame.src=islandURL(embedOrigin,clientId,'request',version);frame.name=formatIslandName({nonce,lang:lang(),colorScheme:scheme()});frame.title=requestText(lang())[element.kind==='configure'?'settings':'access'];frame.referrerPolicy='no-referrer';
 frame.setAttribute('allow',"identity-credentials-get 'none'; storage-access 'none'; browsing-topics 'none'; attribution-reporting 'none'; shared-storage 'none'; join-ad-interest-group 'none'; run-ad-auction 'none'; private-aggregation 'none'; sync-xhr 'none'");
 Object.assign(frame.style,{display:'block',border:'0',inlineSize:'100%',blockSize:'3.5em',colorScheme:scheme()});
 let live=false,dead=false,port=null,loads=0,flow=false,received=false,prepared=null,seq=0,calls=Promise.resolve(),violations=[],previous=null;
 const post=m=>{if(live&&!dead)port.postMessage(m);};
 const close=()=>{clearTimeout(timer);observer?.disconnect();port?.close();frame.remove();session.removeEventListener('bindle-session-change',changed);};
 const fail=(scope='part')=>{if(dead)return;const pending=flow;dead=true;live=false;close();client.capabilities?.degrade?.(issuer,scope==='profile'?'profile':'part:request');onState('fallback');if(pending)calls=calls.then(()=>onFlow('ended','unavailable'));};
 const bad=()=>{const now=Date.now();violations=violations.filter(at=>now-at<LIMITS.violationWindowMs);violations.push(now);if(violations.length>=LIMITS.violations)fail();};
 async function stage(){
  if(dead||!live||flow||prepared)return;
  const p=await prepare();if(dead||!live||flow||!p)return;prepared=p;post(p);
 }
 function changed(){const subject=session.session?.issuer===issuer?session.session.subject:null;post({v:1,type:'session',subject});}
 const handle={destroy(){if(dead)return;dead=true;close();},refresh(){if(dead||!live)return;const next={lang:lang(),scheme:scheme(),props:props(),tokens:tokens()};if(JSON.stringify(next)!==previous){previous=JSON.stringify(next);post({v:1,type:'locale',lang:next.lang});post({v:1,type:'scheme',colorScheme:next.scheme});post({v:1,type:'props',seq:++seq,...next.props});post({v:1,type:'theme',seq:++seq,tokens:next.tokens});frame.title=requestText(next.lang)[element.kind==='configure'?'settings':'access'];frame.style.colorScheme=next.scheme;}},stage};
 function message(event){
  if(dead)return;
  if(!live&&event.data?.type==='ready'&&typeof event.data.issuer==='string'&&event.data.issuer!==issuer&&validateOutbound(event.data,{part:'request',version,issuer:event.data.issuer}))return fail('profile');
  const m=!event.ports?.length&&validateOutbound(event.data,{part:'request',version,issuer});
  if(!m)return bad();
  if(!live){if(m.type!=='ready'||!m.protocol.includes(1))return fail();clearTimeout(timer);live=true;onState('live');changed();stage().catch(fail);return;}
  if(m.type==='flow'){
   if(m.phase==='started'){if(flow||!prepared)return bad();flow=true;received=false;calls=calls.then(()=>onFlow('started'));return;}
   if(!flow||m.outcome==='completed'&&prepared?.intent==='grant-more'&&!received)return bad();
   flow=false;prepared=null;calls=calls.then(()=>onFlow('ended',m.outcome));
   // Completion may mean decline; restaging is local-only and the engine can refuse it. No popup/retry here.
   calls.then(()=>stage()).catch(fail);return;
  }
  if(m.type==='code'){if(!flow||received||prepared?.intent!=='grant-more'||m.state!==prepared.state)return bad();received=true;calls=calls.then(()=>onCode(m));return;}
  bad();
 }
 let timer=win.setTimeout(fail,10000),observer=null;
 frame.addEventListener('load',()=>{
  if(dead)return;if(++loads>1)return fail();clearTimeout(timer);const channel=new win.MessageChannel();port=channel.port1;port.onmessage=message;
  try{frame.contentWindow.postMessage({v:1,type:'bindle-island-init',nonce,part:'request',version,theme:{seq:0,tokens:tokens()},locale:lang(),colorScheme:scheme(),props:{seq:0,...props()}},embedOrigin,[channel.port2]);}catch{return fail();}
  timer=win.setTimeout(fail,LIMITS.handshakeMs);
 });
 session.addEventListener('bindle-session-change',changed);container.append(frame);onState('mounting');
 if(win.MutationObserver){observer=new win.MutationObserver(fail);observer.observe(frame,{attributes:true,attributeFilter:['src','name','sandbox','credentialless','allow']});}
 return handle;
}
