import {createBridgeProvider} from '../../../packages/bindlebox-engine/domains/bridge.mjs';
import {createMailboxEngine,operate} from '../../../packages/bindlebox-engine/engine.mjs';
import {MAILBOX_OPERATIONS} from '../../../packages/bindlebox-engine/operations.mjs';
import {ContactsDomain,ReceiveDomain} from '../../../packages/bindlebox-engine/store/mailbox.mjs';
import {createOutboxProvider} from '../../../packages/bindlebox-engine/domains/outbox.mjs';
import {SHELL_OPERATIONS,authorizeSend} from './operations.mjs';
import {INTEGRATION_OPERATIONS} from './integration.mjs';
import {organizationProviders} from '../../../packages/bindlebox-engine/domains/views.mjs';
import {ConversationsDomain,withConversations} from '../../../packages/bindlebox-engine/domains/conversations.mjs';
import {fault} from '../../../packages/bindlebox-engine/faults.mjs';
export const enabled=value=>value===true||value==='true';
export function createMailbox({store,ports={},BINDLEBOX_ENABLED=false,clock={now:()=>Date.now()},random={uuid:()=>crypto.randomUUID(),bytes:n=>crypto.getRandomValues(new Uint8Array(n))},audit={record:()=>{}},outboxOptions={}}){
 const on=enabled(BINDLEBOX_ENABLED),registry={...MAILBOX_OPERATIONS,...SHELL_OPERATIONS,...INTEGRATION_OPERATIONS},conversationAuthority=withConversations(authorizeSend);
 const engine=createMailboxEngine({providers:{clock,random,audit,mailboxStore:store,...organizationProviders({BINDLEBOX_ENABLED:on,classifier:ports.classifier??null}),conversations:ConversationsDomain,contacts:ContactsDomain,receive:ReceiveDomain,bridge:createBridgeProvider({BINDLEBOX_ENABLED:on}),directory:ports.directory??{resolveKey:async()=>null,status:async()=>{fault('author_unverifiable','Directory unavailable.',503);}},providerLink:ports.providerLink??null,delegateKeys:ports.delegateKeys??null,userStorage:ports.userStorage??null,egress:ports.egress??{fetch:async()=>{throw new Error('Delivery transport unavailable');}},outbox:createOutboxProvider({...outboxOptions,renewDelegation:async()=>{await ports.delegateKeys?.renew();return (await ports.delegateKeys?.current())?.delegation;},BINDLEBOX_ENABLED:on,authorize:async(tx,task,owner)=>(await tx.get('shell:authorization'))?.active===true&&conversationAuthority(tx,task,owner)})}});
 const run=async(owner,name,params={})=>{if(!on)fault('not_found','Messaging is disabled.',404);if(!Object.hasOwn(registry,name))fault('not_found','Operation unavailable.',404);return operate(engine,new registry[name]({...params,actor:{kind:['receive.deliver','shell.public-intake','conversations.receive','conversations.respond'].includes(name)?'ingress':'owner',owner}}));};
 return {engine,run,async open(owner){await run(owner,'shell.bind');return this;},async provision(owner,{receive,authorization}={}){await this.open(owner);if(receive)await run(owner,'receive.configure',{input:receive});if(authorization)await run(owner,'shell.authorization',{input:authorization});},async alarm(){if(!on)return;const owner=await store.get('owner');if(!owner)return;if(await store.get('config')&&(await store.get('shell:authorization'))?.active)await run(owner,'conversations.drain');const result=await run(owner,'outbox.drain');const renewal=await store.get('shell:renewal');if(renewal?.at<=clock.now())await run(owner,'shell.delegation-renew');return result;},dispose:()=>engine.dispose()};
}
