import {normalizeMessageForm,messageFormFingerprint} from '../../../../packages/messaging/form-policy.mjs';
// This controller runs only in an opaque sandbox. No message markup is parsed
// in the account document; all proposals require separate parent-side review.
export async function frameController(normalizeMessageForm,messageFormFingerprint) {
 const attribute=(node,name)=>Element.prototype.getAttribute.call(node,name),query=(node,selector)=>Element.prototype.querySelectorAll.call(node,selector),bind=(node,type,listener)=>EventTarget.prototype.addEventListener.call(node,type,listener);
 const namespace=node=>Object.getOwnPropertyDescriptor(Element.prototype,'namespaceURI').get.call(node),attributesOf=node=>Object.getOwnPropertyDescriptor(Element.prototype,'attributes').get.call(node),remove=(node,name)=>Element.prototype.removeAttribute.call(node,name);
 const tags=['a','p','div','span','br','hr','b','strong','em','i','u','s','ul','ol','li','pre','code','blockquote','h1','h2','h3','h4','h5','h6','table','thead','tbody','tfoot','tr','td','th','style','form','label','input','textarea','select','option','optgroup','button','fieldset','legend'];
 const attributes=['class','href','target','rel','title','action','method','enctype','name','value','type','form','required','minlength','maxlength','min','max','step','checked','selected','disabled','multiple','rows','cols','placeholder','for','formaction','formmethod','formenctype','style'];
 const bridgeNonce=document.querySelector('meta[name=bindle-frame-nonce]')?.content,providerOrigin=new URL(import.meta.url).origin;
 let initialized=false;
 addEventListener('message',async event=>{
  if(initialized||event.source!==parent||event.origin!==providerOrigin||!bridgeNonce||event.data?.nonce!==bridgeNonce||event.data?.kind!=='bindle-message-init'||event.ports.length!==1)return;
  initialized=true;const port=event.ports[0],config=event.data,host=document.querySelector('#message'),root=host.attachShadow({mode:'closed'});
  let motionStopped=false,motionTimer,motionCutoff=Number.isFinite(config.motionDeadline)?Math.min(config.motionDeadline,Date.now()+5000):Date.now()+5000;const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');const motionProperty=name=>/^(?:-[a-z]+-)?(?:animation|transition)(?:-|$)/.test(name)||name==='scroll-behavior';
  const stripDeclaration=style=>{for(const name of Array.from(style))if(motionProperty(name))style.removeProperty(name);};
  const stripRules=sheet=>{for(let index=sheet.cssRules.length-1;index>=0;index--){const rule=sheet.cssRules[index];if(rule.type===7||rule.type===3){sheet.deleteRule(index);continue;}if(rule.style)stripDeclaration(rule.style);if(rule.cssRules)stripRules(rule);}};
  const stopMotion=()=>{motionStopped=true;clearTimeout(motionTimer);try{for(const animation of (typeof root.getAnimations==='function'?root.getAnimations():[])){try{const timing=animation.effect?.getComputedTiming();if(Number.isFinite(timing?.endTime)&&animation.playbackRate!==0)animation.finish();animation.commitStyles?.();}catch{}finally{animation.cancel();}}}catch{/* CSS stripping below remains the permanent static fallback. */}
   for(const style of root.querySelectorAll('style'))try{if(!style.sheet)throw Error('Uninspectable stylesheet');stripRules(style.sheet);}catch{Element.prototype.remove.call(style);}
   for(const node of root.querySelectorAll('[style]'))try{const style=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'style').get.call(node);stripDeclaration(style);}catch{remove(node,'style');}
   try{for(const animation of (typeof root.getAnimations==='function'?root.getAnimations():[]))animation.cancel();}catch{}
  };
  const setMotion=(enabled,deadline)=>{motionCutoff=Math.min(motionCutoff,Number.isFinite(deadline)?deadline:Date.now());clearTimeout(motionTimer);if(motionStopped||enabled!==true||reducedMotion.matches||document.hidden||motionCutoff<=Date.now()){stopMotion();return;}motionTimer=setTimeout(stopMotion,Math.max(0,motionCutoff-Date.now()));};
  reducedMotion.addEventListener('change',()=>{if(reducedMotion.matches)stopMotion();});addEventListener('pagehide',stopMotion);addEventListener('pageshow',()=>{if(Date.now()>=motionCutoff)stopMotion();});document.addEventListener('visibilitychange',()=>{if(document.hidden||Date.now()>=motionCutoff)stopMotion();});
  port.onmessage=event=>{if(event.data?.kind==='motion')setMotion(event.data.enabled,event.data.deadline);};

  try{
   if(typeof config.source!=='string'||new TextEncoder().encode(config.source).length>1048576)throw Error('Message too large');
   const template=document.createElement('template');
   if(typeof template.setHTML==='function'&&!config.forceFallback)template.setHTML(config.source,{sanitizer:{elements:tags,attributes}});
   else{const module=await import(config.sanitizerURL),purify=module.default;if(!purify?.isSupported)throw Error('Sanitizer unavailable');template.content.append(purify.sanitize(config.source,{ALLOWED_TAGS:tags,ALLOWED_ATTR:attributes,ALLOWED_NAMESPACES:['http://www.w3.org/1999/xhtml'],NAMESPACE:'http://www.w3.org/1999/xhtml',RETURN_DOM_FRAGMENT:true,SANITIZE_DOM:true,SANITIZE_NAMED_PROPS:false}));}
   const fragment=template.content;if(!fragment.childNodes.length&&config.source.trim())throw Error('Unsupported message content');for(const node of fragment.querySelectorAll('*'))if(namespace(node)!=='http://www.w3.org/1999/xhtml')Element.prototype.remove.call(node);const forms=[...fragment.querySelectorAll('form')];if(forms.length>16)throw Error('Too many forms');
   const definitions=[];
   for(const [linkId,link]of [...fragment.querySelectorAll('a')].entries()){let url;try{url=new URL(link.getAttribute('href')??'',config.sourceOrigin);if(url.protocol!=='https:'||url.username||url.password||url.href.length>2048)url=null;}catch{url=null;}link.removeAttribute('href');link.setAttribute('target','_blank');link.setAttribute('rel','noopener noreferrer');if(url)link.addEventListener('click',event=>{event.preventDefault();if(event.isTrusted)port.postMessage({kind:'link',linkId,url:url.href});});else link.setAttribute('aria-disabled','true');}
   for(const form of forms){
    let compiled=null,formDigest=null;try{
     const raw={action:attribute(form,'action')??'',method:attribute(form,'method')??'get',enctype:attribute(form,'enctype')??'application/x-www-form-urlencoded',target:attribute(form,'target'),controls:[...query(form,'input,textarea,select,button')].map(input=>({tag:input.tagName.toLowerCase(),type:input.getAttribute('type')??undefined,name:input.getAttribute('name')??'',value:input.getAttribute('value')??(input.tagName==='TEXTAREA'?input.value:undefined),disabled:input.matches(':disabled'),multiple:input.multiple,externalAssociation:input.hasAttribute('form'),overrides:['formaction','formmethod','formenctype','formtarget'].some(name=>input.hasAttribute(name)),...input.tagName==='SELECT'?{options:[...input.options].map(option=>({value:option.value,disabled:option.disabled||!!option.closest('optgroup[disabled]')}))}:{}}))};
     compiled=normalizeMessageForm(raw,config.sourceOrigin);const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(messageFormFingerprint(compiled)));formDigest=btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
    }catch{/* unsupported author forms remain inert */}
    if(config.allowForms===false||compiled?.disposition==='new-tab')compiled=null;const formId=definitions.length,buttons=[...query(form,'button,input[type=submit]')];
    bind(form,'submit',event=>event.preventDefault());
    for(const [buttonId,button]of buttons.entries()){const type=(button.getAttribute('type')??'submit').toLowerCase();if(type!=='submit')continue;button.type='button';if(!compiled){button.disabled=true;continue;}const buttonName=button.getAttribute('name'),buttonValue=button.getAttribute('value')??'';button.addEventListener('click',event=>{event.preventDefault();if(!event.isTrusted||!HTMLFormElement.prototype.checkValidity.call(form))return;const fields=[];for(const [name,value]of new FormData(form)){if(typeof value!=='string'||value.length>4096||fields.length>=64)return;fields.push([name,value]);}if(buttonName){if(buttonName.length>100||buttonValue.length>4096)return;fields.push([buttonName,buttonValue]);}if(fields.length>64||new TextEncoder().encode(JSON.stringify(fields)).length>16384)return;port.postMessage({kind:'proposal',formId,buttonId,formDigest,...compiled,fields});});}
    definitions.push(form);
   }
   for(const node of fragment.querySelectorAll('*'))for(const attr of [...attributesOf(node)])if(!attributes.includes(attr.name)||['href','action','method','enctype','formaction','formmethod','formenctype','for','id','form'].includes(attr.name))remove(node,attr.name);
   const baseline=document.createElement('style');baseline.textContent=':host{display:block;min-width:0;font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}input,textarea,select,button{font:inherit}';root.append(baseline,fragment);setMotion(config.motionEnabled!==false,config.motionDeadline??Date.now()+5000);port.postMessage({kind:'ready',forms:forms.length});
  }catch{root.textContent=config.failureText??'This message could not be displayed safely.';port.postMessage({kind:'unavailable'});}
 });
 parent.postMessage({kind:'bindle-message-ready',nonce:bridgeNonce},'*');
}

export function mountMessageFrame(frame,{source,sourceOrigin,sanitizerURL,controllerURL,failureText,onProposal,onLink,forceFallback=false,allowForms=true,motionEnabled=true,motionDeadline=Date.now()+5000}) {
 const trustedSanitizer=new URL(sanitizerURL,location.origin);if(trustedSanitizer.origin!==location.origin||!/^\/assets\/scripts\/message-sanitizer\.[a-f0-9]{10}\.js$/.test(trustedSanitizer.pathname)||trustedSanitizer.search||trustedSanitizer.hash)throw Error('Invalid sanitizer asset');
 const controller=new URL(controllerURL,location.origin);if(controller.origin!==location.origin||!/^\/assets\/scripts\/message-frame-controller\.[a-f0-9]{10}\.js$/.test(controller.pathname)||controller.search||controller.hash)throw Error('Invalid renderer asset');
 const ownerWindow=frame.ownerDocument.defaultView,channel=new MessageChannel(),nonce=Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,'0')).join('');let disposed=false;
 const csp=`default-src 'none'; script-src ${controller.href} ${trustedSanitizer.href}; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; media-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
 frame.setAttribute('sandbox','allow-scripts');frame.referrerPolicy='no-referrer';
 channel.port1.onmessage=event=>{if(disposed)return;if(event.data?.kind==='proposal')onProposal(event.data);else if(event.data?.kind==='link')onLink?.(event.data);};
 const initialize=event=>{if(disposed||event.source!==frame.contentWindow||event.origin!=='null'||event.data?.kind!=='bindle-message-ready'||event.data?.nonce!==nonce)return;ownerWindow.removeEventListener('message',initialize);frame.contentWindow.postMessage({kind:'bindle-message-init',nonce,source,sourceOrigin,sanitizerURL:trustedSanitizer.href,failureText,forceFallback,allowForms,motionEnabled,motionDeadline},'*',[channel.port2]);};
 ownerWindow.addEventListener('message',initialize);
 frame.srcdoc=`<!doctype html><meta charset="utf-8"><meta name="bindle-frame-nonce" content="${nonce}"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><div id="message"></div><script type="module" crossorigin="anonymous" src="${controller.href}"></script>`;
 const dispose=()=>{disposed=true;ownerWindow.removeEventListener('message',initialize);channel.port1.close();channel.port2.close();frame.removeAttribute('srcdoc');};dispose.setMotion=(enabled,deadline)=>{if(!disposed)channel.port1.postMessage({kind:'motion',enabled,deadline});};return dispose;
}

export function validateFormProposal(value,sourceOrigin) {
 if(!value||value.kind!=='proposal'||!Number.isSafeInteger(value.formId)||value.formId<0||value.formId>=16||!Number.isSafeInteger(value.buttonId)||value.buttonId<0||value.buttonId>=64||typeof value.formDigest!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.formDigest)||value.method!=='POST'||value.disposition!=='message'||value.enctype!=='application/x-www-form-urlencoded'||!Array.isArray(value.fields)||value.fields.length>64)throw Error('Invalid message form');
 const url=new URL(value.url);if(url.origin!==sourceOrigin||url.protocol!=='https:'||url.username||url.password||url.hash||url.href.length>2048||!url.hostname.includes('.')||url.hostname.endsWith('.local')||url.hostname==='localhost'||/^\d+(\.\d+){3}$/.test(url.hostname)||url.hostname.includes(':'))throw Error('Invalid message destination');
 const fields=value.fields.map(pair=>{if(!Array.isArray(pair)||pair.length!==2||pair.some(v=>typeof v!=='string')||!pair[0]||pair[0].length>100||/[\x00-\x1f\x7f]/.test(pair[0])||pair[1].length>4096)throw Error('Invalid message fields');return [pair[0],pair[1]];});if(new TextEncoder().encode(JSON.stringify(fields)).length>16384)throw Error('Message fields too large');
 return {formId:value.formId,buttonId:value.buttonId,formDigest:value.formDigest,url:url.href,method:value.method,enctype:value.enctype,disposition:value.disposition,fields};
}
