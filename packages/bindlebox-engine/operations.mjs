import {CONTACT_OPERATIONS} from './domains/contacts.mjs';
import {RECEIVE_OPERATIONS} from './domains/receive.mjs';
import {INTAKE_OPERATIONS} from './domains/intake.mjs';
import {DELEGATION_OPERATIONS} from './domains/delegation.mjs';
import {SEND_OPERATIONS} from './domains/send.mjs';
import {OUTBOX_OPERATIONS} from './domains/outbox.mjs';
import {EVENT_OPERATIONS} from './domains/events.mjs';
import {MailboxAction,operations,ownerOf} from './engine.mjs';
// A harmless dispatch probe, not a protocol endpoint, receipt or delivery claim.
export class MailboxPing extends MailboxAction {
 static operation='mailbox.ping';static deps=['clock'];
 run({clock}){return {owner:ownerOf(this.actor),now:clock.now(),status:'skeleton'};}
}
export const MAILBOX_OPERATIONS=operations(MailboxPing,...CONTACT_OPERATIONS,...RECEIVE_OPERATIONS,...INTAKE_OPERATIONS,...DELEGATION_OPERATIONS,...SEND_OPERATIONS,...OUTBOX_OPERATIONS,...EVENT_OPERATIONS);
