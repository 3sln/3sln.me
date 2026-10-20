// Application error vocabulary (docs/architecture/app-engine.md §4).
// An operation fails by throwing an Error carrying a stable snake_case `code`,
// a human `message` safe to show the caller, and, when the domain knows it, an
// HTTP-shaped `status`. Domain faults that predate this module (StorageError,
// MessagingFault, IdentityFault) already have this shape and stay as they are;
// `faultOf` is meant to be the one place a thrown value becomes a wire fault. The
// engine CLI uses it now; the DO `$fault` envelope and the HTTP funnel move to it
// in Phase 0 (docs/architecture/app-engine.md §12).
export class AppFault extends Error {
  constructor(code, message = code, status) { super(message); this.name = 'AppFault'; this.code = code; if (status !== undefined) this.status = status; }
}
export const fault = (code, message, status) => { throw new AppFault(code, message, status); };
export const FAULT_STATUS = Object.freeze({ invalid_request: 400, unauthorized: 401, forbidden: 403, not_found: 404, conflict: 409, rate_limited: 429, temporarily_unavailable: 503 });
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
/** The serializable form of a thrown value; unknown errors never leak their message. */
export function faultOf(error) {
  if (!error || typeof error.code !== 'string' || !CODE.test(error.code)) return { code: 'internal_error', message: 'The operation could not be completed.', status: 500 };
  return { code: error.code, message: typeof error.message === 'string' && error.message ? error.message : error.code, ...Number.isSafeInteger(error.status) ? { status: error.status } : FAULT_STATUS[error.code] ? { status: FAULT_STATUS[error.code] } : {}, ...Number.isSafeInteger(error.retryAfter) && error.retryAfter > 0 ? { retryAfter: error.retryAfter } : {} };
}
