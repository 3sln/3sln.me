# Message form browser security spike

Date: 2026-10-14. This is a private, controlled experiment, not an application feature or a change to the production renderer.

Run `node scripts/spikes/message-forms.mjs`. The latest run passed all 11 checks in Chrome **155.0.8059.80**. Evidence is written to `/tmp/3sln-message-forms/results.json` and `/tmp/3sln-message-forms/isolated-message.png`. Every HTTP request was intercepted by Playwright: approved `.example` fixtures received synthetic responses and every other request was aborted. No production service or external network was contacted.

## Observations

| Case | Observed result |
| --- | --- |
| Shadow DOM selectors | Message selectors did not style an outside button, but a fixed-position overlay covered the reader. Shadow DOM is not an isolation boundary. |
| Shadow resources | Images and CSS background URLs attempted requests. A document-defined font used by shadow text also attempted a request. The shadow-local font-face declaration did not request its font in this browser. |
| Native default `setHTML` | Removed forms, inputs, styles, scripts and event-handler attributes from the tested payload. |
| Native custom `setHTML` | A reviewed-looking element/attribute configuration retained forms, inputs and styles while still removing scripts and event handlers. Retained image sources could initiate requests; sanitization alone does not establish resource isolation. |
| Container APIs | `Element`, `ShadowRoot` and the template element exposed `setHTML`; `DocumentFragment` did not. |
| Template staging | `template.setHTML` populated `template.content`, with no template image/CSS requests before insertion in this case. A template is a practical staging container for obtaining a fragment. |
| Detached element staging | A detached `div.setHTML` with a custom configuration retaining `img[src]` initiated its image request before any policy traversal or live insertion. Detached trees alone do not prevent network activity. |
| Explicit cross-origin POST | `credentials: 'omit'` sent no seeded cookie and ignored the response's Set-Cookie. `redirect: 'error'` rejected a redirect without requesting its target. |
| Current renderer isolation | An empty iframe sandbox and the existing restrictive CSP blocked scripts, native form submission, images, CSS and fonts. |
| Experimental inline CSS isolation | An empty sandbox with inline styles allowed cosmetic CSS, clipped a fixed overlay to the iframe, and blocked remote CSS imports, images, fonts, backgrounds and native forms. This policy was used only in the fixture. |
| Staged controller | Template parsing, strict traversal, handler installation and fragment insertion preserved the trusted submit handler. Submission only prepared a bounded proposal; an outside trusted approval button performed the credentialless POST. Removing the handler and calling native `submit()` remained blocked by `form-action 'none'`. |

The final controller case is a **top-level CSP fixture**, not an implemented opaque-origin iframe and MessageChannel renderer. Playwright evaluation installs the fixture's trusted JavaScript independently of the page's `script-src` policy. The isolated-frame and controller cases provide separate evidence; combining their conclusions is not an end-to-end interactive-frame test. Native submit-event behavior inside a script-enabled sandbox without `allow-forms`, and a submit handler throwing before `preventDefault`, were not tested. Those remain implementation gates rather than assumed behavior.

The CSP `sandbox` directive in a meta element is not the sandbox enforcement mechanism; the iframe's `sandbox` attribute supplies that boundary. Likewise, fetch's credential policy does not control image, font or CSS requests.

## Recommended implementation boundary

Keep trusted review and approval controls outside author-controlled presentation. If rich cosmetic presentation is retained, put it in a bounded opaque-origin iframe with no `allow-same-origin` or `allow-forms`. Establish the resource and navigation policy before parsing any live content; permit inline cosmetic styles only after reviewing their interaction with the bounded frame. Author scripts must remain prohibited. Any required controller script must be separately trusted, and frame communication must bind the exact source, a private per-render capability and the current owner/render generation.

A native staging path can use `template.setHTML` with an explicit reviewed configuration, take `template.content`, traverse it under a strict control/data policy, and install trusted handlers before insertion. Do not call `setHTML` directly on a detached live element and assume subsequent traversal will run before resource fetching. Remove author actions, `formaction`, targets and resource-bearing attributes; reject unsupported controls, secret/password inputs, excessive fields and oversized values. Prevent native postbacks independently with CSP and sandbox, rather than relying solely on a handler always running successfully.

An approved action should show its destination and outgoing fields before transmission. Its transport must have bounded sizes/timeouts, explicit approved encodings, omitted credentials, no referrer and rejected redirects. Do not retry an indeterminate write automatically. Treat response bodies as untrusted data, not executable HTML. Trusted clicks and browser user activation are useful signals, not a universal proof of human intent. Notification heuristics and explicit safe handling of response links or new tabs belong to the subsequent design; this spike does not implement them.

## Non-native fallback proposal

If native `setHTML` is unavailable, a separate implementation can lazy-load an exact-pinned, reviewed DOMPurify dependency through a self-hosted, content-addressed `@3sln/js-tools` chunk. Use HTML-only configuration and `RETURN_DOM_FRAGMENT`, exclude SVG/MathML and unsupported controls, address DOM clobbering, then apply the same strict traversal and transport policies as the native path. A load failure must produce plain text or an explicit unavailable action, never raw unsafe HTML.

No fallback dependency was installed or tested here. The script's non-native template `innerHTML` branch is labeled an experimental baseline and is **not** an approved sanitization fallback.

## Limits and sign-off

This is single-version Chrome evidence with synthetic endpoints. It does not establish Firefox/Safari compatibility, future Sanitizer API behavior, real service CORS/cookie behavior, a final interactive-frame protocol or a production-safe sanitizer configuration. The application's content CSP, rendering behavior, dependencies, build outputs and release gates remain unchanged.

Reviewer: independent source/evidence review by `conversation_contact_review`; findings reconciled with the coordinator. Developer/human sign-off: **unsigned**. Outcome: provisional design evidence; feature implementation and broader validation remain separate work.
