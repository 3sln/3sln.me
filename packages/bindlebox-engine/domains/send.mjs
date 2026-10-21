// BB-B3 app-local submission accepts prepared, signed per-recipient envelopes from the compose domain.
// Signing/stream-head allocation belongs to conversations; network delivery belongs to outbox.
import {MailboxAction} from '../engine.mjs';
export class SendMessage extends MailboxAction {
 static operation='send.submit';static deps=['outbox'];static changes='outbox-changed';
 run({outbox}){return outbox.submit(this.input);}
}
export const SEND_OPERATIONS=[SendMessage];
