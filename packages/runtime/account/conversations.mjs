// AccountController slice 5, Conversations (docs/architecture/app-engine.md §12). The methods live in
// packages/conversations/runtime.mjs. `conversationIdentity` stays internal. Fanout (`conversationDrain`)
// runs outside the account gate: a recipient may submit to this source while holding its own gate.
// `invoke` also runs `conversationPublicIdentity` outside the gate once the signing key exists.
import {conversationMethods} from '../../conversations/runtime.mjs';
export const methods=conversationMethods;
export const rpc=Object.fromEntries(Object.keys(conversationMethods).filter(name=>name!=='conversationIdentity').map(name=>[name,name==='conversationDrain'?{gate:'none'}:{}]));
