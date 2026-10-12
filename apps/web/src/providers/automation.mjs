import {Provider} from '../shared/stack.mjs';
import {BrowserAutomationAdapter} from './webmcp.mjs';
export class AutomationSession {
 constructor(){this.requests=new Map();this.enabled=false;this.epoch=null;this.feed=null;this.adapter=new BrowserAutomationAdapter({current:()=>this.enabled,confirm:async()=>true,invoke:(name,args,{signal})=>this.request(name,args,signal)});}
 get supported(){return this.adapter.supported;}
 connect(feed){this.feed=feed;}
 async enable(tools,epoch){this.disable();this.epoch=epoch;this.enabled=true;try{await this.adapter.enable(tools);}catch(error){this.disable();throw error;}}
 request(name,args,signal){if(!this.enabled||!this.feed||signal?.aborted)return Promise.reject(Error('Browser automation was disabled.'));if(this.requests.size)return Promise.reject(Error('Finish the current browser action first.'));return new Promise((resolve,reject)=>{const id=crypto.randomUUID(),record={id,name,args,resolve,reject,signal,epoch:this.epoch};const cancel=()=>this.finish(id,Error('Browser action canceled.'));record.timer=setTimeout(cancel,120000);record.cleanup=()=>{clearTimeout(record.timer);signal?.removeEventListener('abort',cancel);};this.requests.set(id,record);signal?.addEventListener('abort',cancel,{once:true});this.feed.dispatchEvent(new CustomEvent('automation-call',{detail:{id}}));});}
 get(id){const r=this.requests.get(id);if(!r||!this.enabled||r.epoch!==this.epoch||r.signal?.aborted)throw Error('Browser action is no longer available.');return r;}
 review(id,nonce){const r=this.get(id);r.nonce=nonce;r.reviewing=true;}
 finish(id,error,result){const r=this.requests.get(id);if(!r)return;r.cleanup();this.requests.delete(id);if(error)r.reject(error);else r.resolve(result);if(r.reviewing)this.feed?.dispatchEvent(new Event('browser-state-updated'));}
 synchronize(state){const epoch=state.session?.account?`${state.session.account.id}:${state.beamGeneration??0}`:null;if(this.enabled&&(!epoch||epoch!==this.epoch||state.offline))this.disable();for(const r of this.requests.values())if(r.reviewing&&(state.modal?.kind!=='automation-review'||state.modal.id!==r.id))this.finish(r.id,Error('Browser action canceled.'));}
 disable(){this.enabled=false;this.epoch=null;this.adapter.disable();for(const id of this.requests.keys())this.finish(id,Error('Browser automation was disabled.'));}
 dispose(){this.feed=null;this.disable();}
}
export default class AutomationProvider extends Provider {#resource=new AutomationSession();async obtain(){return this.#resource;}release(){}dispose(){this.#resource.dispose();}}
