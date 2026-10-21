import {reconcile} from '../../../vendor/dodo/index.js';
import {createIncrementalClient} from '../../../packages/sdk/src/incremental.mjs';
import {createClientEngine,ClientState} from './bl/client.mjs';
import {browserProvider} from './providers/browser.mjs';
import {httpMailbox} from './providers/mailbox.mjs';
import {webView} from './ui/app.mjs';
// The shell supplies verified configuration and its ordinary SDK session. No self-enabling flag or demo actor.
export async function mount(root,{BINDLEBOX_ENABLED=false,archiveEnabled=false,owner,token,identity,incrementalEnabled=false,requests={},mailbox,locale=root.ownerDocument.documentElement.lang||'en',pollMs=15000}={}){
 if(BINDLEBOX_ENABLED!==true)return {disabled:true,dispose(){}};
 const window=root.ownerDocument.defaultView,permissions=identity?{client:createIncrementalClient({client:identity,enabled:incrementalEnabled}),requests}:{requests:{}},transport=mailbox??httpMailbox({fetch:window.fetch.bind(window),token,base:window.location.origin,archiveEnabled}),client=createClientEngine({BINDLEBOX_ENABLED,mailbox:transport,browser:browserProvider({window,owner}),permissions,locale,online:window.navigator.onLine});
 let closed=false,timer;
 const send=(name,input)=>client.run(name,input).then(result=>{if(name==='navigate')root.querySelector('main>h2')?.focus();return result;}).catch(()=>{}),subscription=client.engine.query(new ClientState()).subscribe({next:state=>{if(closed)return;root.ownerDocument.documentElement.lang=state.locale;reconcile(root,[webView(state,send,{archive:transport.archive,access:!!permissions.requests.classifier})]);}});
 const connectivity=()=>send('connectivity',{online:window.navigator.onLine}),tick=async()=>{if(closed)return;await send('sync');if(!closed)timer=window.setTimeout(tick,Math.max(1000,pollMs));};
 window.addEventListener('online',connectivity);window.addEventListener('offline',connectivity);
 await send('load');if(!closed)timer=window.setTimeout(tick,Math.max(1000,pollMs));
 return {...client,async dispose(){closed=true;window.clearTimeout(timer);window.removeEventListener('online',connectivity);window.removeEventListener('offline',connectivity);subscription.unsubscribe();reconcile(root,[]);await permissions.client?.dispose();await client.dispose();}};
}
