// Pointer arming against clickjacking (embed-islands §13.4, EIR-13). Pointer activation arms 400 ms after the
// island becomes visible in the top-level viewport and re-arms after any visibility change or resize (and, where
// IntersectionObserver v2 exists, occlusion). It needs pointerdown and click on the same armed control.
// Keyboard activation is not gated: an embedder cannot synthesize trusted key events. Untrusted events never act.
export const ARM_DELAY_MS=400;
export function createArming({win=globalThis.window,doc=globalThis.document,delay=ARM_DELAY_MS,onChange=()=>{}}={}){
  // A pointer must also have been over the island for the delay (IMPL-8): sliding an armed frame under the cursor does not count.
  let armed=false,visible=false,timer=null,pressed=null,enteredAt=null;const now=()=>win.performance?.now()??Date.now();
  const over=()=>{enteredAt??=now();},leave=()=>{enteredAt=null;};
  const set=value=>{if(armed!==value){armed=value;onChange(value);}};
  const rearm=()=>{set(false);clearTimeout(timer);if(visible&&doc.visibilityState!=='hidden')timer=setTimeout(()=>set(true),delay);};
  let observer=null;
  if(typeof win.IntersectionObserver==='function'){
    const callback=entries=>{const entry=entries.at(-1);visible=entry.isIntersecting&&entry.intersectionRatio>0&&entry.isVisible!==false;rearm();};
    try{observer=new win.IntersectionObserver(callback,{threshold:[0,0.5,1],trackVisibility:true,delay:100});}catch{observer=new win.IntersectionObserver(callback,{threshold:[0,0.5,1]});}
    observer.observe(doc.documentElement);
  }else{visible=true;rearm();}
  win.addEventListener('resize',rearm);doc.addEventListener('visibilitychange',rearm);doc.addEventListener('pointerover',over,true);doc.addEventListener('pointermove',over,true);doc.documentElement.addEventListener('pointerleave',leave);
  return Object.freeze({
    get armed(){return armed;},
    /** Event hooks for one control. `action(event)` runs only for a trusted keyboard click or an armed pointer click. */
    guard(action){return {
      pointerdown:event=>{pressed=armed&&event.isTrusted&&enteredAt!==null&&now()-enteredAt>=delay?event.currentTarget:null;},
      click:event=>{if(!event.isTrusted)return;const pointer=event.detail>0||Boolean(event.pointerType);if(pointer&&(!armed||pressed!==event.currentTarget))return;pressed=null;action(event);},
    };},
    dispose(){observer?.disconnect();clearTimeout(timer);win.removeEventListener('resize',rearm);doc.removeEventListener('visibilitychange',rearm);},
  });
}
