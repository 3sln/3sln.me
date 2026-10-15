import { Provider } from '../shared/stack.mjs';
// The only mutable model of the administration console. Read leases see a frozen
// snapshot; Action write leases commit whole transitions.
function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;}
export const consoleReset=()=>({consoleReady:false,view:'overview',overview:null,user:null,lookupQuery:null,principals:null,audit:null,reveal:null,modal:null,notice:'',noticeSubject:null,error:null,busy:false});
export const initialAdminState=(patch={})=>({phase:'loading',mode:'boot',locale:'en',now:Date.now(),boot:null,account:null,stepUpAt:null,setup:null,signin:null,...consoleReset(),...patch});
export default class AdminStateProvider extends Provider {
  #state;#disposed=false;
  constructor(initial=initialAdminState()){super();this.#state=freeze({...initial});}
  async obtain({write=false}={}){
    const snapshot=()=>this.#state;
    if(!write)return Object.freeze({snapshot});
    return Object.freeze({snapshot,transition:recipe=>{if(this.#disposed)throw new Error('Administration state has been disposed.');const next={...this.#state};recipe(next);this.#state=freeze(next);return this.#state;}});
  }
  release(){}
  dispose(){this.#disposed=true;}
}
