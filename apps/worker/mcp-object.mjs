import {DurableObject} from 'cloudflare:workers';
import {McpShardController} from '../../packages/mcp/runtime.mjs';
import {ShardedIdentityRepository} from '../../packages/runtime/identity-shards.mjs';
export class McpAuthorizationObject extends DurableObject{
 constructor(ctx,env){super(ctx,env);this.ctx=ctx;this.env=env;this.controllers=new Map();this.tail=Promise.resolve();}
 controller(shard){let controller=this.controllers.get(shard);if(!controller){const repository=new ShardedIdentityRepository({shard:name=>this.env.IDENTITIES.get(this.env.IDENTITIES.idFromName(name)),layout:this.env.IDENTITY_LAYOUT});controller=new McpShardController({metadata:this.ctx.storage,config:this.env,shard,accounts:{get:id=>this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName(id))},repository});this.controllers.set(shard,controller);}return controller;}
 async alarm(){const shard=await this.ctx.storage.get('mcp/shard');if(shard)await this.controller(shard).cleanup();}
 async invoke(shard,method,args){
  if(!/^(?:[0-5][0-9]|6[0-3])$/.test(shard))return {ok:false,error:{code:'invalid_request',message:'Invalid MCP shard.',status:400}};
  const stored=await this.ctx.storage.get('mcp/shard');if(stored&&stored!==shard)return {ok:false,error:{code:'invalid_request',message:'MCP shard mismatch.',status:400}};if(!stored)await this.ctx.storage.put('mcp/shard',shard);return this.controller(shard).invoke(method,args);
 }
}
