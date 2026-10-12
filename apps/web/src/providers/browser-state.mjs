import { Provider } from '../shared/stack.mjs';
function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;}
const initial = () => ({loading:true,conversations:{},mcpRequest:null,mcpGrants:null,automation:null,beaming:{},beamGeneration:0,locale:'en',keybindingOverrides:[],keyChord:[],view:'inbox',auth:'signup',authMethod:'passkey',session:null,data:null,notice:'',error:'',busy:false,modal:null,selected:null,filter:'all',search:'',searchDraft:{},spaceSearch:{phase:'idle',items:[]},semanticPreferences:null,billing:null,billingLoading:false,billingError:'',config:{},pending:false,recovery:null,downloaded:false,offline:false,route:{kind:'home'},deviceLogin:null});
// The provider owns the only mutable browser model. Read leases cannot change it;
// domain Action leases can commit transitions. A Query is its sole UI projection.
export default class BrowserStateProvider extends Provider {
  #state=freeze(initial());
  #disposed=false;
  async obtain({write=false}={}) {
    const snapshot=()=>this.#state;
    if(!write)return Object.freeze({snapshot});
    return Object.freeze({snapshot,transition:recipe=>{
      if(this.#disposed)throw new Error('Browser state has been disposed.');
      const next={...this.#state};recipe(next);this.#state=freeze(next);
      return this.#state;
    },reserve:()=>{
      if(this.#state.busy)return false;
      this.#state=freeze({...this.#state,busy:true,error:''});return true;
    }});
  }
  release() {}
  dispose(){this.#disposed=true;this.#state=Object.freeze(initial());}
}
