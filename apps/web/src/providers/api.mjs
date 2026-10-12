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
  async request(path,body,method='POST',{signal}={}){
    const response=await fetch(path,{method,signal,credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{}),...(this.csrf?{'X-CSRF-Token':this.csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return this.parse(response);
  },
  async contactClaims(endpoint){const response=await fetch(endpoint,{headers:{Accept:'application/vnd.bindle.contact-token+jwt'},credentials:'omit',cache:'no-store'});if(!response.ok)throw new Error('This contact invitation is expired, revoked, or invalid.');const token=await response.text();if(!response.headers.get('content-type')?.includes('application/vnd.bindle.contact-token+jwt')||token.length>16384)throw new Error('The contact endpoint did not return a bounded capability.');try{return JSON.parse(new TextDecoder().decode(decode64(token.split('.')[1])));}catch{throw new Error('The contact endpoint returned an invalid capability.');}},
  async sendContact(endpoint,values,idempotencyKey){const body=new FormData();body.set('collection',values.collection);body.set('mimeType',values.mimeType);body.set('idempotencyKey',idempotencyKey);body.set('subject',values.subject??'');body.set('tags',JSON.stringify(String(values.tags??'').split(',').map(tag=>tag.trim()).filter(Boolean)));body.set('message',values.file?.size?values.file:new Blob([values.text],{type:values.mimeType}),'message');return this.parse(await fetch(endpoint,{method:'POST',credentials:'omit',cache:'no-store',body}));},
  async parse(response){let result;try{result=await response.json();}catch{const error=new Error(`The service returned an unexpected response (${response.status}).`);error.status=response.status;throw error;}if(!response.ok){const error=new Error(result.message??result.error?.message??(typeof result.error==='string'?result.error:'The request could not be completed.'));error.status=response.status;throw error;}if(result.csrfToken)this.csrf=result.csrfToken;return result;}
};}
