import {DurableObject} from 'cloudflare:workers';
import {ShardedIdentityRepository} from '../../packages/runtime/identity-shards.mjs';
import {LifecycleSweep} from '../../packages/runtime/lifecycle-scheduler.mjs';
import {lifecycleMode} from '../../packages/runtime/lifecycle-runner.mjs';
import {remoteAdminStore} from '../../packages/identity/admin-store.mjs';
import {lifecycleIdentityPort,lifecycleAdminHoldPort} from '../../packages/identity/lifecycle-tombstone.mjs';
import {mailTransport} from './email.mjs';
import {createPushTransport} from '../../packages/messaging/web-push.mjs';

export const LIFECYCLE_SCHEDULER_NAME='lifecycle-sweep-v1';
const repositoryOf=env=>new ShardedIdentityRepository({shard:name=>env.IDENTITIES.get(env.IDENTITIES.idFromName(name)),layout:env.IDENTITY_LAYOUT,config:env});

/** Account-object lifecycle ports. Only built when LIFECYCLE_ENABLED, so a
 * disabled deployment constructs no transports for the executor. R2 bindings
 * support per-put storage classes; Node file buckets do not. */
export function workerLifecycleConfig(env){
 if(lifecycleMode(env)==='off')return {};
 const repository=repositoryOf(env),admin=env.ADMIN_AUTHORITY?remoteAdminStore((method,args)=>env.ADMIN_AUTHORITY.get(env.ADMIN_AUTHORITY.idFromName('admin-v1')).invoke(method,args)):null;
 return {LIFECYCLE_IDENTITY:lifecycleIdentityPort(repository),LIFECYCLE_ADMIN_HOLD:lifecycleAdminHoldPort({store:admin,repository}),LIFECYCLE_MAIL:mailTransport(env),LIFECYCLE_PUSH:createPushTransport(env),LIFECYCLE_COLD_STORAGE_SUPPORTED:true};
}
/** The cron trigger and this object's own alarm drive one bounded sweep at a time. */
export class LifecycleScheduler extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.sweep=new LifecycleSweep({metadata:ctx.storage,repository:repositoryOf(env),accounts:{get:id=>env.ACCOUNTS.get(env.ACCOUNTS.idFromName(id))},config:env});}
 run(input){return this.sweep.run(input);}
 status(){return this.sweep.status();}
 alarm(){return this.sweep.run({trigger:'alarm'});}
}

