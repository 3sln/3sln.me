import * as P from '../../bindlebox-protocol/index.mjs';
// Set before archive I/O; retained across failed imports so no traffic outruns restored control state.
export async function requireRestored(store,{envelope,replay=false}={}){
 const job=await store.get('archive/import');
 if(await store.get('archive/hold')||job&&!job.done&&job.phase===0)throw new P.ProtocolFault('recipient_storage_unavailable',{retryAfter:60});
 if(job&&envelope&&!P.admissibleAfterRestore(envelope,{checkpointAt:job.source.checkpointAt,imported:replay}))throw new P.ProtocolFault('not_authorized');
}
