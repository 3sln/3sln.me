// #avatar (profile §6, embed-islands §6). Non-interactive; sends nothing after `ready`. The picture fills
// min(100vw,100vh), centred, as large as fits. Every state renders exactly one worker raster (re-encoded avatar,
// the subject's monogram, or a transparent tile without a subject) through one off-screen decode and swap.
import {h,defined} from './dom.mjs';
export function avatarPart({model,worker,swap,nextTicket}){
  let started=false;
  const update=async()=>{if(!started)return;const token=nextTicket();try{const client=await worker();await swap(await client.call('render',{subjects:[model.subject],bucket:model.bucket}),token);}catch{}};
  return Object.freeze({
    view:()=>h('img').classes('avatar').attrs(defined({alt:'',draggable:'false',src:model.tiles[0]??null})),
    async start(){started=true;try{(await worker()).on(event=>{if(event.event==='views')update();});}catch{}update();},
    update,
  });
}
