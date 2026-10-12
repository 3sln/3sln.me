import {collectAppMetadata,validateAppMetadataConfig} from '../apps/metadata.mjs';
import {base64url,digest,boundedString} from '../messaging/store.mjs';
export const MCP_LAYOUT='mcp-auth-v1-64';
export const MCP_SHARDS=64;
import {TOOLS} from '../automation/catalog.mjs';
export {TOOLS} from '../automation/catalog.mjs';
export class McpFault extends Error{constructor(code,message=code,status=400){super(message);Object.assign(this,{code,status});}}
const fail=(...args)=>{throw new McpFault(...args);};
const exact=(value,fields)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!fields.includes(k)))fail('invalid_request');};
const identifier=/^(?:[0-5][0-9]|6[0-3])\.[A-Za-z0-9_-]{43}$/;
export function shardOf(id){if(typeof id!=='string'||!identifier.test(id))fail('invalid_request');return id.slice(0,2);}
const ownerKey=(owner)=>`mcp/v1/owner/${owner}`;
export function mcpMetadata(storage){return {transaction:fn=>storage.transaction(tx=>fn({get:k=>tx.get(k),set:(k,v)=>tx.put(k,v),delete:k=>tx.delete(k),list:async options=>[...await tx.list(options)]}))};}
export function parseClients(config){let list;try{list=JSON.parse(config.MCP_CLIENTS||'[]');}catch{fail('invalid_config','MCP_CLIENTS must be JSON.');}if(!Array.isArray(list)||list.length>100)fail('invalid_config');return list;}
function redirect(value,{local=false}={}){
 let u;try{u=new URL(value);}catch{fail('invalid_config','Invalid redirect URI.');}
 if(u.username||u.password||u.hash||value.length>2048||u.href!==value||u.protocol!=='https:'&&!(local&&u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)))fail('invalid_config','Use an exact HTTPS redirect URI (loopback HTTP in local development).');
 return u;
}
export class McpAuthorization {
 constructor({metadata,config,shard='00',clock=()=>Date.now(),crypto=globalThis.crypto}){
  Object.assign(this,{metadata,config,shard,clock,crypto});this.origin=config.APP_ORIGIN;const origin=redirect(this.origin+'/',{local:config.LOCAL_DEVELOPMENT==='true'});if(origin.origin!==this.origin)fail('invalid_config');
  this.issuer=`${this.origin}/mcp/oauth`;this.resource=`${this.origin}/mcp`;this.clients=new Map();this.metadataLoads=new Map();
  for(const c of parseClients(config)){exact(c,['id','name','redirectUris','origins','application','metadataSources']);if(!boundedString(c.id,200)||c.id===`${this.origin}/automation/browser`||!boundedString(c.name,100)||!Array.isArray(c.redirectUris)||!c.redirectUris.length||c.redirectUris.length>16||this.clients.has(c.id))fail('invalid_config');for(const uri of c.redirectUris)redirect(uri,{local:config.LOCAL_DEVELOPMENT==='true'});if(c.origins!==undefined&&(!Array.isArray(c.origins)||c.origins.some(o=>redirect(o+'/',{local:config.LOCAL_DEVELOPMENT==='true'}).origin!==o)))fail('invalid_config');try{validateAppMetadataConfig(c,{local:config.LOCAL_DEVELOPMENT==='true'});}catch{fail('invalid_config','Invalid application metadata configuration.');}this.clients.set(c.id,structuredClone(c));}
 }
 random(){return `${this.shard}.${base64url(this.crypto.getRandomValues(new Uint8Array(32)))}`;}
 live(value){return value&&Number.isSafeInteger(value.expiresAt)&&value.expiresAt>this.clock();}
 validGrant(g){return this.live(g)&&g.active===true&&identifier.test(g.id)&&g.id.startsWith(this.shard+'.')&&/^[a-f0-9-]{36}$/.test(g.owner)&&this.clients.has(g.clientId)&&Number.isSafeInteger(g.approvedAt)&&g.approvedAt<=this.clock()&&g.expiresAt<=g.approvedAt+30*86400000&&Array.isArray(g.permissions)&&g.permissions.length>0&&g.permissions.length<=200&&new Set(g.permissions.map(p=>p?.collectionId)).size===g.permissions.length&&g.permissions.every(p=>p&&/^(inbox|resource):[a-f0-9-]{36}$/.test(p.collectionId)&&Array.isArray(p.tools)&&p.tools.length>0&&p.tools.length<=TOOLS.length&&new Set(p.tools).size===p.tools.length&&p.tools.every(n=>TOOLS.some(t=>t.name===n)));}
 async record(tx,k,value){await tx.set(k,value);await tx.set(`mcp/v1/expiry/${String(value.expiresAt).padStart(16,'0')}/${k}`,{key:k,expiresAt:value.expiresAt});}
 async cleanup(){return this.metadata.transaction(async tx=>{const rows=await tx.list({prefix:'mcp/v1/expiry/',limit:100});let removed=0;for(const[k,v]of rows){if(v.expiresAt>this.clock())break;const current=await tx.get(v.key);if(current?.expiresAt<=this.clock())await tx.delete(v.key);await tx.delete(k);removed++;}return {removed};});}
 client(id,uri){const c=this.clients.get(id);if(!c||!c.redirectUris.includes(uri))fail('invalid_client','Application and redirect must be registered.');return c;}
 resourceCheck(value){let canonical;try{canonical=new URL(value).href;}catch{}if(canonical!==this.resource)fail('invalid_target','The resource must be this MCP endpoint.');}
 async begin(input){
  exact(input,['client_id','redirect_uri','response_type','code_challenge','code_challenge_method','state','scope','resource']);this.client(input.client_id,input.redirect_uri);this.resourceCheck(input.resource);
  if(input.response_type!=='code'||input.code_challenge_method!=='S256'||!(/^[A-Za-z0-9_-]{43}$/).test(input.code_challenge)||!boundedString(input.state,512))fail('invalid_request','Authorization code, state and S256 PKCE are required.');
  const scopes=(input.scope||'mcp:collections_list mcp:items_list mcp:item_read').split(' ');if(scopes.length>TOOLS.length||new Set(scopes).size!==scopes.length||scopes.some(s=>!TOOLS.some(t=>s===`mcp:${t.name}`)))fail('invalid_scope');
  const requestId=this.random();await this.metadata.transaction(tx=>this.record(tx,`mcp/v1/request/${requestId}`,{...input,scopes,requestId,status:'pending',expiresAt:this.clock()+600000}));return {requestId};
 }
 async pending(tx,id){shardOf(id);const r=await tx.get(`mcp/v1/request/${id}`);if(!this.live(r)||r.status!=='pending'||r.requestId!==id||r.resource!==this.resource||!Array.isArray(r.scopes)||!r.scopes.length||r.scopes.some(s=>!TOOLS.some(t=>s===`mcp:${t.name}`)))fail('invalid_request','Authorization expired or completed.');this.client(r.client_id,r.redirect_uri);return r;}
 async inspect(owner,id){
  const pending=await this.metadata.transaction(async tx=>{const r=await this.pending(tx,id);if(this.connections){if(r.consentOwner&&r.consentOwner!==owner)fail('invalid_request','Authorization belongs to another account.');if(!r.consentOwner){r.consentOwner=owner;r.connectionBinding=await this.connections.binding(owner,r.client_id);await tx.set(`mcp/v1/request/${id}`,r);}}return r;});
  let metadata=pending.appMetadata;if(!metadata){let loading=this.metadataLoads.get(id);if(!loading){loading=collectAppMetadata(this.clients.get(pending.client_id),{publicFetch:this.metadataLoads.size<16?this.config.APP_METADATA_FETCH:undefined,local:this.config.LOCAL_DEVELOPMENT==='true'});if(this.metadataLoads.size<16)this.metadataLoads.set(id,loading);}try{metadata=await loading;}finally{if(this.metadataLoads.get(id)===loading)this.metadataLoads.delete(id);}}
  return this.metadata.transaction(async tx=>{const r=await this.pending(tx,id);if(this.connections&&r.consentOwner!==owner)fail('invalid_request');if(!r.appMetadata){r.appMetadata=metadata;await tx.set(`mcp/v1/request/${id}`,r);}return {requestId:id,client:{id:r.client_id,name:r.appMetadata.name,registeredName:this.clients.get(r.client_id).name,metadata:r.appMetadata,redirectUri:r.redirect_uri},scopes:r.scopes,tools:TOOLS.filter(t=>r.scopes.includes(`mcp:${t.name}`)),expiresAt:r.expiresAt};});
 }
 redirect(r,params){const u=new URL(r.redirect_uri);for(const[k,v]of Object.entries({...params,state:r.state,iss:this.issuer}))u.searchParams.set(k,v);return u.href;}
 async approve(owner,input,collections){
  exact(input,['requestId','permissions','denied']);return this.metadata.transaction(async tx=>{
   const r=await this.pending(tx,input.requestId);
   if(input.denied===true){r.status='denied';await tx.set(`mcp/v1/request/${r.requestId}`,r);return {redirectUri:this.redirect(r,{error:'access_denied'})};}
   if(!Array.isArray(input.permissions)||!input.permissions.length||input.permissions.length>200)fail('invalid_scope','Choose at least one collection and function.');
   const permissions=[];for(const p of input.permissions){exact(p,['collectionId','tools']);const c=collections.find(c=>c.id===p.collectionId);if(!c||permissions.some(x=>x.collectionId===p.collectionId)||!Array.isArray(p.tools)||!p.tools.length||new Set(p.tools).size!==p.tools.length||p.tools.some(t=>!c.tools.includes(t)||!r.scopes.includes(`mcp:${t}`)))fail('invalid_scope');permissions.push(structuredClone(p));}
   const index=[];for(const id of await tx.get(ownerKey(owner))||[]){const g=await tx.get(`mcp/v1/grant/${id}`);if(g?.active&&g.expiresAt>this.clock())index.push(id);}if(index.length>=2)fail('grant_limit','Remove unused connections before adding another.',429);
   let connection;if(this.connections){if(r.consentOwner!==owner||!r.connectionBinding)fail('invalid_request','Review the authorization first.');connection=await this.connections.register(owner,{...this.clients.get(r.client_id),name:r.appMetadata?.name??this.clients.get(r.client_id).name,metadata:r.appMetadata},r.connectionBinding.generation);}
   const grantId=this.random(),approvedAt=this.clock(),grant={id:grantId,owner,clientId:r.client_id,clientName:r.appMetadata?.name??this.clients.get(r.client_id).name,permissions,...connection?{connectionId:connection.id,connectionGeneration:connection.generation}:{},active:true,approvedAt,expiresAt:approvedAt+30*86400000};
   const code=this.random();await this.record(tx,`mcp/v1/grant/${grantId}`,grant);await tx.set(ownerKey(owner),[...index,grantId]);await this.record(tx,`mcp/v1/code/${await digest(this.crypto,'code\0'+code)}`,{owner,clientId:r.client_id,redirectUri:r.redirect_uri,challenge:r.code_challenge,grantId,expiresAt:this.clock()+60000});r.status='approved';await tx.set(`mcp/v1/request/${r.requestId}`,r);return {redirectUri:this.redirect(r,{code})};
  });
 }
 async exchange(input){
  if(input.grant_type==='refresh_token')return this.refresh(input);
  exact(input,['grant_type','code','code_verifier','client_id','redirect_uri','resource']);if(input.grant_type!=='authorization_code')fail('unsupported_grant_type');this.client(input.client_id,input.redirect_uri);this.resourceCheck(input.resource);shardOf(input.code);
  if(!/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier))fail('invalid_grant');const hash=await digest(this.crypto,'code\0'+input.code),challenge=await digest(this.crypto,input.code_verifier);
  return this.metadata.transaction(async tx=>{const c=await tx.get(`mcp/v1/code/${hash}`);if(!this.live(c)||c.clientId!==input.client_id||c.redirectUri!==input.redirect_uri||c.challenge!==challenge)fail('invalid_grant');const g=await tx.get(`mcp/v1/grant/${c.grantId}`);if(!this.validGrant(g)||g.owner!==c.owner||g.clientId!==c.clientId||g.id!==c.grantId)fail('invalid_grant');await tx.delete(`mcp/v1/code/${hash}`);return this.issue(tx,g);});
 }
 async issue(tx,grant){if(this.connections){try{await this.connections.check(grant);}catch(error){if(['invalid_token','forbidden'].includes(error.code))fail('invalid_grant','The app connection was disconnected.');throw error;}}const access_token=this.random(),refresh_token=this.random(),scope=[...new Set(grant.permissions.flatMap(p=>p.tools.map(t=>`mcp:${t}`)))].join(' '),claims={issuer:this.issuer,audience:this.resource,owner:grant.owner,clientId:grant.clientId,grantId:grant.id,scope};await this.record(tx,`mcp/v1/token/${await digest(this.crypto,'token\0'+access_token)}`,{...claims,expiresAt:Math.min(this.clock()+300000,grant.expiresAt)});await this.record(tx,`mcp/v1/refresh/${await digest(this.crypto,'refresh\0'+refresh_token)}`,{...claims,status:'active',expiresAt:grant.expiresAt});return {access_token,refresh_token,token_type:'Bearer',expires_in:Math.min(300,Math.floor((grant.expiresAt-this.clock())/1000)),scope};}
 async refresh(input){
  exact(input,['grant_type','refresh_token','client_id','resource']);this.resourceCheck(input.resource);if(!this.clients.has(input.client_id))fail('invalid_client');try{shardOf(input.refresh_token);}catch{fail('invalid_grant');}
  const hash=await digest(this.crypto,'refresh\0'+input.refresh_token);
  const result=await this.metadata.transaction(async tx=>{const r=await tx.get(`mcp/v1/refresh/${hash}`);if(!this.live(r)||r.clientId!==input.client_id||r.issuer!==this.issuer||r.audience!==this.resource||!['active','spent'].includes(r.status))fail('invalid_grant');const g=await tx.get(`mcp/v1/grant/${r.grantId}`);if(!this.validGrant(g)||g.id!==r.grantId||g.owner!==r.owner||g.clientId!==r.clientId||r.expiresAt!==g.expiresAt)fail('invalid_grant');if(r.status==='spent'){g.active=false;g.revokedReason='refresh_reuse';await tx.set(`mcp/v1/grant/${g.id}`,g);return {reused:true};}r.status='spent';await tx.set(`mcp/v1/refresh/${hash}`,r);return this.issue(tx,g);});
  if(result.reused)fail('invalid_grant','Refresh token reuse revoked this connection.');return result;
 }
 async token(tx,bearer){try{shardOf(bearer);}catch{fail('invalid_token','Bearer token required.',401);}const t=await tx.get(`mcp/v1/token/${await digest(this.crypto,'token\0'+bearer)}`),g=t&&await tx.get(`mcp/v1/grant/${t.grantId}`);if(!this.live(t)||t.issuer!==this.issuer||t.audience!==this.resource||!this.clients.has(t.clientId)||!this.validGrant(g)||g.id!==t.grantId||g.owner!==t.owner||g.clientId!==t.clientId||t.expiresAt>g.expiresAt||typeof t.scope!=='string'||t.scope!==[...new Set(g.permissions.flatMap(p=>p.tools.map(n=>`mcp:${n}`)))].join(' '))fail('invalid_token','The connection has expired or was revoked.',401);if(this.connections)await this.connections.check(g);return {token:t,grant:g};}
 async verify(bearer){return this.metadata.transaction(async tx=>{const {token,grant}=await this.token(tx,bearer);return {owner:token.owner,clientId:token.clientId,permissions:grant.permissions,scopes:token.scope.split(' ')};});}
 async execute(bearer,tool,args,dispatch){const admitted=await this.metadata.transaction(async tx=>{const {token,grant}=await this.token(tx,bearer);if(!grant.permissions.some(p=>(tool==='collections_list'||p.collectionId===args.collectionId)&&p.tools.includes(tool)))fail('insufficient_scope','Collection and function consent is required.',403);return {owner:token.owner,clientId:token.clientId,permissions:grant.permissions,connection:{id:grant.connectionId,generation:grant.connectionGeneration}};});return dispatch(admitted.owner,admitted.clientId,tool,args,admitted.permissions,admitted.connection);}
 async grants(owner){return this.metadata.transaction(async tx=>{const ids=await tx.get(ownerKey(owner))||[],rows=[];for(const id of ids){const g=await tx.get(`mcp/v1/grant/${id}`);if(g?.owner===owner&&g.active&&g.expiresAt>this.clock())rows.push(g);}return rows;});}
 async revoke(owner,id){shardOf(id);return this.metadata.transaction(async tx=>{const g=await tx.get(`mcp/v1/grant/${id}`);if(!g||g.owner!==owner)fail('not_found','Connection not found.',404);g.active=false;await tx.set(`mcp/v1/grant/${id}`,g);const ids=await tx.get(ownerKey(owner))||[];await tx.set(ownerKey(owner),ids.filter(i=>i!==id));return {revoked:true};});}
}
