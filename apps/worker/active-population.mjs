import {activePopulationPort} from '../../packages/runtime/active-population.mjs';
import {ShardedIdentityRepository} from '../../packages/runtime/identity-shards.mjs';
const cache=new WeakMap();
export function workerActivePopulation(env){let entry=cache.get(env.ABUSE);if(entry)return entry;const repository=new ShardedIdentityRepository({shard:name=>env.IDENTITIES.get(env.IDENTITIES.idFromName(name)),layout:env.IDENTITY_LAYOUT});entry=activePopulationPort({threshold:Number(env.DEVELOPER_CONTACT_ACTIVE_THRESHOLD??1500),repository,accounts:{get:owner=>env.ACCOUNTS.get(env.ACCOUNTS.idFromName(owner))},authority:(name,method,input)=>env.ABUSE.get(env.ABUSE.idFromName(name)).populationAction(method,input)});cache.set(env.ABUSE,entry);return entry;}
