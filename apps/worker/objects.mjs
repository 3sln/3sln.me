import {LeasedSemanticSpend} from '../../packages/runtime/semantic-leases.mjs';
import {semanticShard,SEMANTIC_LAYOUT} from '../../packages/runtime/semantic-routing.mjs';
import { DurableObject } from 'cloudflare:workers';
export { SemanticBudgetObject } from './semantic-budget.mjs';
import { IdentityRepository, FixedWindowGuard, AccountController } from '../../packages/runtime/accounts.mjs';

// The Cloudflare adapter supplies persistence, serialization, alarms and buckets.
// Every policy method is the same portable controller used by the Node adapter.
export class IdentityDirectory extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.controller=new IdentityRepository({metadata:ctx.storage});}
}
export class AbuseGuard extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.controller=new FixedWindowGuard({metadata:ctx.storage});}
}
export class AccountObject extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.controller=new AccountController({metadata:ctx.storage,gate:{run:callback=>ctx.blockConcurrencyWhile(callback)},blobs:env.BLOBS,archives:env.ARCHIVES,config:{...env,CONVERSATION_ACCOUNT:owner=>env.ACCOUNTS.get(env.ACCOUNTS.idFromName(owner)),WORK_AUTHORITY:{consume:(key,limits)=>env.ABUSE.get(env.ABUSE.idFromName(key)).consume(limits)},SEMANTIC_SPEND:env.SEMANTIC_BUDGET?new LeasedSemanticSpend({metadata:ctx.storage,authorityFor:async owner=>{const partition=await semanticShard(owner,SEMANTIC_LAYOUT.budgetShards);return {partition,authority:env.SEMANTIC_BUDGET.get(env.SEMANTIC_BUDGET.idFromName(`semantic-spend-v1-${partition}`))};}}):undefined},sql:ctx.storage.sql,sqlTransaction:operation=>ctx.storage.transactionSync(operation)});}
}
for(const [Adapter,Controller]of [[IdentityDirectory,IdentityRepository],[AbuseGuard,FixedWindowGuard],[AccountObject,AccountController]]){
  for(const method of Object.getOwnPropertyNames(Controller.prototype))if(method!=='constructor')Object.defineProperty(Adapter.prototype,method,{value:function(...args){return this.controller[method](...args);},writable:true,configurable:true});
}
