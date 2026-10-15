# UI polish review

Date: 2026-10-14. Scope: the rendered UI. That covers `apps/web/styles.css`, `apps/web/src/ui/**`, the navigation icon names in `apps/web/src/shared/portal-modules.mjs`, and the island part styles in `apps/embed/styles/parts.css`. Two Spanish catalogue keys were also added to `packages/i18n/catalogues.mjs` for the redeemed-claim state, at the coordinator's request.

No product behaviour, API, `bl/**` or `providers/**` code changed.

One independent agent ran the UX/accessibility review. That is an agent review, not human sign-off.

Human reviewer: __________ Date: __________ Outcome: __________.

## Method

The local Worker was booted through `scripts/run-browser-checks.mjs`, with a real password account, a contact link and a boot claim. Playwright then captured 28 screens at 320, 390, 768 and 1280 px, in light and dark, in English and Spanish. A horizontal-overflow probe ran on every capture.

- Before: `artifacts/browser/polish-before/`.
- After: `artifacts/browser/polish-after/`.
- Overflow reports: `overflow-report*.json` in each directory.

The authorization consent and entry pages were checked through the screenshots of the existing e2e suites (`bindle-consent-*`, `authorization-entry-*`).

## Changes

| Area | Change |
|------|--------|
| Contrast tokens | About 46 ad-hoc grey and green text colours (many 2.3–3.9:1) were consolidated into `--muted`, darkened from #718078 to #5f6e66 (4.7–5.4:1 on every light surface). Empty-state headings now use `--soft-ink` (#506a42). The earlier duplicate override rule now points at the token. Public dark mode overrides both tokens. |
| Focus | The focus ring is now a `--focus` token (#4f8a2a, ≥3.9:1, up from 2.3:1). `focus-visible` now also covers `textarea`, `summary` and focusable `[tabindex]`. |
| Typography | 8px and 9px text was raised to 10px. Small interactive controls were raised from 10px to 12px: card actions, mobile nav, filter tabs, shortcut actions, top-bar search and search results. |
| Layout | Rules cards overflowed the page at every width; they now stack, with the metadata wrapping. A desktop sidebar taller than the viewport now scrolls instead of spilling. Security details stack below 480px. The mobile top-bar eyebrow is hidden. Admin tables keep their visually hidden headers inside the scroll box, which fixes page overflow at 320 in Spanish. The static landing features had 64px of indentation at 320; that is removed. |
| Hierarchy | On the device page, the buttons are grouped and the guidance is muted. The sign-in secondary links are grouped and aligned. "Create a 3sln.me account" now uses the standard button size. "Sign out of all accounts" was demoted from primary to a separated secondary-danger button. Developer-contact and message-animation copy now uses the standard sizes. |
| Icons | Distinct icons were added: conversations, connected apps, automation, billing, preferences and beaming. Admin claims, users, client hosts and audit got their own icons, and billing's Refresh now uses a refresh icon. Before this, five navigation entries reused another entry's icon. |
| Admin | The stat numbers rendered at label size because `.stat span` also matched the number's inner span. The selector is now `.stat>span`. |
| i18n | Account status now uses the translated "Active". The "Browser session" fallback is now translatable. |
| Bidi | Untranslated inline spans (handles and owner text) and island names and handles are bidi-isolated. |
| Claims | Claims carrying `redeemedAt` show a "Redeemed {time}" state (en/es) and no Revoke or Retrieve-link action. They no longer count as outstanding. |

## Independent UX/accessibility review

The reviewer found no blocker regressions and confirmed the contrast figures above. These are the findings:

| # | Finding | Severity | Resolution |
|---|---------|----------|------------|
| R1 | `signin-320-*` captures were blank. | Major (coverage) | It was a capture race: the page was screenshotted before re-layout after resizing from 1280 to 320. A probe showed the page renders correctly at 320. The capture now waits after resizing, and every after-capture is non-blank. |
| R2 | The mobile navigation strip cuts off with no scroll cue. | Major, pre-existing | Fixed: an edge fade mask was added. A "More" menu would need a product decision. |
| R3 | The mobile top bar is crowded, and "Private by default" wraps. | Minor | Deferred. It is a trust message, so it needs a product decision. |
| R4 | "Preferences & shortcuts" used 11px. | Minor | Fixed: the rule was removed. |
| R5 | Clipped admin table columns gave no cue that the table scrolls. | Minor | Fixed: scroll shadows were added to `.table-wrap`. |
| R6 | Spanish security strings stay in English: passkey counts, "Last active … Expires …", "(s)" plurals, and "Activadas" agreement. | Minor | Deferred to the i18n catalogue owner. Plural-aware keys are needed. |
| R7 | Rule labels became as strong as their values. | Minor | Fixed: values now use the body ink at weight 500. |
| R8 | The rule status pill sits among the actions. | Minor | Deferred. Moving it changes markup order. |
| R9 | Session Rename and Revoke floated mid-row. | Minor | Fixed: the actions are now aligned to the row end. |
| R10 | The contact page has two filled primary buttons. | Minor | Deferred: product decision on the primary path. |
| R11 | "Review device request" looks clickable while signed out. | Minor | Deferred. Disabling it changes behaviour. |
| R12 | The sign-out-all border was 1.64:1. | Minor | Fixed: the border is now #c98d86. |
| R13 | `.message-top time` was still 9px. | Minor | Fixed: it is now 10px. |
| R14 | Placeholders rendered at weight 600. | Minor | Fixed: they now use weight 400. |

## Deferred decisions

- The signed-in console has no dark theme. Its light palette is a recorded decision, and the docs site is also light-only.
- Raw shortcut `when` expressions appear in Preferences.
- The sign-in placeholder copy reads "n.... or your chosen handle".
- Resource cards marked "Unavailable" still offer "Set up".
- The inbox toolbar wraps on mobile: "Delete View" ends up alone on a row.
- R3, R6, R8, R10 and R11 above.

## Verification

- `npm run test:ui-state` 190/190 (it includes a new redeemed-claim test).
- `npm run test:dom` passes.
- `npm test` 1279/1279.
- `npm run build:assets` passes.
- `npm run test:e2e` passes. The two WebKit island cases are skipped because WebKit `newPage()` hangs in this environment.
- The after-capture shows no horizontal page overflow at any width, theme or language.
- RTL content was not exercised: the product ships no RTL locale.
