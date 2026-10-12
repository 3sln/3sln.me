// Automatic maintenance is bounded independently from admission of new work.
// Paused records retain ownership of outstanding data until operator repair.
export const CLEANUP_RETRY_LIMIT = 8;
export const retryReady = (record, now = Date.now()) => !record || !record.paused && Number.isSafeInteger(record.retryAt) && record.retryAt <= now;
export const retryTime = (record, now = Date.now()) => record?.paused ? Infinity : record ? Number.isSafeInteger(record.retryAt) ? Math.max(now + 60000, record.retryAt) : Infinity : now + 60000;
export async function retryFailure(metadata, key, error, now = Date.now()) {
  return metadata.transaction(async tx => {
    const prior = await tx.get(key), failures = Number.isSafeInteger(prior?.failures) && prior.failures >= 0 ? prior.failures + 1 : prior ? CLEANUP_RETRY_LIMIT : 1;
    const paused = failures >= CLEANUP_RETRY_LIMIT;
    const record = { failures: Math.min(failures, CLEANUP_RETRY_LIMIT), paused, retryAt: paused ? null : now + Math.min(3600000, 60000 * 2 ** (failures - 1)), code: typeof error?.code === 'string' ? error.code : 'maintenance_unavailable', updatedAt: now };
    await tx.put(key, record); return record;
  });
}
