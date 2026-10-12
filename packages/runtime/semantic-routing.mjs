export const SEMANTIC_LAYOUT=Object.freeze({version:1,vectorShards:4,budgetShards:16});
export async function semanticShard(owner,count){if(typeof owner!=='string'||!owner||!Number.isInteger(count)||count<1)throw new TypeError('Invalid semantic route');const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(owner)));return new DataView(digest.buffer).getUint32(0,false)%count;}
export async function vectorBinding(config,owner){
 const bindings=Array.from({length:SEMANTIC_LAYOUT.vectorShards},(_,index)=>config[`SEARCH_VECTORS_${index}`]);
 if(bindings.every(binding=>binding?.query&&binding?.upsert&&binding?.deleteByIds)){const shard=await semanticShard(owner,SEMANTIC_LAYOUT.vectorShards);return {binding:bindings[shard],shard,layoutVersion:SEMANTIC_LAYOUT.version};}
 if(config.SEARCH_VECTORS?.query)return {binding:config.SEARCH_VECTORS,shard:0,layoutVersion:0};
 throw new Error('Vectorize routing is incomplete');
}
export function semanticBudgetPartition(config,partition){
 if(!Number.isInteger(partition)||partition<0||partition>=SEMANTIC_LAYOUT.budgetShards)throw new TypeError('Invalid budget partition');
 const totals={SEMANTIC_GLOBAL_MONTHLY_MICRO_USD:5000000,SEMANTIC_GLOBAL_DAILY_MICRO_USD:500000,SEMANTIC_GLOBAL_MAX_OWNERS:1000,SEMANTIC_GLOBAL_MAX_UPSERTS:2000000};const result={};
 for(const [key,fallback]of Object.entries(totals)){const total=config[key]===undefined?fallback:Number(config[key]);if(!Number.isSafeInteger(total)||total<SEMANTIC_LAYOUT.budgetShards)throw new TypeError('Invalid partitioned semantic budget');result[key]=Math.floor(total/SEMANTIC_LAYOUT.budgetShards)+(partition<total%SEMANTIC_LAYOUT.budgetShards?1:0);}
 return result;
}
