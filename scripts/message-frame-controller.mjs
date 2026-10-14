// Standalone, content-addressed trusted controller for opaque message frames.
import {frameController} from '../apps/web/src/providers/message-frame.mjs';
import {normalizeMessageForm,messageFormFingerprint} from '../packages/messaging/form-policy.mjs';
frameController(normalizeMessageForm,messageFormFingerprint);
