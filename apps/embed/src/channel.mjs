// The island end of the nonce-bound MessageChannel (profile §5, embed-islands §4). Inbound messages are
// presentation inputs and public flow inputs only, validated against the part's schema; state messages are
// last-value-wins and applied on the next task; other types are limited to 10/s; three violations within a
// minute stop the island reading the port. There are no error replies. Outbound messages pass the part's exact
// events contract before they leave (the element is not a boundary: embedder script can read the port).
import {validateInbound,validateOutbound,STATE_TYPES,UNLIMITED_TYPES,LIMITS} from '../../../packages/sdk/src/islands-protocol.mjs';

export function createChannel(port,{part,version,issuer,origins,onState,onForget,clock=()=>Date.now(),defer=fn=>setTimeout(fn,0)}){
  let closed=false,violations=[],scheduled=false;const pending=new Map(),window=[];
  const stop=()=>{closed=true;port.onmessage=null;try{port.close();}catch{}};
  function violation(){const now=clock();violations=violations.filter(at=>now-at<LIMITS.violationWindowMs);violations.push(now);if(violations.length>=LIMITS.violations)stop();}
  function limited(){const now=clock();while(window.length&&now-window[0]>=1000)window.shift();if(window.length>=LIMITS.ratePerSecond)return true;window.push(now);return false;}
  function flush(){scheduled=false;if(closed)return;const batch=[...pending.values()];pending.clear();for(const message of batch)onState(message);}
  port.onmessage=event=>{
    if(closed)return;const data=event.data;
    if(event.ports?.length){violation();return;}
    const type=typeof data?.type==='string'?data.type:'';
    if(!UNLIMITED_TYPES.includes(type)&&limited())return;
    const message=validateInbound(data,{part,issuer,origins});
    if(!message){violation();return;}
    if(message.type==='forget'){onForget(message);return;}
    if(STATE_TYPES.includes(message.type)){pending.set(message.type,message);if(!scheduled){scheduled=true;defer(flush);}}
  };
  port.start?.();
  return Object.freeze({
    get closed(){return closed;},
    /** Sends only what the part's contract allows; anything else is dropped here and never reaches the port. */
    send(message){if(closed)return false;const valid=validateOutbound(message,{part,version,issuer});if(!valid)return false;port.postMessage({...valid});return true;},
    close:stop,
  });
}
