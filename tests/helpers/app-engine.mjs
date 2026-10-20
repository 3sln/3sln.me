// Test-only fault hooks over the shared Node memory composition (app-engine.md §8).
import {createMemoryEngine,createRandom} from '../../packages/app/memory-providers.mjs';
import {injectFaults} from './chaos.mjs';
export {OWNER,OTHER,ownerActor,seededRandom,metadataStore} from '../../packages/app/memory-providers.mjs';

export function createTestEngine({seed=Number(process.env.CHAOS_SEED??1),random,faults={},wrap={},...options}={}){
 random??=createRandom(seed);
 const names=new Set([...Object.keys(faults),...Object.keys(wrap)]);
 const decorators=Object.fromEntries([...names].map(name=>[name,resource=>{let value=resource;if(faults[name])value=injectFaults(value,faults[name],{random});return wrap[name]?wrap[name](value):value;}]));
 return createMemoryEngine({...options,seed,random,wrap:decorators});
}
