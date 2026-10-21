import {MailboxAction,operations,ownerOf} from './engine.mjs';
// A harmless dispatch probe, not a protocol endpoint, receipt or delivery claim.
export class MailboxPing extends MailboxAction {
 static operation='mailbox.ping';static deps=['clock'];
 run({clock}){return {owner:ownerOf(this.actor),now:clock.now(),status:'skeleton'};}
}
export const MAILBOX_OPERATIONS=operations(MailboxPing);
