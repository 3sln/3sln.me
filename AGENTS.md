# Project coordination

Use DEVLOG.md as the decision/progress ledger. Keep major design decisions linked to reviewer/date/outcome sign-off places; leave unsigned decisions provisional, never fabricate approval. Continue reversible development under the user's authorization.

The coordinator may delegate protocol/security/architecture/frontend/backend/testing work to specialized agents. Heavy decisions should receive deep reasoning and cross-review. Assign nonoverlapping write ownership, agree interfaces first, and reconcile spec/implementation differences in DEVLOG.md before reporting completion.

Use the 3sln stack for frontend work. Vendored snapshots include source provenance and MIT licenses. Read the actual APIs before changing stack integration.

The primary app uses real identity verification and durable local Worker/Node adapters; production release remains disabled. A separate loopback-only in-memory demonstration is retained under dev:demo. Never expose its demo routes as production APIs. Distinguish implemented local behavior, configured external services and production-verified capabilities; do not infer delivery or provider conformance from a populated key or screenshot. Follow production gates in docs/spec/security.md and DEVLOG.md.

Run `npm test` for SDK/core/server changes. Browser behavior additionally needs DOM/browser verification. Record environment limitations honestly. Keep examples under reserved .example domains until publication authority is agreed.
