// HTTP route registry (docs/architecture/app-engine.md §7, §12).
//
// packages/runtime/http.mjs is a small router: it runs these stages in order and keeps the cross-cutting steps
// between them (origin and method checks, CSRF, the session, owner resolution, capacity admission, activity).
//   edge             before the app-origin check (the dedicated embed origin)
//   public           credentialless and capability routes, before the method allowlist
//   anonymous        after the method allowlist, before the CSRF check
//   unauthenticated  after the CSRF check, before the /api/ session block
//   api              first step of the /api/ block, before session cookies are read
//   session          with the identity engine and request context; before owner resolution
//   beforeActivity   owner routes that run before capacity admission and activity are recorded
//   owner            owner routes after admission and `touch`
//   pages            everything outside /api/ (the site module always answers)
// A stage handler receives the request context ({request, env, execution, url, path, local, mutation}, later
// also {engine, context, vault, accountMember, ...} and {owner, id, object, dispatch}) and returns a Response,
// `passthrough(promise)` (returned outside the router's error funnel) or nothing, to let the next handler try.
//
// A route module may export `stages`, `allowedMethods(path)` (the 405 allowlist; null when it does not know the
// path) and `admission` ({protective: [{match(path, method), test(change)}], exempt(path)}): capacity admission
// is skipped for exempt paths and for protective changes, whose JSON body is read only when a rule matches.
//
// Routes of different modules in one stage must not overlap. Where they do, this order decides: `delivery`
// answers contact-delivery bearer RPC on /bindle/rpc before `federation`, and `beams` answers the methods of
// /api/contacts/{redeem,directory} before `contacts`. Append-only: one import and one entry per slice; a slice
// adds routes to its own module.
import * as site from './site.mjs';
import * as admin from './admin.mjs';
import * as identity from './identity.mjs';
import * as lifecycle from './lifecycle.mjs';
import * as automation from './automation.mjs';
import * as conversations from './conversations.mjs';
import * as beams from './beams.mjs';
import * as contacts from './contacts.mjs';
import * as delivery from './delivery.mjs';
import * as messages from './messages.mjs';
import * as views from './views.mjs';
import * as storage from './storage.mjs';
import * as billing from './billing.mjs';
import * as search from './search.mjs';
import * as notifications from './notifications.mjs';
import * as federation from './federation.mjs';

export const ROUTES=Object.freeze([site,admin,identity,lifecycle,automation,conversations,beams,contacts,delivery,messages,views,storage,billing,search,notifications,federation]);
export const STAGES=Object.freeze(['edge','public','anonymous','unauthenticated','api','session','beforeActivity','owner','pages']);
for(const module of ROUTES)for(const name of Object.keys(module.stages??{}))if(!STAGES.includes(name))throw new TypeError(`Unknown route stage ${name}`);

/** The first answer of a stage's handlers, in registry order, or null. */
export async function stage(name,context){for(const module of ROUTES){const handler=module.stages?.[name];if(handler){const response=await handler(context);if(response)return response;}}return null;}
/** The methods a known path allows, or null. */
export function routeMethods(path){for(const module of ROUTES){const allow=module.allowedMethods?.(path);if(allow)return allow;}return null;}
export const admission=Object.freeze({protective:Object.freeze(ROUTES.flatMap(module=>module.admission?.protective??[])),exempt:path=>ROUTES.some(module=>module.admission?.exempt?.(path))});
