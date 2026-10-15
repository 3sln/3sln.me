// Leader election within the embed partition (embed-islands §5.1–5.4). Web Locks give exclusivity; terms from
// IndexedDB fence stale leaders; a visible follower that misses three heartbeats steals the lock (rate-limited),
// so a frozen leader is replaced and, when it thaws, its stale-term messages are dropped. No SharedWorker.
// Without Web Locks or BroadcastChannel every island is its own leader (§5.4). Leadership is never reported
// outside the embed origin. All dependencies are injected so the state machine is testable with fakes.
import {validateBus} from './bus.mjs';
export const ELECTION={heartbeatMs:15000,missedBeats:3,stealCooldownMs:60000};

export function createElection({name,instance,locks,openBus,nextTerm,lead,demote=()=>{},receive=()=>{},isVisible=()=>true,clock=()=>Date.now(),setTimer=setTimeout,clearTimer=clearTimeout,heartbeatMs=ELECTION.heartbeatMs,missedBeats=ELECTION.missedBeats,stealCooldownMs=ELECTION.stealCooldownMs}){
  const solo=!locks?.request||typeof openBus!=='function';
  let bus=null,leading=null,queued=null,highest=0,seen=0,seq=0,lastBeat=clock(),lastSteal=-Infinity,stopped=true,timer=null,epoch=0;
  const post=message=>{if(!bus)return;try{bus.postMessage(message);}catch{}};
  function demoteNow(){if(!leading)return;const current=leading;leading=null;current.controller.abort();current.release();demote();}
  async function hold(run){
    const term=await nextTerm();if(stopped||run!==epoch)return;
    highest=Math.max(highest,term);seen=0;seq=0;lastBeat=clock();
    const controller=new AbortController();let release;const held=new Promise(resolve=>{release=resolve;});
    leading={term,controller,release};post({type:'term',term,instance});
    Promise.resolve().then(()=>lead({term,signal:controller.signal})).catch(()=>{});
    await held;
  }
  function request(steal=false){
    if(stopped)return;const run=epoch;
    if(solo){hold(run);return;}
    const ticket={controller:new AbortController(),granted:false};if(!steal)queued=ticket;
    locks.request(name,steal?{mode:'exclusive',steal:true}:{mode:'exclusive',signal:ticket.controller.signal},()=>{ticket.granted=true;if(queued===ticket)queued=null;return hold(run);})
      .then(()=>{if(run===epoch&&!stopped&&!leading&&!queued)request();},error=>{
        // Granted then rejected: the lock was stolen (we were frozen or throttled). Not granted: we aborted it to steal.
        if(error?.name!=='AbortError'){if(queued===ticket)queued=null;return;}
        if(ticket.granted){demoteNow();if(run===epoch&&!stopped&&!queued)request();}
      });
  }
  function tick(){
    if(stopped)return;
    if(leading)post({type:'heartbeat',term:leading.term,seq:++seq});
    else if(!solo&&isVisible()&&clock()-lastBeat>missedBeats*heartbeatMs&&clock()-lastSteal>=stealCooldownMs){lastSteal=clock();const ticket=queued;queued=null;ticket?.controller.abort();request(true);}
    timer=setTimer(tick,heartbeatMs);
  }
  function onMessage(event){
    const message=validateBus(event?.data);if(!message||stopped)return;
    if(['term','heartbeat','snapshot'].includes(message.type)){
      if(message.term<highest)return; // stale leader (thawed after a steal)
      if(message.term>highest||message.type==='term'){highest=message.term;seen=0;}
      if(leading&&message.term>leading.term)demoteNow();
      if(message.type!=='term'){if(message.seq<=seen)return;seen=message.seq;}
      lastBeat=clock();
    }
    if(message.type==='resign'){if(message.term===highest)lastBeat=clock();return;}
    receive(message);
  }
  return Object.freeze({
    get leading(){return Boolean(leading);},
    get term(){return leading?.term??null;},
    get solo(){return solo;},
    start(){if(!stopped)return;stopped=false;epoch++;lastBeat=clock();if(!solo){bus=openBus();bus.onmessage=onMessage;}request();timer=setTimer(tick,heartbeatMs);},
    /** Same teardown in every state, leader or follower (EIR-4). */
    stop(){if(stopped)return;if(leading)post({type:'resign',term:leading.term});stopped=true;epoch++;demoteNow();queued?.controller.abort();queued=null;clearTimer(timer);timer=null;try{bus?.close();}catch{}bus=null;},
    /** Leader-only snapshot fan-out, fenced by term and sequence. */
    publish(payload){if(!leading||leading.controller.signal.aborted)return false;post({type:'snapshot',term:leading.term,seq:++seq,...payload});return true;},
    /** Follower and peer hints (hello, credentials-changed, forget). */
    send(message){if(!stopped)post(message);},
  });
}
