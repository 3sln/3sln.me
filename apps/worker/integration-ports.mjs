import {integrationPorts} from '../../packages/runtime/integration-ports.mjs';
import {createWorkerEventEgress} from '../../packages/runtime/integration-events.mjs';
import {createIntegrationEgress,createDohResolver} from '../../packages/federation/resource-discovery.mjs';
import {BROKERING_STORE,FEDERATION_LAYOUT} from '../../packages/runtime/federation.mjs';
import {federationRemote} from '../../packages/federation/runtime.mjs';
const memo=new WeakMap();
export function workerIntegrationPorts(env,{describe=async query=>{const response=await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(query.owner)).invoke({method:'integrationsMessagingDescribe',args:[query]});if(response?.$fault)throw Object.assign(new Error(response.$fault.message),response.$fault);return response;}}={}){
 let ports=memo.get(env);if(!ports){
  const enabled=[true,'true'].includes(env.INTEGRATIONS_ENABLED)&&[true,'true'].includes(env.BROKERING_ENABLED)&&!!env.FEDERATION;
  const keys=()=>env.FEDERATION.get(env.FEDERATION.idFromName(BROKERING_STORE));
  ports=integrationPorts(env,enabled?{signer:{sign:(purpose,claims)=>keys().brokeringSign(purpose,claims)},mint:claims=>keys().brokeringMint(claims),eventEgress:createWorkerEventEgress({issuer:env.APP_ORIGIN,publicRouting:true}),egress:createIntegrationEgress({resolve:createDohResolver(),publicRouting:true}),doorbellGrant:query=>federationRemote({invoke:(method,args)=>env.FEDERATION.get(env.FEDERATION.idFromName(`${FEDERATION_LAYOUT}/${query.owner}`)).invoke(method,args,query.owner)}).eventDoorbellGrant(query)}:{});memo.set(env,ports);
 }
 return {...ports,...ports.BROKERING_MINT&&[true,'true'].includes(env.BINDLEBOX_ENABLED)&&typeof describe==='function'?{MESSAGING_DESCRIBE:describe}:{}};
}
