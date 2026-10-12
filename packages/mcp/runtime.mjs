import {McpAuthorization,McpFault,MCP_LAYOUT,MCP_SHARDS,mcpMetadata,shardOf} from './service.mjs';
import {retryFailure,retryReady} from '../runtime/cleanup-retry.mjs';
export async function accountCall(accounts,owner,method,args=[]){const result=await accounts.get(owner).invoke({method,args:[owner,...args]});if(result?.$fault)throw new McpFault(result.$fault.code,result.$fault.message,result.$fault.status||400);return result;}
export class McpShardController{
 constructor({metadata,config,shard,accounts,repository}){if(config.MCP_LAYOUT&&config.MCP_LAYOUT!==MCP_LAYOUT)throw new Error('Explicit MCP authorization migration required.');Object.assign(this,{metadata,accounts,repository});this.service=new McpAuthorization({metadata:mcpMetadata(metadata),config,shard});this.service.connections={binding:(owner,clientId)=>accountCall(accounts,owner,'appConnectionBinding',[clientId]),register:(owner,client,expected)=>accountCall(accounts,owner,'appConnect',[{id:client.id,name:client.name,metadata:client.metadata},expected]),check:g=>accountCall(accounts,g.owner,'appConnectionCheck',[g.connectionId,g.connectionGeneration,g.clientId])};}
 async schedule(){const retry=await this.metadata.get('mcp/cleanup-retry');if(retry?.paused)return;const rows=await this.metadata.list({prefix:'mcp/v1/expiry/',limit:1});const next=[...rows.values()][0]?.expiresAt;if(Number.isSafeInteger(next))await this.metadata.setAlarm(Math.max(Date.now()+1000,next,retry?.retryAt||0));}
 async cleanup(){if(!retryReady(await this.metadata.get('mcp/cleanup-retry')))return;try{await this.service.cleanup();await this.metadata.delete('mcp/cleanup-retry');await this.schedule();}catch(error){const retry=await retryFailure(this.metadata,'mcp/cleanup-retry',error);if(!retry.paused)await this.metadata.setAlarm(retry.retryAt);}}
 async active(owner){const account=await this.repository.get(owner);if(!account||account.status!=='active')throw new McpFault('invalid_token','The account is unavailable.',401);}
 begin(input){return this.service.begin(input);}
 inspect(owner,id){return this.service.inspect(owner,id);}
 async approve(owner,input){await this.active(owner);const collections=await accountCall(this.accounts,owner,'mcpCollections');return this.service.approve(owner,input,collections);}
 exchange(input){return this.service.exchange(input);}
 async verify(token){const result=await this.service.verify(token);await this.active(result.owner);return result;}
 async execute(token,tool,args){return this.service.execute(token,tool,args,async(owner,clientId,t,a,permissions,connection)=>{await this.active(owner);if(t==='collections_list')return {collections:(await accountCall(this.accounts,owner,'mcpOperation',[clientId,t,a,connection])).filter(c=>permissions.some(p=>p.collectionId===c.id&&p.tools.includes(t))).map(c=>({...c,tools:c.tools.filter(t=>permissions.some(p=>p.collectionId===c.id&&p.tools.includes(t)))}))};return accountCall(this.accounts,owner,'mcpOperation',[clientId,t,a,connection]);});}
 grants(owner){return this.service.grants(owner);}
 revoke(owner,id){return this.service.revoke(owner,id);}
 async invoke(method,args){if(!['begin','inspect','approve','exchange','verify','execute','grants','revoke'].includes(method))return {ok:false,error:{code:'unsupported_method',message:'Unsupported MCP operation.',status:400}};try{const result=await this[method](...args);if(['begin','approve','exchange'].includes(method))await this.schedule();return {ok:true,result};}catch(error){return {ok:false,error:{code:error.code||'temporarily_unavailable',message:error.code?error.message:'The MCP operation is temporarily unavailable.',status:error.status||503}};}}
}
export function mcpAuthorities(shard){
 const call=async(id,method,args)=>{const result=await shard(id).invoke(method,args);if(!result.ok)throw new McpFault(result.error.code,result.error.message,result.error.status);return result.result;};
 const route=(id)=>shardOf(id);
 return {
  begin:input=>call(String(crypto.getRandomValues(new Uint8Array(1))[0]%MCP_SHARDS).padStart(2,'0'),'begin',[input]),
  inspect:(owner,id)=>call(route(id),'inspect',[owner,id]),approve:(owner,input)=>call(route(input.requestId),'approve',[owner,input]),exchange:input=>call(route(input.grant_type==='refresh_token'?input.refresh_token:input.code),'exchange',[input]),verify:token=>call(route(token),'verify',[token]),execute:(token,tool,args)=>call(route(token),'execute',[token,tool,args]),revoke:(owner,id)=>call(route(id),'revoke',[owner,id]),
  grants:async owner=>{const rows=[];for(let base=0;base<MCP_SHARDS;base+=8){const part=await Promise.all(Array.from({length:8},(_,i)=>call(String(base+i).padStart(2,'0'),'grants',[owner])));rows.push(...part.flat());}return rows.sort((a,b)=>b.approvedAt-a.approvedAt);}
 };
}
