import {BUILT_IN_INTEGRATIONS} from '../account/connections.mjs';
import {consentContracts} from '../../consent/contracts.mjs';
// X11 owner transport. Identity, member selection and CSRF are resolved by the shared router.
import {json,body} from './shared.mjs';
import {federationSchemas} from '../federation.mjs';
import {digest,canonical} from '../../messaging/store.mjs';
const on=env=>[true,'true'].includes(env.INTEGRATIONS_ENABLED),fail=(code,message,status=409)=>{throw Object.assign(Error(message),{code,status});};
const paths=['/api/connections/owner','/api/connections/setup','/api/connections/client-metadata'];
export const allowedMethods=path=>paths.includes(path)?['POST']:null;
async function connection(object,id,input){const {connections}=await object.connectionsOwner(id,{operation:'connections.list'}),c=connections.find(c=>c.id===input.connection);if(!c||c.generation!==input.generation||c.state==='disconnected')fail('connection_changed','Reload this connection before continuing.');return c;}
async function setup(env,object,id,context,input){
 const c=await connection(object,id,input),manifest=c.integration?.snapshot?.manifest??c.integration?.manifest;
 if(!manifest)fail('invalid_state','This app has no integration setup.');
 const schemas=federationSchemas(env),preferences=await env.FEDERATION_AUTHORITY.preferences(context),fragments=[];
 for(const f of manifest.setup?.fragments??[]){const schema=schemas[f.fragment];if(!schema)fail('untrusted_schema_host','This setup fragment has not been registered with this provider.');const p=preferences.preferences.find(p=>p.fragment===f.fragment);fragments.push({schema:{...schema,fields:Object.fromEntries(Object.entries(schema.fields).filter(([name])=>!f.fields||f.fields.includes(name)))},digest:await digest(crypto,canonical(schema)),revision:p?.revision??null,values:p?.values??{},required:f.required===true});}
 return {c,fragments,preferences:preferences.preferences};
}
export const stages={async beforeActivity({env,path,request}){if(on(env)&&path==='/api/connections/contracts'&&request.method==='GET')return json({contracts:await consentContracts()});},async owner({request,env,path,object,id,context,owner}){
 if(!on(env)||!paths.includes(path))return;
 const input=await body(request,16384);
 if(path==='/api/connections/owner'){if(input.operation==='connections.connect-built-in'&&input.input?.integration==='classifier'&&![true,'true'].includes(env.EXTENSIONS_ENABLED))fail('not_found','Not found.',404);const result=await object.connectionsOwner(id,input,{authTime:owner.authTime});return json(input.operation==='connections.list'?{...result,offerings:Object.entries(BUILT_IN_INTEGRATIONS).filter(([id])=>id!=='classifier'||[true,'true'].includes(env.EXTENSIONS_ENABLED)).map(([id,def])=>({id,...def}))}:result);}
 if(path==='/api/connections/client-metadata'){
  if(typeof input.clientId!=='string'||Object.keys(input).some(k=>k!=='clientId'))fail('invalid_request','Use a client metadata document.',400);
  const directory=env.FEDERATION_AUTHORITY?.directory;if(!directory?.enabled)fail('connections_unavailable','Client metadata lookup is unavailable.',503);
  await object.admitWork(id,{initialize:true});const client=await directory.resolve(input.clientId);
  if(client.integration?.status!=='valid'||!client.initiateLoginUri)fail('invalid_client','This app does not offer integration sign-in.',400);
  return json({clientId:client.id,initiate_login_uri:client.initiateLoginUri});
 }
 const prepared=await setup(env,object,id,context,input);if(input.action!=='save')return json({fragments:prepared.fragments});
 const f=prepared.fragments.find(f=>f.schema.id===input.fragment);if(!f||f.digest!==input.digest||f.revision!==input.expectedRevision)fail('stale_consent','Review the current setup before saving.');
 if(!input.values||typeof input.values!=='object'||Array.isArray(input.values)||Object.keys(input.values).some(k=>!Object.hasOwn(f.schema.fields,k)))fail('invalid_preferences','Unsupported setup values.',400);
 const current=prepared.preferences.find(p=>p.fragment===input.fragment),values={...current?.values},records=env.BROKERING_ENABLED==='true'?(await object.integrationsOwner(id,{operation:'integrations.records'})).records:[];
 for(const [name,field]of Object.entries(f.schema.fields)){
  if(field.type==='resource'){
   const selected=input.resources?.[input.fragment+'#'+name];if(selected){const record=records.find(r=>r.id===selected.id);if(!record?.assignments.some(a=>a.consumer.clientId===prepared.c.clientId&&a.binding.fragment===input.fragment&&a.binding.field===name))fail('invalid_resource','Review this resource again.',400);const ref=`${env.APP_ORIGIN}/entities/${id}/resources/brokered/${record.id}`;values[name]=(field.cardinality?.max??1)===1?ref:[ref];}
  }else if(Object.hasOwn(input.values,name)){let v=input.values[name];if(['integer','number'].includes(field.type)){if(v==='')delete values[name];else values[name]=Number(v);}else if(v===''&&(field.cardinality?.min??1)===0)delete values[name];else values[name]=v;}
 }
 const result=await env.FEDERATION_AUTHORITY.configure(context,{fragment:input.fragment,values,expectedRevision:f.revision});
 // Fenced by X4. Required setup remains false until every required fragment exists.
 const latest=await setup(env,object,id,context,input),configured=latest.fragments.filter(f=>f.required).every(f=>latest.preferences.some(p=>p.fragment===f.schema.id));
 await object.connectionsSetupComplete(id,{connection:prepared.c.id,expectedGeneration:prepared.c.generation,configured});return json(result);
}};
