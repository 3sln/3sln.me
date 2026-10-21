// BRIDGE public email bridge (provider side). See engine.mjs for the invariants; worker.mjs and node.mjs are the
// adapters; worker-object.mjs (Cloudflare only) is imported directly by apps/worker/index.mjs.
export * from './engine.mjs';
export {MIME_LIMITS,BridgeMimeError,AUTOMATION_HINTS,readBounded,parseEmail,mailbox,headerMailbox,automationHints,authResults,ingressFingerprint} from './mime.mjs';
export {REPLY_SUBJECT,FOLLOWUP_SUBJECT,invariantText,followupText,buildReply,buildFollowup,RESPONSE_HEADERS,FOLLOWUP_HEADERS} from './reply.mjs';
export {handleEmail,workerEdgePorts,workerOwnerPorts,runOwnerOperation,runSenderMethod,bridgeObjectName,SENDER_SHARDS} from './worker.mjs';
export {nodeEmailBridge} from './node.mjs';
