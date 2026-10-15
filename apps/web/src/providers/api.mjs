import { decode64 } from '../bl/browser-codecs.mjs';
import { Provider } from '../shared/stack.mjs';
export default class APIProvider extends Provider {
  #resource=createAPI({storage:(()=>{try{return globalThis.sessionStorage??null;}catch{return null;}})()});
  async obtain(){return this.#resource;}
  release(){}
  // Page teardown forgets memory only; the tab's stored selector survives reload.
  dispose(){this.#resource.clearContext({keepSelection:true});}
}
// Per-tab selection survives reload as a non-secret {owner,sessionContext}
// selector in sessionStorage; CSRF and session bearers never leave memory.
const selectionKey='3sln-account-selection';
function restoreSelection(storage){try{const value=JSON.parse(storage?.getItem(selectionKey)??'null');return value&&/^[0-9a-f-]{36}$/.test(value.owner)&&typeof value.sessionContext==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value.sessionContext)?value:null;}catch{return null;}}
function persistSelection(storage,owner,sessionContext){try{if(owner&&sessionContext)storage?.setItem(selectionKey,JSON.stringify({owner,sessionContext}));else storage?.removeItem(selectionKey);}catch{}}
export function createAPI({storage=null}={}){const restored=restoreSelection(storage);return {
  csrf:null,account:restored?.owner??null,sessionContext:restored?.sessionContext??null,contextGeneration:0,
  captureContext(){return {owner:this.account,sessionContext:this.sessionContext,csrfToken:this.csrf};},
  setContext(result){if(this.account===(result?.account?.id??null)&&this.sessionContext===(typeof result?.sessionContext==='string'?result.sessionContext:null)&&this.csrf===(result?.csrfToken??null))return;this.contextGeneration++;this.account=result?.account?.id??null;this.sessionContext=typeof result?.sessionContext==='string'?result.sessionContext:null;this.csrf=result?.csrfToken??null;persistSelection(storage,this.account,this.sessionContext);},
  clearContext({keepSelection=false}={}){this.contextGeneration++;this.account=null;this.sessionContext=null;this.csrf=null;if(!keepSelection)persistSelection(storage,null,null);},
  async get(path,options){return this.request(path,undefined,'GET',options);},
  async request(path,body,method='POST',{signal,dispatchToken,context}={}){
    const dispatch=dispatchToken!==undefined,generation=this.contextGeneration,binding=context===undefined?this.captureContext():context;
    if(dispatch&&(typeof dispatchToken!=='string'||dispatchToken.length>65536||!/^[A-Za-z0-9._-]+$/.test(dispatchToken)||!/^\/api\/messages\/[0-9a-f-]{36}\/postbacks$/.test(path)||method!=='POST'||JSON.stringify(body)!=='{}'))throw Error('Invalid message dispatch');
    let response=await fetch(path,{method,signal:dispatch?(signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)):signal,credentials:dispatch?'omit':'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{}),...dispatch?{Authorization:'Bearer '+dispatchToken}:binding?{...binding.csrfToken?{'X-CSRF-Token':binding.csrfToken}:{},...binding.owner&&binding.sessionContext?{'X-Bindle-Account':binding.owner,'X-Bindle-Session-Context':binding.sessionContext}:{}}:{}},...(body?{body:JSON.stringify(body)}:{})});
    if(dispatch){if(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'||Number(response.headers.get('content-length'))>262144){await response.body?.cancel();throw Error('Unexpected message dispatch response');}const reader=response.body?.getReader();if(!reader)throw Error('Missing message dispatch response');const decoder=new TextDecoder('utf-8',{fatal:true});let text='',size=0,complete=false;try{for(;;){const {done,value}=await reader.read();if(done){complete=true;break;}size+=value.byteLength;if(size>262144)throw Error('Message dispatch response is too large');text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}finally{if(!complete)await reader.cancel().catch(()=>{});reader.releaseLock();}response=new Response(text,{status:response.status,headers:response.headers});}
    if(!dispatch&&generation!==this.contextGeneration){await response.body?.cancel();throw Object.assign(new Error('Account changed. Choose an account to continue.'),{code:'local_account_changed'});}return this.parse(response,{csrf:!dispatch&&context===undefined,live:()=>dispatch||generation===this.contextGeneration});
  },
  // Public capability requests never carry cookies, account headers or a referrer.
  async contactPublic(endpoint,init={}){const response=await fetch(endpoint,{...init,credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'});return this.parse(response,{csrf:false});},
  async contactIntake(endpoint,locale){return this.contactPublic(endpoint,{headers:{Accept:'application/vnd.bindle.contact-intake+json',...locale?{'Accept-Language':locale}:{}}});},
  async contactInspect(endpoint,data){if(!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(data))throw new Error('This eligibility response is invalid.');return this.contactPublic(endpoint+'&bindle_data='+data,{headers:{Accept:'application/json'}});},
  // Exactly two parts: the signed envelope and the exact document bytes (contact-delivery v1).
  async contactDeliver(endpoint,envelope,bytes){if(endpoint.includes('bindle_data'))throw new Error('This contact link is invalid.');const body=new FormData();body.append('envelope',new Blob([JSON.stringify(envelope)],{type:'application/json'}),'envelope.json');body.append('message',new Blob([bytes],{type:envelope.payload.content.mimeType}),'message');return this.contactPublic(endpoint,{method:'POST',headers:{'Idempotency-Key':envelope.payload.operationId},body});},
  async contactProfile(endpoint){
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),5000);
    try{
      const response=await fetch(endpoint,{signal:controller.signal,headers:{Accept:'application/vnd.bindle.contact-profile+json'},credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'});
      if(!response.ok||response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/vnd.bindle.contact-profile+json'){await response.body?.cancel();return null;}
      if(Number(response.headers.get('content-length'))>8192){await response.body?.cancel();return null;}
      const reader=response.body?.getReader();if(!reader)return null;const decoder=new TextDecoder('utf-8',{fatal:true});let text='',bytes=0,complete=false;
      try{for(;;){const {done,value}=await reader.read();if(done){complete=true;break;}bytes+=value.byteLength;if(bytes>8192){await reader.cancel();return null;}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}finally{if(!complete)await reader.cancel().catch(()=>{});reader.releaseLock();}
      const value=JSON.parse(text)?.profile;if(!value||typeof value!=='object'||Array.isArray(value))return null;
      const profile={};for(const [key,max] of [['displayName',100],['bio',500]])if(Object.hasOwn(value,key)&&typeof value[key]==='string'&&value[key].trim()&&value[key].length<=max)profile[key]=value[key];
      if(Object.hasOwn(value,'avatar')&&typeof value.avatar==='string'&&value.avatar.length<=2048)try{const url=new URL(value.avatar);if(url.protocol==='https:'&&!url.username&&!url.password)profile.avatar=url.href;}catch{}
      return Object.keys(profile).length?profile:null;
    }catch{return null;}finally{clearTimeout(timeout);}
  },
  async parse(response,{csrf=true,live=()=>true}={}){let result;try{result=await response.json();}catch{if(!live())throw Object.assign(new Error('Account changed. Choose an account to continue.'),{code:'local_account_changed'});const error=new Error(`The service returned an unexpected response (${response.status}).`);error.status=response.status;throw error;}if(!live())throw Object.assign(new Error('Account changed. Choose an account to continue.'),{code:'local_account_changed'});if(!response.ok){const error=new Error(result?.message??result?.error?.message??(typeof result?.error==='string'?result.error:'The request could not be completed.'));error.status=response.status;const code=result?.code??result?.error?.code??(typeof result?.error==='string'?result.error:undefined);if(typeof code==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(code))error.code=code;if(code==='signup_capacity_reached'&&['free','global'].includes(result?.capacity))error.capacity=result.capacity;const retry=result?.retryAfter??result?.error?.retryAfter??Number(response.headers.get('Retry-After'));if(Number.isSafeInteger(retry)&&retry>0&&retry<=86400)error.retryAfter=retry;throw error;}if(csrf&&result.csrfToken)this.csrf=result.csrfToken;return result;}
};}
