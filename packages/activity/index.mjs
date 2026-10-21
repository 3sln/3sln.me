// Core app-originated activity (docs/spec/activity.md; host design docs/architecture/activity-center.md).
// Engine operations live in packages/app/domains/activity.mjs; everything exposed is behind ACTIVITY_V2_ENABLED.
export {ACTIVITY_LIMITS,ACTIVITY_PURPOSE,PRIORITIES,ActivityFault,activityInput,appTagId,qualifiedTag,principalOf} from './model.mjs';
export {admissionEvidence,attest,verifyEvidence,verifyRevision,contentDigest} from './evidence.mjs';
export {ActivityStore,activityScope,activityState,liveConnection} from './store.mjs';
export {activityFromAppMessage,verifyLegacyAppMessage,LEGACY_PURPOSE} from './legacy.mjs';
export const activityEnabled=config=>config?.ACTIVITY_V2_ENABLED==='true';
