// Namespace grammar is shared by authority, repositories, and callers. Free
// numbers use Crockford's alphabet without checksum symbols or separators.
export const FREE_HANDLE_PREFIX = 'n.';
export const MAX_FREE_HANDLE_NUMBER = 9999999999999n;
// These names are for operator-issued platform/system identities. Ordinary
// account creation and paid alias claims must never allocate them.
export const RESERVED_HANDLES=Object.freeze(['ray','sys','admin','administrator','root','system','support','security','abuse','postmaster','webmaster','billing','api','mail','notify','verify','login','accounts','3sln']);
export function isReservedHandle(input){try{return RESERVED_HANDLES.includes(normalizeHandle(input));}catch{return false;}}
const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
function invalid() { throw new TypeError('Invalid account handle.'); }
export function encodeFreeHandleNumber(input) {
  if (typeof input !== 'bigint' && !(typeof input === 'string' && /^(0|[1-9][0-9]{0,12})$/.test(input)) && !(Number.isSafeInteger(input) && input >= 0)) invalid();
  let number = BigInt(input);
  if (number < 1n || number > MAX_FREE_HANDLE_NUMBER) invalid();
  let value = ''; while (number) { value = alphabet[Number(number % 32n)] + value; number /= 32n; }
  return FREE_HANDLE_PREFIX + value;
}
export function normalizeHandle(input) {
  if (typeof input !== 'string' || input.length < 3 || input.length > 32 || /[^\x20-\x7e]/.test(input)) invalid();
  const handle = input.toLowerCase();
  if (handle.startsWith(FREE_HANDLE_PREFIX)) {
    const code = handle.slice(2).replaceAll('o','0').replace(/[il]/g,'1');
    if (!/^[0-9abcdefghjkmnpqrstvwxyz]{1,9}$/.test(code)) invalid();
    let number=0n;for(const char of code)number=number*32n+BigInt(alphabet.indexOf(char));
    return encodeFreeHandleNumber(number);
  }
  if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(handle)) invalid();
  return handle;
}
export function isFreeHandle(input) { try { return normalizeHandle(input).startsWith(FREE_HANDLE_PREFIX); } catch { return false; } }
export function validatePaidHandle(input) { const handle=normalizeHandle(input);if(handle.startsWith(FREE_HANDLE_PREFIX)||isReservedHandle(handle))invalid();return handle; }
