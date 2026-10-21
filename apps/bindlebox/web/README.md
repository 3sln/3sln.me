# BB-B9 web client

Provisional local implementation, integrated 2026-10-21. Reviewer ___ Date ___ Outcome ___.

The Node and Worker shells mount the dodo/ngin client behind the existing default-off
`BINDLEBOX_ENABLED` flag. `npm run build:assets` emits the standalone browser bundle and
styles under `.output/bindlebox-public`. The owner API derives its actor from the shell's
live bearer verifier. Tokens remain in memory; drafts are scoped to the owner on this device.
The standalone page accepts an existing ordinary app credential. An SDK host can provide a
`token` function through the same-document `bindlebox-session` event.

Actions own client decisions, the dodo view renders snapshots, and providers own browser,
mailbox and optional incremental-authorization I/O. The UI supports en/es, light/dark and
320/390/1440 px. Features include drafts, original-recipient delivery counts, Retry missing,
finite SSE recovery/reset, Requests and Rejected rescue, contacts, saved Views, archive and
app-switch confirmations. Connectivity never sends a draft automatically. Lost send replies
retain the exact operation ID and text until the owner resolves them.

Conversation history transfers at most 40 entries per page (server maximum 100), with explicit
older/newer offsets and totals. The client retains only the selected page. Per-entry revision
history is capped at 20 and reports truncation. Server causal ordering still reads conversation
metadata before slicing; this work bounds browser transfer, not server sorting memory.

New conversations select stored contacts. The shell resolves their live identity and messaging
descriptor, verifies the stored contact meta signature, and constructs trusted participant
bindings. A changed/unavailable identity fails closed. Rejected body reads are explicit owner
queries; encrypted staged parts and signed body digests are checked before a maximum 64 KiB
text projection is returned. Quarantined items cannot be read. Peer content remains literal text.

Archive controls are enabled only when storage/key-holder ports are composed. Export provides
an exact `{generation,digest}` anchor; import requires it and explicit confirmation. Rejoin is
a separate confirmed action. The UI explains provider custody of encryption keys, checkpoint
timing and manual review of old unresolved sends. Production key-holder requirements and the
explicit disposable Node development holder are documented in `../worker/README.md`.

Run `npm run test:bindlebox:web` for client engine, transport and Chromium checks, including
bounded transfer of a 10,001-event history, drafts, partial delivery, Retry missing, SSE reset,
rescue and archive handoff across locales, sizes and themes. Integration regressions in
`tests/bindlebox/wave4-integration.test.mjs` additionally exercise actual shell mounting,
verified contact creation, encrypted Rejected reads and the archive security gates.

These are local implementation and harness/browser checks. External identity, delivery,
object-storage and key-holder conformance remain unverified. Production release remains disabled.
DEVLOG.md was not edited for this integration pass.
