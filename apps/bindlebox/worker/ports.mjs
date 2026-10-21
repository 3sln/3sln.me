import {objectStoragePort,archiveKeyPort} from './archive-ports.mjs';
import {sealedDelegateKeys} from './delegate-keys.mjs';
import {fault} from '../../../packages/bindlebox-engine/faults.mjs';
// A deployment supplies these adapters over ordinary consented provider APIs. No provider implementation is
// imported. Service bindings are trust boundaries, not feature flags; missing bindings never enable a feature.
export function servicePorts({services,egress,store,secret,clientId,clock}){
 const call=(method,...args)=>{if(typeof services?.[method]!=='function')fault('recipient_unavailable','Provider service unavailable.',503);return services[method](...args);};
 const directory={resolveContact:async input=>call('resolveContact',{owner:await store.get('owner'),...input}),resolveKey:q=>call('resolveKey',q),status:q=>call('delegationStatus',q)};
 return {userStorage:objectStoragePort({services,store}),ownerKeys:archiveKeyPort({services,store}),directory,providerLink:Object.fromEntries(['issue','revoke','evaluate','list','changes','consumerKey','accepted'].map(method=>[method,async input=>call('links',{owner:await store.get('owner'),method,input})])),delegateKeys:sealedDelegateKeys({store,secret,clientId,clock,directory,certify:request=>call('certify',request)}),egress:{fetch:(url,init)=>{if(typeof egress?.fetch!=='function')fault('recipient_unavailable','Delivery transport unavailable.',503);return egress.fetch(new Request(url,init));}}};
}
