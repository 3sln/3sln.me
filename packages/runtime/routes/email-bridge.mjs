// Owner transport: shared router supplies session, selected owner, CSRF and activity/capacity checks.
import {bridgeConfig} from '../../email-bridge/engine.mjs';
import {bridgeKey} from '../../email-bridge/keys.mjs';
import {ownerOperation} from '../../email-bridge/owner.mjs';
import {json,body} from './shared.mjs';
const settings='/api/email-bridge',accepted='/api/email-bridge/accepted',keys='/.well-known/bindle/email-bridge-keys.json';
export const allowedMethods=path=>path===settings?['GET','PUT']:path===accepted?['POST']:null;
export const admission={protective:[{match:path=>path===settings,test:v=>v?.enabled===false||v?.autoReply===false}]};
export const stages={
 async public({request,env,path}){
  if(!bridgeConfig(env).enabled||!(path===keys||path.startsWith('/keys/email-bridge/')))return;
  const headers={'Access-Control-Allow-Origin':'*','Cache-Control':'public, max-age=60, must-revalidate','Content-Type':'application/jwk-set+json'};
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...headers,'Access-Control-Allow-Methods':'GET, HEAD, OPTIONS'}});
  if(!['GET','HEAD'].includes(request.method))return json({error:'method_not_allowed'},405,{Allow:'GET, HEAD, OPTIONS'});
  const k=await bridgeKey(env);if(!k)return json({error:'email_unavailable'},503);
  if(path!==keys&&`${env.APP_ORIGIN}${path}`!==k.keyId)return json({error:'not_found'},404);
  return new Response(request.method==='HEAD'?null:JSON.stringify(path===keys?{keys:[k.publicJwk]}:k.publicJwk),{headers});
 },
 async owner({request,env,path,object,id}){
  if(!bridgeConfig(env).enabled||![settings,accepted].includes(path))return;
  const input=request.method==='GET'?undefined:await body(request,1024);
  if(path===settings){if(request.method==='PUT'&&input?.enabled===true&&!await object.emailBridgeEntitled(id))throw Object.assign(new Error('A current paid plan is required.'),{code:'forbidden',status:403});return json(await ownerOperation(env,id,request.method==='GET'?'bridge.settings':'bridge.configure',input));}
  if(!input||Object.keys(input).some(k=>k!=='jti')||typeof input.jti!=='string'||!input.jti||input.jti.length>128)throw Object.assign(new Error('Choose an accepted message.'),{code:'invalid_input',status:400});
  return json(await ownerOperation(env,id,'bridge.accepted',input));
 },
};
