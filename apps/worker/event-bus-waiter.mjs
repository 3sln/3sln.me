// EV-2 long-poll wait object (docs/spec/events.md §4.2, §9; packages/events/waiter.mjs). One instance per account,
// named busWaiterName(owner), holds that account's admitted long-polls in memory so the AccountObject never holds a
// request and can idle. It stores nothing; the account object rings it on publish and revocation through the
// EVENT_BUS_WAITS binding. Reachable only through that internal binding.
import {DurableObject} from 'cloudflare:workers';
import {BusWaiterCore} from '../../packages/events/waiter.mjs';

export class EventBusWaiter extends DurableObject{
 constructor(ctx,env){super(ctx,env);this.core=new BusWaiterCore();}
 wait(input){return this.core.wait(input);}
 advance(input){return this.core.advance(input);}
 revoke(input){return this.core.revoke(input);}
}
