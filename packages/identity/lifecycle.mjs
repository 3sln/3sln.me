const DAY = 86400000;

/** Compute a reviewable maintenance plan without changing data. Activity must
 * include authenticated account AND app resource use, not just login events. */
export function planAccountLifecycle(account, { now, shelfAfterDays = 180, deleteAfterDays = 730,
  graceDays = 90, deletionEnabled = false, deletionSignoff = null } = {}) {
  if (!Number.isFinite(now) || ![shelfAfterDays, deleteAfterDays, graceDays].every(Number.isFinite) || shelfAfterDays < 30 || deleteAfterDays <= shelfAfterDays || graceDays < 90) throw new TypeError('Conservative lifecycle policy required');
  if (account.status !== 'active') return { action: 'retain', reason: 'Nonactive account needs a separate maintenance policy.' };
  const activity = Math.max(account.lastActiveAt || account.createdAt, account.lastResourceActivityAt || 0);
  if (!Number.isFinite(activity) || activity > now) return { action: 'retain', reason: 'Activity data requires review.' };
  if ((account.sessions || []).some(s => s.expiresAt > now)) return { action: 'retain', reason: 'A live owner session exists.' };
  if (now - activity < shelfAfterDays * DAY) return { action: 'retain', reason: 'The account is within the active retention window.' };
  if (!account.shelvedAt) return { action: 'shelve', reason: 'Archive cold resource data with a verified restorable manifest; keep identity and recovery online.' };
  if (!deletionEnabled || !deletionSignoff?.reviewer || !deletionSignoff.date || deletionSignoff.outcome !== 'approved') return { action: 'retain-shelved', reason: 'Destructive retention policy has no explicit approval.' };
  if (now - activity < deleteAfterDays * DAY) return { action: 'retain-shelved', reason: 'Long-term retention has not elapsed.' };
  if (!account.verifiedEmail && !account.verifiedPhone) return { action: 'retain-shelved', reason: 'No verified channel can deliver advance deletion notice.' };
  const notice = account.deletionNotice;
  if (!notice || notice.deliveredAt < activity || !notice.deliveryReceipt || !Number.isFinite(notice.deliveredAt)) return { action: 'notify', reason: 'Deliver a notice with a verifiable receipt before starting the grace period.' };
  if (now < notice.deliveredAt + graceDays * DAY) return { action: 'retain-shelved', reason: 'The advance-notice grace period is still open.' };
  return { action: 'eligible-for-deletion-review', reason: 'A final atomic activity/notice/ownership check and backup deletion plan are required; this function never deletes.' };
}
