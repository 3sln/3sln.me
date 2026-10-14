# Message content and motion review

Date: 2026-10-14. Independent source/design review. Human approval remains blank.

## Normative draft assessment

Reviewed [message-content.md](../spec/message-content.md) against the current content validator, conservative renderer, form policy, prepared broker and retained presentation code. The draft defines observable effects and authority boundaries without requiring a particular rendering library, browser API, SDK or RPC. No structural blocker was found in that separation.

The text/HTML requirements preserve accepted bytes and distinguish presentation from delivery permission. Other allowed types remain opaque absent an explicit supported profile. The project-private JSON archive's entry count, decoded-size bounds, path restrictions and text entrypoint match the reference validator; this is not ZIP/WARC/MHTML interoperability, and bundled image validation is not image decoding or presentation support. Transport ceilings can be smaller than the archive envelope ceiling.

Original signatures do not authenticate local submission results. Exact reviewed fields, current source authority, no ambient credentials on dispatch, bounded prepared capabilities and durable unknown outcomes remain necessary. Status links are navigation proposals; HTTP errors cannot become successful responses. The deferred `_blank` form/viewer policy is reflected accurately: unsupported authored forms remain inert and an HTML response requesting a separate viewer records status without changing the current body.

The motion rules appropriately require recipient control, default-enabled preference subject to reduced-motion policy, a finite host-selected duration and static fallback where a meaningful final state does not exist. **Five seconds is a proposed 3sln policy, not a Bindle wire-format constant or a universal browser limit.** The episode must follow the actual displayed content, not merely the latest metadata/history counter. A status-only result, routine render or preference toggle must not replenish the same display's allowance. Source digest and actual selected content revision are relevant; owner changes must never reuse another owner's state.

## Renderer implementation review gates

A timeout and a snapshot of current animations are insufficient by themselves. CSS can create later effects through hover, focus, delayed rules and display changes. The Web Animations API exposes effects currently associated with a document or shadow root; stopping those objects does not remove the CSS capable of producing successors. [Web Animations specification](https://drafts.csswg.org/web-animations-1/#extensions-to-the-documentorshadowroot-interface-mixin), [CSS Animations specification](https://drafts.csswg.org/css-animations-1/#animations).

Appending an ordinary `animation: none !important` stylesheet is also not automatically authoritative. CSS cascade origin, important declarations, inline styles and layer ordering must be accounted for. Removing or neutralizing author motion-producing declarations before static rendering is a viable fallback if the implementation cannot preserve final styling safely. An inaccessible or unsupported stylesheet must not silently retain motion. [CSS cascade sorting and important declarations](https://drafts.csswg.org/css-cascade-5/#cascade-sort).

Finite finishing is best-effort: effects with infinite duration or an unresolvable end cannot be forced to a universal last frame. Supported effects must stop, and future ones must remain disabled. Removing CSS animations after an attempted finish may also remove their filled appearance; static fallback is permitted, but the client must not claim faithful final-frame preservation. [Web Animations finishing semantics](https://drafts.csswg.org/web-animations-1/#finishing-an-animation).

| Area | Required regression |
| --- | --- |
| Timing | Enabled by default; host deadline independent of author delay, duration and iteration count; exhausted/disabled before first exposure gives no initial moving frame. |
| Cascade | Inline important declarations, earlier important layers, nested media/supports/layer rules, pseudo-elements, multiple animations and transitions. |
| Future effects | Hover/focus and delayed animation after cutoff cannot restart motion; static controls remain usable. |
| Episode | Same-source remount, metadata/history-only update and preference toggle do not replenish allowance; owner/message changes are fenced. |
| Lifecycle | Hidden/background time consumes allowance; resume applies exhaustion before visible motion; disposal stops listeners and timers. |
| Preference | Stored browser choice is a bounded nonsecret boolean; OS reduced motion dominates enabled preference and applies to an already displayed message. |
| Boundaries | No author scripts, new resource fetches, relaxed frame authority or altered signed bytes; animated media remains blocked or separately constrained. |

At this checkpoint the renderer motion patch is still under development. These are source and browser gates, not a claim that the new motion controls already conform. The previously exercised local submission pipeline and the normative document do not substitute for those tests. Firefox/WebKit and animated-media control must not be inferred from a Chromium CSS-animation result.

## Sign-off

| Human reviewer | Date | Decision |
| --- | --- | --- |
| | | |

## Implementation source checkpoint

The developing 3sln renderer uses a five-second deadline and keeps per-owner/message/displayed-source motion state separate from the app's authority generation. Review found and the author corrected reconnect replenishment, lack of hide/resume handling, and persistence errors preventing a user's immediate stop request. Hiding/pagehide conservatively ends the allowance; an OS reduced-motion change also stops the active frame. A failed local-storage write now leaves the in-memory choice effective while reporting the persistence limitation.

Cutoff attempts to finish supported finite effects and retain static styling, then cancels effects and recursively removes CSS animation/transition declarations and keyframes, including nested rules and inline declarations. Uninspectable sheets are removed. This makes the cutoff permanent against later hover/pseudo/layer activation; it does not merely poll the currently running set or append an overridable stylesheet. The author found in actual Chromium that document-level animation enumeration omitted the closed message shadow root, and changed enumeration to the root itself. No broad document-level enumeration claim is made for that boundary.

The independent [preference/episode audit](../../tests/browser/message-motion-audit.mjs) passes **4/4**, `/tmp/bindle-message-motion-audit.log`: unavailable storage cannot prevent stopping motion; a retained status and reconnect do not replenish an exhausted source; reduced-motion/toggle behavior cannot revive the same episode; and hidden-to-visible policy preserves the stop. This uses a controlled frame-port fixture to isolate trusted policy and does not execute a browser CSS engine. The author's actual closed-root CSS/pseudo/layer/delayed/hover test remains the separate browser gate at this checkpoint. No human signoff is implied.

Final independent browser rerun: [opaque-frame tests](../../tests/e2e/message-frame.test.mjs) pass **2/2**, `/tmp/bindle-message-motion-independent-browser.log` (8.7 seconds). These run the actual external controller under its CSP with native sanitization and forced local fallback for ordinary forms; the motion fixture confirms initially active closed-root effects including a pseudo-element, the real five-second cutoff, recursive live CSSOM removal, post-cutoff hover and attempted re-enable, an expired-deadline remount, explicit stop, and reduced-motion initial rendering. Browser-request attempts denied by CSP are distinguished from successful external network requests; fixture server logs contain only the local harness assets. Public application assets were not rebuilt by this review.

The tested Chromium implementation has no remaining motion-authority blocker in this slice. This result does not claim that every animated format or final visual state is preserved, that document enumeration reaches closed roots, or that other browser engines have been verified. The narrower public promise remains permanent static fallback, recipient stop precedence and host-controlled bounded exposure. Operator/production release review and human signoff remain separate.
