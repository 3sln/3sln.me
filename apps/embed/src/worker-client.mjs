// Document-side proxy to the island worker (EI-13). Request/response by id, plus worker events. The worker is
// created through the bindle-embed Trusted Types policy and only after `ready`.
export function createWorkerClient(worker){
  let next=0;const pending=new Map(),listeners=new Set();
  worker.onmessage=event=>{const data=event.data;if(data&&Number.isInteger(data.id)){const settle=pending.get(data.id);pending.delete(data.id);settle?.(data);}else if(data?.event)for(const listener of listeners)listener(data);};
  worker.onerror=()=>{for(const settle of pending.values())settle({ok:false});pending.clear();};
  return Object.freeze({
    call:(op,args)=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,data=>data.ok?resolve(data.value):reject(new Error('unavailable')));worker.postMessage({id,op,args});}),
    notify:(op,args)=>worker.postMessage({op,args}),
    on:listener=>{listeners.add(listener);},
    terminate:()=>worker.terminate(),
  });
}
