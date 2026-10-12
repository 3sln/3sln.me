import {SemanticBudgetError} from './semantic-budget.mjs';
/** Per-account durable debit cache backed by prepaid, nonrefundable service
 * allocations. The ordinary provider path never waits on a shared allocator
 * while this UTC day's independent money/vector allocation has capacity. */
export class LeasedSemanticSpend{
 constructor({metadata,authorityFor,clock=()=>Date.now()}){Object.assign(this,{metadata,authorityFor,clock});this.tail=Promise.resolve();}
 async reserve(input){const previous=this.tail;let release;this.tail=new Promise(resolve=>release=resolve);await previous;try{return await this.reserveSerial(input);}finally{release();}}
 async reserveSerial({owner,operation,units}){
  await this.metadata.transaction(async tx=>{const prior=await tx.get('semantic/lease-layout');const layout={version:1,budgetShards:16};if(prior&&(prior.version!==layout.version||prior.budgetShards!==layout.budgetShards))throw new SemanticBudgetError();if(!prior)await tx.put('semantic/lease-layout',layout);});
  if(!['embed','query','upsert'].includes(operation)||!Number.isSafeInteger(units)||units<1||units>(operation==='embed'?512:384))throw new SemanticBudgetError();
  const cost=operation==='embed'?11:4,slots=operation==='upsert'?1:0,key=`semantic/lease/${owner}`;
  let stamp=new Date(this.clock()).toISOString().slice(0,10),lease=await this.metadata.get(key);
  const valid=record=>record&&record.day===stamp&&Number.isSafeInteger(record.money)&&record.money>=0&&Number.isSafeInteger(record.slots)&&record.slots>=0;
  if(lease&&lease.day===stamp&&!valid(lease))throw new SemanticBudgetError();
  if(!valid(lease))lease={day:stamp,money:0,slots:0};
  if(lease.money<cost||lease.slots<slots){
   const {authority,partition}=await this.authorityFor(owner);const microUSD=lease.money<cost?128:0,upsertSlots=lease.slots<slots?16:0;
   const grant=await authority.reserveLease({owner,partition,microUSD,upsertSlots});
   const fresh=new Date(this.clock()).toISOString().slice(0,10);
   if(grant?.owner!==owner||grant.layoutVersion!==1||grant.partition!==partition||grant.day!==fresh||grant.month!==fresh.slice(0,7)||grant.microUSD!==microUSD||grant.upsertSlots!==upsertSlots)throw new SemanticBudgetError();
   if(stamp!==fresh){stamp=fresh;lease={day:stamp,money:0,slots:0};}
   await this.metadata.transaction(async tx=>{let current=await tx.get(key);if(!current||current.day!==stamp)current={day:stamp,money:0,slots:0};if(!Number.isSafeInteger(current.money)||current.money<0||!Number.isSafeInteger(current.slots)||current.slots<0)throw new SemanticBudgetError();await tx.put(key,{day:stamp,money:current.money+microUSD,slots:current.slots+upsertSlots});});
  }
  return this.metadata.transaction(async tx=>{const record=await tx.get(key);const day=new Date(this.clock()).toISOString().slice(0,10);if(!record||record.day!==day||!Number.isSafeInteger(record.money)||!Number.isSafeInteger(record.slots)||record.money<cost||record.slots<slots)throw new SemanticBudgetError();await tx.put(key,{day,money:record.money-cost,slots:record.slots-slots});return true;});
 }
}
