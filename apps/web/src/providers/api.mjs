import { decode64 } from '../bl/browser-codecs.mjs';
import { Provider } from '../shared/stack.mjs';
export default class APIProvider extends Provider {
  #resource=createAPI();
  async obtain(){return this.#resource;}
  release(){}
  dispose(){this.#resource.csrf=null;}
}
export function createAPI(){return {
  csrf:null,
  async get(path){return this.request(path,undefined,'GET');},
  async request(path,body,method='POST',{signal,dispatchToken}={}){
    const dispatch=dispatchToken!==undefined;
    if(dispatch&&(typeof dispatchToken!=='string'||dispatchToken.length>65536||!/^[A-Za-z0-9._-]+$/.test(dispatchToken)||!/^\/api\/messages\/[0-9a-f-]{36}\/postbacks$/.test(path)||method!=='POST'||JSON.stringify(body)!=='{}'))throw Error('Invalid message dispatch');
    let response=await fetch(path,{method,signal:dispatch?(signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)):signal,credentials:dispatch?'omit':'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{}),...dispatch?{Authorization:'Bearer '+dispatchToken}:this.csrf?{'X-CSRF-Token':this.csrf}:{}},...(body?{body:JSON.stringify(body)}:{})});
    if(dispatch){if(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'||Number(response.headers.get('content-length'))>262144){await response.body?.cancel();throw Error('Unexpected message dispatch response');}const reader=response.body?.getReader();if(!reader)throw Error('Missing message dispatch response');const decoder=new TextDecoder('utf-8',{fatal:true});let text='',size=0,complete=false;try{for(;;){const {done,value}=await reader.read();if(done){complete=true;break;}size+=value.byteLength;if(size>262144)throw Error('Message dispatch response is too large');text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}finally{if(!complete)await reader.cancel().catch(()=>{});reader.releaseLock();}response=new Response(text,{status:response.status,headers:response.headers});}
    return this.parse(response,{csrf:!dispatch});
  },
  async contactClaims(endpoint){const response=await fetch(endpoint,{headers:{Accept:'application/vnd.bindle.contact-token+jwt'},credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'});if(!response.ok)throw new Error('This contact invitation is expired, revoked, or invalid.');const token=await response.text();if(!response.headers.get('content-type')?.includes('application/vnd.bindle.contact-token+jwt')||token.length>16384)throw new Error('The contact endpoint did not return a bounded capability.');try{return JSON.parse(new TextDecoder().decode(decode64(token.split('.')[1])));}catch{throw new Error('The contact endpoint returned an invalid capability.');}},
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
  async sendContact(endpoint,values,idempotencyKey){const body=new FormData();body.set('collection',values.collection);body.set('mimeType',values.mimeType);body.set('idempotencyKey',idempotencyKey);body.set('subject',values.subject??'');body.set('tags',JSON.stringify(Array.isArray(values.tags)?values.tags:String(values.tags??'').split(',').map(tag=>tag.trim()).filter(Boolean)));body.set('message',values.file?.size?values.file:new Blob([values.text],{type:values.mimeType}),'message');return this.parse(await fetch(endpoint,{method:'POST',credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',body}));},
  async parse(response,{csrf=true}={}){let result;try{result=await response.json();}catch{const error=new Error(`The service returned an unexpected response (${response.status}).`);error.status=response.status;throw error;}if(!response.ok){const error=new Error(result?.message??result?.error?.message??(typeof result?.error==='string'?result.error:'The request could not be completed.'));error.status=response.status;const code=result?.code??result?.error?.code??(typeof result?.error==='string'?result.error:undefined);if(typeof code==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(code))error.code=code;if(code==='signup_capacity_reached'&&['free','global'].includes(result?.capacity))error.capacity=result.capacity;const retry=result?.retryAfter??result?.error?.retryAfter??Number(response.headers.get('Retry-After'));if(Number.isSafeInteger(retry)&&retry>0&&retry<=86400)error.retryAfter=retry;throw error;}if(csrf&&result.csrfToken)this.csrf=result.csrfToken;return result;}
};}
