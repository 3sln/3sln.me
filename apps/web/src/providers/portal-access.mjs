import { Provider } from '../shared/stack.mjs';
export default class PortalAccessProvider extends Provider {
  static deps=['state'];
  constructor({state}){super();this.state=state;}
  async obtain({capability,command}){
    if(!['navigation','account','public'].includes(capability))throw new Error('Unknown command capability.');
    const read=await this.state.obtain();try{const snapshot=read.snapshot();if(capability!=='public'&&(!snapshot.session?.account||snapshot.offline))throw new Error('Sign in and reconnect before using this command.');return Object.freeze({command,capability});}finally{await this.state.release(read);}
  }
  release(){}
}
