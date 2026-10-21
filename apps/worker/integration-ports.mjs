import {createWorkerClientMetadataFetch} from './client-metadata-fetch.mjs';
import {federationClientDirectory} from '../../packages/runtime/federation.mjs';
import {integrationSnapshot} from '../../packages/federation/integrations.mjs';
import {preferencesSnapshotPort,handleBrokeredIntrospection} from '../../packages/federation/introspection.mjs';
import {integrationPorts} from '../../packages/runtime/integration-ports.mjs';
import {createWorkerEventEgress} from '../../packages/runtime/integration-events.mjs';
import {createIntegrationEgress,createDohResolver} from '../../packages/federation/resource-discovery.mjs';
import {BROKERING_STORE,FEDERATION_LAYOUT} from '../../packages/runtime/federation.mjs';
import {federationRemote} from '../../packages/federation/runtime.mjs';
const memo=new WeakMap();
export function workerIntegrationPorts(env,{describe=async query=>{const response=await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(query.owner)).invoke({method:'integrationsMessagingDescribe',args:[query]});if(response?.$fault)throw Object.assign(new Error(response.$fault.message),response.$fault);return response;}}={}){
 let ports=memo.get(env);if(!ports){
  const enabled=[true,'true'].includes(env.INTEGRATIONS_ENABLED)&&[true,'true'].includes(env.BROKERING_ENABLED)&&!!env.FEDERATION;
  let clientDirectory;const directory=()=>clientDirectory??=federationClientDirectory(env,{fetch:createWorkerClientMetadataFetch({publicRouting:true}),limiter:{consume:(key,limits)=>env.ABUSE.get(env.ABUSE.idFromName(key)).consume(limits)}});
  const keys=()=>env.FEDERATION.get(env.FEDERATION.idFromName(BROKERING_STORE));
  const federation=owner=>federationRemote({invoke:(method,args)=>env.FEDERATION.get(env.FEDERATION.idFromName(`${FEDERATION_LAYOUT}/${owner}`)).invoke(method,args,owner)});
  ports=integrationPorts(env,enabled?{introspection:env.FEDERATION_ENABLED==='true',...env.FEDERATION_ENABLED==='true'?{snapshot:preferencesSnapshotPort(federation)}:{},signer:{sign:(purpose,claims)=>keys().brokeringSign(purpose,claims)},mint:claims=>keys().brokeringMint(claims),eventEgress:createWorkerEventEgress({issuer:env.APP_ORIGIN,publicRouting:true}),egress:createIntegrationEgress({resolve:createDohResolver(),publicRouting:true}),doorbellGrant:query=>federationRemote({invoke:(method,args)=>env.FEDERATION.get(env.FEDERATION.idFromName(`${FEDERATION_LAYOUT}/${query.owner}`)).invoke(method,args,query.owner)}).eventDoorbellGrant(query)}:{});if(ports.BROKERED_INTROSPECTION_MOUNTED)ports.BROKERED_INTROSPECTION=request=>handleBrokeredIntrospection(request,{issuer:env.APP_ORIGIN,enabled:true,verifyToken:(token,options)=>keys().brokeringVerify(token,options),clientKeys:({clientId,jwksUri})=>directory().resolveKeys({id:clientId,jwksUri,authMethod:'private_key_jwt'}),account:owner=>new Proxy({},{get:(_,method)=>async input=>{const out=await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(owner)).invoke({method,args:[owner,input]});if(out?.$fault)throw Object.assign(Error(out.$fault.message),out.$fault);return out;}}),federation});if([true,'true'].includes(env.INTEGRATIONS_ENABLED))ports.INTEGRATION_CLIENT_SNAPSHOT=async client=>integrationSnapshot(client,await directory().resolveKeys(client));memo.set(env,ports);
 }
 return {...ports,...ports.BROKERING_MINT&&[true,'true'].includes(env.BINDLEBOX_ENABLED)&&typeof describe==='function'?{MESSAGING_DESCRIBE:describe}:{}};
}
