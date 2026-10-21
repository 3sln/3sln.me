// Reference-host values of docs/spec/events.md §9 (3sln.me policy, provisional; product review pending). A protocol
// host publishes its own values in descriptor `limits` (§4.4); `busLimits` derives them from one bus record.
const DAY=86400;
export const BUS_LIMITS=Object.freeze({
 buses:Object.freeze({free:8,paid:32}),
 retentionCapSeconds:Object.freeze({free:7*DAY,paid:30*DAY}),
 maxRetainedRecords:10000,maxRetainedBytes:16*1024*1024,maxRecordBytes:16384,
 publishPerMinute:60,busPublishPerMinute:120,
 // Separate event allowance (SEC-10, Q8): never the owner's storage-write or work meters.
 allowance:Object.freeze({free:2000,paid:20000}),publisherShare:0.5,readerShare:0.25,readerOwnShare:0.1,
 reads:Object.freeze({perSecond:2,maxResultBytes:262144,freeEmptyPerDay:2000,maxLimit:100,defaultLimit:50}),
 waits:Object.freeze({maxWaitSeconds:25,perGrant:1,perClient:2,perAccount:8,dailySeconds:172800,overCapRetry:10,budgetRetry:60,graceSeconds:30,revokeCheckSeconds:5,clientShare:0.5}),
 journal:Object.freeze({minSeconds:600,maxSeconds:DAY}),
 maxResponseRecords:100,cursorChars:512,receiptChars:128,
 sweepBatch:500,
});
export const EVENT_BUS_CONTRACT='https://spec.bindle.example/contracts/event-bus/v1';
export const BUS_METHODS=Object.freeze(['publish','read','subscribe','unsubscribe']);
export const eventBusesEnabled=config=>config?.EVENT_BUSES_ENABLED===true||config?.EVENT_BUSES_ENABLED==='true';
export const planOf=value=>value==='paid'?'paid':'free';
/** Publish-journal retention: min(24 h, retention.max_seconds), never below 10 minutes (§4.1). */
export const txRetentionSeconds=bus=>Math.max(BUS_LIMITS.journal.minSeconds,Math.min(BUS_LIMITS.journal.maxSeconds,bus.spec.retention.max_seconds));
/** Descriptor limits (§4.4). `maxWaitSeconds` is 0 unless the adapter mounted the separate wait object. */
export function busLimits(bus,{waits=false}={}){
 return {maxRecordBytes:Math.min(bus.spec.max_record_bytes,BUS_LIMITS.maxRecordBytes),retentionSeconds:bus.retentionSeconds,maxRetainedRecords:BUS_LIMITS.maxRetainedRecords,maxRetainedBytes:BUS_LIMITS.maxRetainedBytes,
  publishPerMinute:BUS_LIMITS.publishPerMinute,maxWaitSeconds:waits?BUS_LIMITS.waits.maxWaitSeconds:0,push:false,txRetentionSeconds:txRetentionSeconds(bus),maxRequestBytes:32768,maxResultBytes:BUS_LIMITS.reads.maxResultBytes+16384};
}
