/** Portable, conservative admission ledger. These are estimates of semantic
 * provider work, not a Cloudflare-wide dollar billing cap. Reservations are
 * committed before external calls and never refunded on ambiguous failures. */
export const SEMANTIC_GLOBAL_DEFAULTS=Object.freeze({monthlyMicroUSD:5000000,dailyMicroUSD:500000,maxOwners:1000,maxUpserts:2000000});
const counter=value=>{if(!Number.isSafeInteger(value)||value<0)throw new SemanticBudgetError();return value;};
const positive=(value,fallback)=>{const number=value===undefined?fallback:Number(value);if(!Number.isSafeInteger(number)||number<1)throw new TypeError('Invalid semantic budget configuration');return number;};
export class SemanticBudgetError extends Error{constructor(){super('Semantic search is paused by the service budget. Text search remains available.');this.name='SemanticBudgetError';this.code='semantic_global_budget';this.status=429;}}
export class GlobalSemanticBudget {
 constructor({metadata,config={},clock=()=>Date.now()}){this.metadata=metadata;this.clock=clock;this.limits={monthlyMicroUSD:positive(config.SEMANTIC_GLOBAL_MONTHLY_MICRO_USD,SEMANTIC_GLOBAL_DEFAULTS.monthlyMicroUSD),dailyMicroUSD:positive(config.SEMANTIC_GLOBAL_DAILY_MICRO_USD,SEMANTIC_GLOBAL_DEFAULTS.dailyMicroUSD),maxOwners:positive(config.SEMANTIC_GLOBAL_MAX_OWNERS,SEMANTIC_GLOBAL_DEFAULTS.maxOwners),maxUpserts:positive(config.SEMANTIC_GLOBAL_MAX_UPSERTS,SEMANTIC_GLOBAL_DEFAULTS.maxUpserts)};}
 async reserve({operation,units,owner}){
  if(!['embed','query','upsert'].includes(operation)||!Number.isSafeInteger(units)||units<1||units>(operation==='embed'?512:384)||typeof owner!=='string'||!/^[a-f0-9-]{36}$/i.test(owner))throw new SemanticBudgetError();
  // Round UP using conservative neuron-derived embedding rate, ignoring any
  // caller-provided price. Vector operation always reserves all384dimensions.
  const amount=operation==='embed'?11:4;
  return this.admit(owner,amount,operation==='upsert'?1:0);
 }
 async reserveLease({owner,microUSD,upsertSlots}){if(typeof owner!=='string'||!/^[a-f0-9-]{36}$/i.test(owner)||!Number.isSafeInteger(microUSD)||microUSD<0||microUSD>1000||!Number.isSafeInteger(upsertSlots)||upsertSlots<0||upsertSlots>16||microUSD+upsertSlots===0)throw new SemanticBudgetError();return this.admit(owner,microUSD,upsertSlots,true);}
 async admit(owner,amount,upserts,lease=false){
  return this.metadata.transaction(async tx=>{
   const now=new Date(this.clock()),day=now.toISOString().slice(0,10),month=day.slice(0,7);
   const stock=await tx.get('semantic/stock')||{owners:0,upserts:0};const admitted=await tx.get(`semantic/owner/${owner}`);
   counter(stock.owners);counter(stock.upserts);if(admitted!==undefined&&admitted!==null&&admitted!==true)throw new SemanticBudgetError();
   let daily=await tx.get('semantic/day'),monthly=await tx.get('semantic/month');for(const window of [daily,monthly])if(window){counter(window.microUSD);counter(window.calls);if(typeof window.period!=='string')throw new SemanticBudgetError();}if(daily?.period!==day)daily={period:day,microUSD:0,calls:0};if(monthly?.period!==month)monthly={period:month,microUSD:0,calls:0};
   if(daily.microUSD+amount>this.limits.dailyMicroUSD||monthly.microUSD+amount>this.limits.monthlyMicroUSD||!admitted&&stock.owners>=this.limits.maxOwners||stock.upserts+upserts>this.limits.maxUpserts)throw new SemanticBudgetError();
   if(!admitted){await tx.put(`semantic/owner/${owner}`,true);stock.owners++;}stock.upserts+=upserts;
   await tx.put('semantic/stock',stock);await tx.put('semantic/day',{period:day,microUSD:daily.microUSD+amount,calls:daily.calls+1});await tx.put('semantic/month',{period:month,microUSD:monthly.microUSD+amount,calls:monthly.calls+1});return lease?{day,month,microUSD:amount,upsertSlots:upserts}:true;
  });
 }
}
