import { Provider } from '../shared/stack.mjs';
import { decode64,decodeOptions,serializeCredential } from '../bl/browser-codecs.mjs';
export function isTextInputTarget(node){return !!node?.closest?.('input:not([type=checkbox]):not([type=button]):not([type=submit]),textarea,select,[contenteditable]:not([contenteditable=false])');}
export default class BrowserProvider extends Provider {
  #resource;
  constructor(){super();this.#resource=createBrowser();}
  async obtain(){return this.#resource;}
  release(){}
  dispose(){this.#resource.dispose();}
}
function createBrowser(){
  const link=new URLSearchParams(location.hash.slice(1)),query=new URLSearchParams(location.search),signedEndpoint=query.has('sig')?location.pathname+location.search:null;
  // Capabilities are captured once, before rendering, and removed from history.
  const submissions=new Map();
  const secret={token:link.get('token'),owner:link.get('owner'),requestId:link.get('request'),userCode:link.get('code'),pending:null,recovery:null,deviceCode:null,contactEndpoint:signedEndpoint,encryptedRecovery:null,restoreFile:null};
  if(query.has('sig'))query.delete('sig');if(signedEndpoint||[...link.keys()].some(key=>['token','owner','request','code'].includes(key)))history.replaceState(null,'',location.pathname+(query.size?'?'+query:''));
  let returnFocus,returnFocusText,captchaToken='',disposed=false,captchaAction='signup',observer=null,captchaConfig={};
  const cleanups=[];
  const path=location.pathname,purpose=new URLSearchParams(location.search).get('purpose');
  const route={auth:new URLSearchParams(location.search).has('signin')?'login':undefined,kind:/^\/users\/[^/]+\/contact\/[a-f0-9-]{36}$/.test(path)?'contact':path==='/unsubscribe'?'unsubscribe':['/email/confirm','/email/login'].includes(path)?'email':['/device','/device/approve'].includes(path)?'device':path==='/recovery/setup'?'recovery-setup':path==='/recovery/restore'?'recovery-restore':'home',recipient:path.split('/')[2],emailLogin:path==='/email/login'||purpose==='login',requestId:secret.requestId,userCode:secret.userCode};
  try{const pending=JSON.parse(sessionStorage.getItem('3sln-setup'));if(pending?.token&&typeof pending.token==='string'){secret.pending=pending.token;route.pendingStage=pending.stage;}}catch{}
  const resource={
    applyLocale(locale){document.documentElement.lang=locale;},
    applyBrand(brand){document.title=`${brand.name} · Your personal space`;},
    language:()=>navigator.language,platform:()=>navigator.platform,
    preferences(){try{const text=localStorage.getItem('personal-space-preferences');const value=text&&text.length<=32768?JSON.parse(text):{};return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}},
    savePreferences(value){localStorage.setItem('personal-space-preferences',JSON.stringify({locale:value.locale,keybindingOverrides:value.keybindingOverrides??[]}));document.documentElement.lang=value.locale;},
    inputFocused:()=>isTextInputTarget(document.activeElement?.shadowRoot?.activeElement??document.activeElement),
    onFocus(listener){const callback=()=>listener();document.addEventListener('focusin',callback);document.addEventListener('focusout',callback);const cancel=()=>{document.removeEventListener('focusin',callback);document.removeEventListener('focusout',callback);};cleanups.push(cancel);return cancel;},
    captureSubmission(form){const id=crypto.randomUUID(),values=Object.fromEntries(new FormData(form));submissions.set(id,values);for(const input of form.querySelectorAll('input'))if(input.type==='password'||/^(answer|verify|unlock):/.test(input.name))input.value='';setTimeout(()=>submissions.delete(id),90000);return id;},
    consumeSubmission(id){const values=submissions.get(id);submissions.delete(id);if(!values)throw new Error('This form submission expired. Enter your information again.');return values;},
    storeRecoveryChallenge(token){sessionStorage.setItem('personal-space-recovery-challenge',JSON.stringify({token,createdAt:Date.now()}));},
    recoveryChallenge(config){if(config.localDevelopment)return 'local-browser-test-token';let value;try{value=JSON.parse(sessionStorage.getItem('personal-space-recovery-challenge'));}catch{}if(!value?.token||typeof value.token!=='string'||value.token.length>4096||!Number.isFinite(value.createdAt)||Date.now()-value.createdAt>240000)throw new Error('The recovery security check expired. Return to sign in and complete it again; your typed answers will be cleared.');return value.token;},
    clearRecoveryChallenge(){sessionStorage.removeItem('personal-space-recovery-challenge');},
    now:()=>Date.now(),id:()=>crypto.randomUUID(),
    async fingerprintMessage(values){const bytes=values.file?.size?new Uint8Array(await values.file.arrayBuffer()):new TextEncoder().encode(values.text??'');const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');return JSON.stringify({collection:values.collection,mimeType:values.mimeType,subject:values.subject,tags:values.tags,hash});},
    route:()=>({...route}),online:()=>navigator.onLine,secret:name=>secret[name],
    storeSecret:(name,value)=>{secret[name]=value;},
    restorePending:()=>secret.pending?{stage:route.pendingStage}:null,
    savePending:(token,stage)=>{secret.pending=token;try{sessionStorage.setItem('3sln-setup',JSON.stringify({token,stage}));}catch{}},
    clearPending:()=>{secret.pending=null;secret.recovery=null;secret.encryptedRecovery=null;secret.restoreFile=null;try{sessionStorage.removeItem('3sln-setup');}catch{}},
    captcha:config=>({turnstileToken:config.localDevelopment?'local-browser-test-token':captchaToken}),
    setCaptchaAction(action){if(captchaAction===action)return;captchaAction=action;captchaToken='';for(const node of document.querySelectorAll('.cf-turnstile')){if(node.dataset.widgetId&&window.turnstile)window.turnstile.remove(node.dataset.widgetId);delete node.dataset.mounted;delete node.dataset.widgetId;}resource.mountCaptcha();},
    async createPasskey(options){if(!navigator.credentials?.create)throw new Error('This browser does not support passkeys. Choose a password to continue.');try{return serializeCredential(await navigator.credentials.create({publicKey:decodeOptions(options)}));}catch(error){if(error.name==='InvalidStateError')throw new Error('This authenticator already has a passkey. Choose another device or security key.');throw error;}},
    async authenticatePasskey(options){if(!navigator.credentials?.get)throw new Error('Passkeys are unsupported in this browser.');return serializeCredential(await navigator.credentials.get({publicKey:decodeOptions(options)}));},
    download(name,content,type='application/json'){const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);},
    copy:text=>navigator.clipboard.writeText(text),
    navigate:url=>location.assign(url),
    pushPermission:()=>typeof Notification==='undefined'?'unsupported':Notification.permission,
    async subscribePush(key){if(!key)throw new Error('Push delivery is not configured on this service.');if(!('serviceWorker'in navigator)||typeof Notification==='undefined')throw new Error('Push is unsupported in this browser.');if(await Notification.requestPermission()!=='granted')throw new Error('Allow browser notifications to enable push.');const registration=await navigator.serviceWorker.ready;return (await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:decode64(key)})).toJSON();},
    captureFocus(){returnFocus=document.activeElement;returnFocusText=returnFocus?.textContent;},
    modalFocus(){setTimeout(()=>document.querySelector('.modal input,.modal button')?.focus(),50);},
    restoreFocus(){requestAnimationFrame(()=>requestAnimationFrame(()=>{const target=returnFocus?.isConnected&&returnFocus.textContent===returnFocusText&&returnFocus.getClientRects().length?returnFocus:[...document.querySelectorAll('button')].find(node=>node.textContent===returnFocusText&&node.getClientRects().length);target?.focus();}));},
    installCaptcha(config){if(!config.turnstileSiteKey||config.localDevelopment||route.kind!=='home')return;if(document.querySelector('[data-captcha-script]'))return;const script=document.createElement('script');script.dataset.captchaScript='true';script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';script.async=true;script.onload=()=>resource.mountCaptcha(config);document.head.append(script);captchaConfig=config;observer=new MutationObserver(()=>resource.mountCaptcha(config));observer.observe(document.getElementById('app'),{childList:true,subtree:true});},
    mountCaptcha(config=captchaConfig){if(!window.turnstile||disposed)return;for(const node of document.querySelectorAll('.cf-turnstile'))if(!node.dataset.mounted){node.dataset.mounted='true';try{node.dataset.widgetId=window.turnstile.render(node,{sitekey:config.turnstileSiteKey,action:captchaAction,callback:token=>{captchaToken=token;},'expired-callback':()=>{captchaToken='';}});}catch{node.dataset.mounted='';}}},
    onNetwork(listener){const online=()=>listener(true),offline=()=>listener(false);window.addEventListener('online',online);window.addEventListener('offline',offline);const cancel=()=>{window.removeEventListener('online',online);window.removeEventListener('offline',offline);};cleanups.push(cancel);return cancel;},
    delay(callback,ms){const timer=setTimeout(callback,ms);const cancel=()=>clearTimeout(timer);cleanups.push(cancel);return cancel;},
    installWorker(){if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});},
    dispose(){disposed=true;submissions.clear();observer?.disconnect();for(const cleanup of cleanups)cleanup();for(const name of Object.keys(secret))secret[name]=null;captchaToken='';}
  };return Object.freeze(resource);
}
