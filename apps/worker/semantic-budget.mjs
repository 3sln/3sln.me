import {DurableObject} from 'cloudflare:workers';
import {GlobalSemanticBudget,SemanticBudgetError} from '../../packages/runtime/semantic-budget.mjs';
import {semanticBudgetPartition,semanticShard,SEMANTIC_LAYOUT} from '../../packages/runtime/semantic-routing.mjs';
export class SemanticBudgetObject extends DurableObject{
 constructor(ctx,env){super(ctx,env);this.env=env;}
 async reserveLease(input){
  if(input.partition!==await semanticShard(input.owner,SEMANTIC_LAYOUT.budgetShards))throw new SemanticBudgetError();const limits=semanticBudgetPartition(this.env,input.partition);
  await this.ctx.storage.transaction(async tx=>{const layout=await tx.get('layout');if(layout&&(layout.version!==SEMANTIC_LAYOUT.version||layout.count!==SEMANTIC_LAYOUT.budgetShards||layout.partition!==input.partition))throw new SemanticBudgetError();await tx.put('layout',{version:SEMANTIC_LAYOUT.version,count:SEMANTIC_LAYOUT.budgetShards,partition:input.partition});});
  const grant=await new GlobalSemanticBudget({metadata:this.ctx.storage,config:limits}).reserveLease(input);return {...grant,owner:input.owner,partition:input.partition,layoutVersion:SEMANTIC_LAYOUT.version};
 }
}
