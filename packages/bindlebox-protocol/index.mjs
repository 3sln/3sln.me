// Bindle Messaging interop v1 protocol library (docs/spec/bindlebox.md; package name pending the app rename).
// Pure, deterministic, dependency-free beyond Web Crypto: no storage, network, clock or randomness of its own.
// Engine admission order (architecture §11, cheapest refusal first):
//  1. edge: parseCredential, then the edge index (edgeKey/tokenDigest, checkPairGate; link index for BindleLink);
//  2. framing and schema: parseDelivery / parseMulticast (validateEnvelope, body and secret digests);
//  3. checkCredentialKind, checkLinkRecipient (links), checkWindow;
//  4. author: verifyEnvelope (delegation, proof, status where §3.4 requires it, ingress bindings, introductions);
//  5. owner transaction: replayKey + replayDecision, admitCounter, placeholderPlan/queueMutation, then
//     receiptPayload + signReceipt with the occupant's receipt-purpose delegate key.
// Senders: signGenesis / signEnvelope / signInvitationResponse, encodeDelivery / encodeMulticast, then
// classifyFailure, parseMulticastResults + multicastOutcome and verifyReceipt (never throws; unknown on any doubt).
export * from './constants.mjs';
export {ProtocolFault,strictJSON,jcs,sha256,base64url,fromBase64url,sameValue} from './encoding.mjs';
export {parseCompact,parseDelegation,verifyDelegation,thumbprint,jktOf,importVerifyKey,encodeDelegation} from './certificate.mjs';
export {clampLimits,validatePrincipal,validateAuthor,validateBinding,validateDescriptor,validateGenesis,validateEnvelope,validateInvitationResponse,validateReceipt,recordShape,semanticObject,payloadDigest,eventId,genesisDigest,signingInput,contentDescriptor,signEnvelope,signGenesis,signInvitationResponse,signReceipt,receiptPayload} from './envelope.mjs';
export {statusRequired,checkStatus,quarantined,authenticate,verifyEnvelope,precheckInvitationResponse,verifyInvitationResponse,verifyReceipt} from './verify.mjs';
export {pairToken,secretDigest,parseCredential,formatCredential,credentialScheme,checkCredentialKind,checkLinkRecipient,edgeKey,tokenDigest,checkPairGate,streamState,frontier,admitCounter,equivocates,placeholderPlan,queueMutation,checkMutationAuthor,freezeAudience,mutationAudience} from './conversation.mjs';
export {replayKey,operationKey,invitationKey,checkWindow,replayDecision,invitationDecision,retainUntil,admissibleAfterRestore} from './replay.mjs';
export {OBLIGATION_STATES,RETRY_REASONS,REJECT_CLASSES,retryAfterMs,classifyFailure,applyReceipt,aggregate,parseMulticastResults,multicastOutcome} from './outcomes.mjs';
export {multipartBoundary,parseDelivery,encodeDelivery,parseMulticast,encodeMulticast,parseRPC,rpcRequest,intakeDigest,parseProvenance,verifyProvenance} from './wire.mjs';
