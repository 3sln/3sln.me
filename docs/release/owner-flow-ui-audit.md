# Owner-flow UI security review

Date: 2026-10-12. Reviewer: independent contribution/UI audit agent. Scope: MCP consent and connected-app flows, conversation actions/rendering, BrowserState/API provider boundaries and offline/reconnect behavior. The reviewer did not author the original UI. Human reviewer: ___ / date: ___ / outcome: ___. Production approval remains separate.

## Findings and reconciliation

| Finding | Resolution and evidence |
| --- | --- |
| Inner MCP read catches could hide session expiry; non-JSON 401 responses lost their HTTP status. Private search/billing/notice fields also survived the initial new-flow expiry clear. | Coordinator moved expiry handling into the OwnerFlow API boundary, preserved HTTP status on parse errors and cleared private projections. Regression verifies the real parse path with an HTML 401 and confirms a late old-owner 401 cannot sign out a newer owner. |
| Callback validation compared only the first value of each registered query key. Extra duplicate routing parameters could survive while retaining the reviewed first value. | Compare every registered query value, permit only singleton generated OAuth fields, reject unknown extra fields and simultaneous code/error results. Tests reject duplicate tenant/code values and preserve intentionally registered repeated query values. |
| Concurrent same-owner conversation reads could overwrite newer thread selection; identity comparisons used only room IDs. | Conversation open uses a ticket in the existing BrowserState provider. Late results cannot publish after a newer open. Receipt/history and refresh updates use source origin, source owner and room ID, preserving the latest selection. |
| Equal room IDs from different origins reused the composer key and selected marker. One permission lookup matched member owner ID without origin. | UI now uses source-qualified room identity for draft keys/selection and origin-qualified member lookup. DOM reconciliation verifies drafts clear on such a switch and an equal owner ID at another origin does not display local send/invite permission. Server authorization remains authoritative. |
| A mutation completing after an offline generation change could leave the global busy reservation stuck. | Coordinator resets busy state at network/account replacement boundaries. A test dispatches the actual NetworkChanged actions around an in-flight post and verifies reconnect remains usable and the old result stays suppressed. |
| An older reconnect's session response could replace an owner established by a newer reconnect. | Reproduced with actual NetworkChanged actions. Coordinator added generation checks around reconnect/session refresh, owner-qualified account refresh and suppression of stale errors. The previously failing regression now passes. |

Changes use existing ngin Actions, the BrowserState provider and dodo reconciliation. No parallel mutable store or custom observer lifecycle was introduced.

## Behaviors checked

The focused fixture exercises real stack dispatch/provider leases. It verifies no API or clipboard access while offline, explicit confirmation before copying shared access, suppression of late capability responses after account replacement, exclusion of duplicate in-flight posts, and reuse of the original event ID after an ambiguous post failure. Shared access secrets are copied directly and are not published into browser state by these flows.

Existing DOM coverage also renders hostile app labels, conversation content and author strings as inert text; starts OAuth permissions unchecked; distinguishes partial delivery from success; and labels bearer authors unverified. Conversation composition explicitly says messages go to everyone. The shared-secret disclosure explains that sharing access does not add a recipient and prior copies cannot be recalled. UI permission checks improve presentation; server checks determine authority.

The audit does not prove cross-host conversation delivery, upstream OAuth-provider conformance, clipboard confidentiality after an authorized copy, or delivery to every recipient from a successful local acceptance. Actual mobile/Chrome behavior and full suite evidence belong to the coordinator's separate browser run; this agent did not rebuild assets or run a concurrent browser server.

## Verification

Owned regressions: [owner-flow-audit.mjs](../../tests/browser/owner-flow-audit.mjs). Companion existing coverage: [mcp-conversations.mjs](../../tests/browser/mcp-conversations.mjs).

Final reconciled focused run: **15/15 passed** (11 new audit regressions and four existing DOM cases), including the previously failing reconnect race. Command: `node --experimental-loader ./tests/browser/loader.mjs --test tests/browser/owner-flow-audit.mjs tests/browser/mcp-conversations.mjs`. `git diff --check` also passed. No production readiness or human sign-off is implied.
