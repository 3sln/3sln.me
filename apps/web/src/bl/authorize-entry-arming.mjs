// Delay-to-arm for approval controls on the provider entry page (adaptive-app-sign-in §9 "Activation tricks",
// §13.2; D4). Approval controls ("Continue as …", "Allow", "Sign out") act only after this document has been
// visible and focused for ARM_MS without interruption, and only for trusted events. Losing focus, hiding, resizing
// or showing a new decision surface disarms and restarts the delay, so a click aimed at an earlier control (or a
// double-click across a surface change) cannot land on a fresh approval. Approval controls never take default focus.
export const ARM_MS=600;
export function createArming({win=globalThis.window,doc=globalThis.document,delay=ARM_MS,notBefore=()=>0,onChange=()=>{},onReject=()=>{},setTimer=setTimeout,clearTimer=clearTimeout}={}){
 let armed=false,timer=null,disposed=false,width=win.innerWidth,pressedArmed=false;
 const ready=()=>doc.visibilityState!=='hidden'&&(typeof doc.hasFocus!=='function'||doc.hasFocus());
 const set=value=>{if(armed!==value){armed=value;onChange(value);}};
 const rearm=()=>{if(disposed)return;pressedArmed=false;set(false);clearTimer(timer);timer=null;if(ready())timer=setTimer(()=>{timer=null;if(ready())set(true);},Math.max(delay,notBefore()-Date.now()));};
 // Mobile URL-bar show/hide fires height-only resizes while scrolling; only a width change (or a large growth) re-arms.
 const resized=()=>{const w=win.innerWidth;if(w!==width){width=w;rearm();}};
 // A press must also START while armed: a pointerdown/keydown before arming that completes after it does not count.
 const pressed=event=>{if(event.isTrusted===true)pressedArmed=armed;};
 const events=[[doc,'pointerdown',pressed,true],[doc,'keydown',pressed,true],[win,'focus',rearm],[win,'blur',rearm],[win,'resize',resized],[win,'pageshow',rearm],[doc,'visibilitychange',rearm]];
 for(const [target,type,handler,capture] of events)target.addEventListener(type,handler,capture===true);
 rearm();
 return Object.freeze({
  get armed(){return armed;},
  /** A new decision surface was rendered: start the delay again. */
  reset:rearm,
  /** Wraps an approval handler: untrusted activations do nothing; early trusted ones only report `onReject`. */
  guard(action){return event=>{if(event?.isTrusted!==true)return;if(!armed||!pressedArmed){onReject();return;}pressedArmed=false;action(event);};},
  dispose(){disposed=true;clearTimer(timer);for(const [target,type,handler,capture] of events)target.removeEventListener(type,handler,capture===true);},
 });
}
