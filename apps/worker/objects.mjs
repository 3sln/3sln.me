import { DurableObject } from 'cloudflare:workers';
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
  constructor(ctx,env){super(ctx,env);this.controller=new AccountController({metadata:ctx.storage,gate:{run:callback=>ctx.blockConcurrencyWhile(callback)},blobs:env.BLOBS,archives:env.ARCHIVES,config:env,sql:ctx.storage.sql,sqlTransaction:operation=>ctx.storage.transactionSync(operation)});}
}
for(const [Adapter,Controller]of [[IdentityDirectory,IdentityRepository],[AbuseGuard,FixedWindowGuard],[AccountObject,AccountController]]){
  for(const method of Object.getOwnPropertyNames(Controller.prototype))if(method!=='constructor')Object.defineProperty(Adapter.prototype,method,{value:function(...args){return this.controller[method](...args);},writable:true,configurable:true});
}
