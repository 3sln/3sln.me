// A public, nonblocking availability hint. This document never boots the app.
const messages=/*__LANDING_MESSAGES__*/null;
const fragment=new URLSearchParams(location.hash.slice(1));
if(['token','request','beam-invite'].some(key=>fragment.has(key)))location.replace('/console'+location.search+location.hash);
else void (async()=>{
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);let response;
 try{
  response=await fetch('/api/signup/status',{credentials:'omit',redirect:'error',cache:'default',referrerPolicy:'no-referrer',headers:{Accept:'application/json'},signal:controller.signal});
  if(!response.ok||response.headers.get('content-type')?.split(';')[0].trim()!=='application/json'||Number(response.headers.get('content-length'))>4096)return;
  const reader=response.body?.getReader();if(!reader)return;const decoder=new TextDecoder('utf-8',{fatal:true});let text='',bytes=0;
  for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>4096){await reader.cancel();return;}text+=decoder.decode(next.value,{stream:true});}text+=decoder.decode();
  const status=JSON.parse(text);if(typeof status.freeSignupOpen!=='boolean'||typeof status.paidSignupOpen!=='boolean'||status.reason==='unavailable'||status.freeSignupOpen&&status.signupEnabled!==false)return;
  const card=document.querySelector('[data-signup-panel]'),signup=card?.querySelector('[data-signup-action]');if(!card||!signup)return;
  const locale=document.documentElement.lang==='es'?'es':'en',copy=messages[locale];
  signup.hidden=true;if(status.signupEnabled===false||status.reason==='disabled'){for(const node of document.querySelectorAll('[data-public-signup]'))node.hidden=true;}const notice=document.createElement('p');notice.className='security-note';notice.setAttribute('role','status');notice.textContent=status.paidSignupOpen?copy.freeClosed:status.signupEnabled===false||status.reason==='disabled'?copy.disabled:copy.closed;signup.before(notice);
  const link=(label,query)=>{const node=document.createElement('a');node.className='button secondary full';node.href='/console?'+query+(locale==='es'?'&lang=es':'');node.textContent=label;signup.before(node);};
  if(status.signupEnabled!==false&&status.paidSignupOpen)link(copy.paid,'signup&plan=paid');if(status.signupEnabled!==false&&status.reason!=='disabled'&&status.waitlistEnabled===true)link(copy.waitlist,'waitlist');
 }catch{/* Native console links remain usable when availability is unknown. */}
 finally{clearTimeout(timer);try{await response?.body?.cancel();}catch{}}
})();
