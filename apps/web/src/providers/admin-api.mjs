import { Provider } from '../shared/stack.mjs';
import { createAPI } from './api.mjs';
// Host administration transport (reference implementation, not Bindle protocol).
// Every console request is a same-origin POST naming its actor explicitly; the
// boot CSRF token and the account CSRF token live only in this module's memory.
export default class AdminAPIProvider extends Provider {
  #resource=createAdminAPI();
  async obtain(){return this.#resource;}
  release(){}
  dispose(){this.#resource.forget();}
}
const ADMIN_PATH=/^\/api\/admin\/[a-z]+(?:[/-][a-z]+)*$/;
const ACTORS=['boot','admin'];
export function createAdminAPI({fetch:fetcher=(...args)=>globalThis.fetch(...args),account=createAPI({storage:(()=>{try{return globalThis.sessionStorage??null;}catch{return null;}})()})}={}){
  let bootCsrf=null,generation=0;
  const fail=(message,extra={})=>Object.assign(new Error(message),extra);
  return {
    get generation(){return generation;},
    hasBootCsrf:()=>typeof bootCsrf==='string',
    setBootCsrf(value){bootCsrf=typeof value==='string'&&/^[A-Za-z0-9_-]{16,128}$/.test(value)?value:null;},
    /** Drops every credential-bearing value and invalidates in-flight responses. */
    forget(){generation++;bootCsrf=null;account.clearContext({keepSelection:true});},
    /** The administrator actor reuses the tab's selected account session. */
    async accountSession(){const result=await account.get('/api/session');if(result?.authenticated!==true||!result.account?.id||typeof result.csrfToken!=='string'){account.clearContext({keepSelection:true});return null;}account.setContext(result);return {id:result.account.id,handle:result.account.handle};},
    /** Best effort on page exit: withdraw the account session's step-up. */
    endStepUpOnExit(){const context=account.captureContext();if(!context.csrfToken)return;try{fetcher('/api/admin/step-up/end',{method:'POST',keepalive:true,credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',headers:{'Content-Type':'application/json','X-Bindle-Admin-Actor':'admin','X-CSRF-Token':context.csrfToken,...context.owner&&context.sessionContext?{'X-Bindle-Account':context.owner,'X-Bindle-Session-Context':context.sessionContext}:{}},body:'{}'}).catch(()=>{});}catch{}},
    async call(actor,path,body={}){
      if(!ACTORS.includes(actor))throw fail('Choose the boot or administrator console.',{code:'actor_required'});
      if(!ADMIN_PATH.test(path))throw fail('Unsupported administration request.',{code:'invalid_request'});
      const ticket=generation,headers={Accept:'application/json','Content-Type':'application/json','X-Bindle-Admin-Actor':actor};
      if(actor==='boot'&&bootCsrf)headers['X-CSRF-Token']=bootCsrf;
      if(actor==='admin'){const context=account.captureContext();if(context.csrfToken)headers['X-CSRF-Token']=context.csrfToken;if(context.owner&&context.sessionContext){headers['X-Bindle-Account']=context.owner;headers['X-Bindle-Session-Context']=context.sessionContext;}}
      let response;
      try{response=await fetcher(path,{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',headers,body:JSON.stringify(body)});}
      catch{throw fail('The service could not be reached. Check your connection and try again.',{code:'network'});}
      let result=null;
      try{const type=response.headers.get('content-type')??'';if(!type.split(';')[0].trim().toLowerCase().endsWith('json'))throw 0;result=await response.json();}catch{result=null;}
      // A reset (sign-out, expiry, actor change) while this request was in flight
      // makes its answer stale: never surface it into the console.
      if(ticket!==generation)throw fail('The console was reset. Try again.',{code:'local_reset'});
      if(!response.ok||!result||typeof result!=='object'){const code=typeof result?.error==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(result.error)?result.error:response.status===404?'admin_unavailable':'unexpected_response';throw fail(typeof result?.message==='string'?result.message.slice(0,300):'The request could not be completed.',{code,status:response.status});}
      return result;
    }
  };
}
