// Bindle Messaging interop v1 identifiers, signature domains and limits (docs/spec/bindlebox.md §1, §5.2, §11).
// Placeholder identifiers under spec.bindle.example until publication authority is agreed.
const SPEC='https://spec.bindle.example/bindlebox/v1';
export const PROFILE=SPEC;
export const INGRESS_SLOT='https://spec.bindle.example/slots/messaging-ingress/v1';
export const MAILBOX_CONTRACT=`${SPEC}/contracts/mailbox`;
export const CONTACT_LINK_TYPE=`${SPEC}/links/contact`;
export const INTAKE_SLOT='https://spec.bindle.example/slots/public-message-intake/v1';
export const INTAKE_CONTRACT='https://spec.bindle.example/contracts/public-intake/v1';
export const DESCRIPTOR_MEDIA_TYPE='application/vnd.bindlebox.ingress+json';
export const INTAKE_MEDIA_TYPE='application/vnd.bindlebox.intake+json';
export const PURPOSES=Object.freeze({author:`${SPEC}/purposes/author`,receipt:`${SPEC}/purposes/receipt`,archive:`${SPEC}/purposes/archive`});
// Every signed object has its own prefix; none is a prefix of another or of any bindle-contact-* domain.
export const DOMAINS=Object.freeze({envelope:'bindlebox-envelope-v1\n',genesis:'bindlebox-genesis-v1\n',receipt:'bindlebox-receipt-v1\n',invitationResponse:'bindlebox-invitation-response-v1\n'});
export const PAIR_DOMAIN='bindlebox-pair-v1\n';
export const HELLO_INCARNATION='hello';
export const RECEIPT_PURPOSE='bindlebox-receipt-v1';
export const JWS_TYPES=Object.freeze({delegation:'bindle-key-delegation+jwt',provenance:'bindle-intake-provenance+jwt'});
export const KINDS=Object.freeze(['conversation-init','one-off','conversation-record']);
export const LINK_KINDS=Object.freeze(['conversation-init','one-off']);
export const RECORD_TYPES=Object.freeze(['message','edit','retract','peer-proposal','peer-response','peer-hello','rotate','rejoin','secret-share','leave','ingress']);
// §3.4 lists the lasting-effect records; secret-share is added because it installs a conversation secret (review B1-F, provisional).
export const STATUS_REQUIRED_RECORDS=Object.freeze(['edit','retract','rotate','leave','ingress','peer-proposal','peer-response','peer-hello','rejoin','secret-share']);
export const LIMITS=Object.freeze({maxParticipants:32,maxBodyBytes:1048576,maxEnvelopeBytes:65536,maxRequestBytes:1500000,maxBatchContexts:32,maxBatchBytes:524288,maxParents:8,maxPlaceholders:64,maxPendingMutations:64,maxGapExceptions:256,maxCounterJump:1024,maxPendingProposals:16,maxCertificateSeconds:86400,statusCacheMs:300000,descriptorCacheMs:3600000,clockSkewMs:60000,linkWindowMs:86400000,recordWindowMs:604800000,rotationOverlapMs:604800000,retentionMs:777600000,maxInvitationResponseBytes:8192,maxBootstrapMs:604800000,maxCompactChars:8192,maxSubjectPoints:200,maxTags:32,maxProfiles:16,maxVerifies:64,maxIntakeParts:16,maxHeaderChars:8192});
// §8.3 plus the RPC envelope codes of protocol §5. A status alone never carries classification or policy state.
export const ERRORS=Object.freeze({malformed:400,link_malformed:400,envelope_expired:400,counter_gap:400,clock_skew:400,link_invalid:401,author_unverifiable:401,author_required:403,not_authorized:403,audience_ineligible:403,participants_exceeded:403,record_forbidden:403,operation_conflict:409,incarnation_stale:409,invitation_used:409,invitation_expired:410,ingress_moved:410,too_large:413,record_unsupported:415,unsupported_profile:415,rate_limited:429,recipient_unavailable:503,recipient_storage_unavailable:503,audience_unavailable:503,invalid_args:400,unsupported_contract:400,unsupported_method:400});
