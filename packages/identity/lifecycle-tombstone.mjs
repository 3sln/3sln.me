import {revokeAllLineage} from './linked-approval.mjs';
import {AdminService} from './admin.mjs';
import {isUUID as uuid} from '../core/primitives.mjs';

// Kept on the tombstone so permanent namespace claims stay bound and are never recycled.
const RETAINED=['id','handle','assignmentId','systemIdentity','onboardingIdentity','createdAt'];

/** Trusted account-lifecycle identity port over the identity repository. It is
 * never an HTTP operation. `get` projects only what notice/arming needs. `tombstone`
 * irreversibly removes authentication and private contact data while keeping the
 * handle, aliases and assignment so the name is never recycled. Email claims are
 * released through the repository's revision-checked swap, never a raw delete. */
export function lifecycleIdentityPort(repository,{clock=()=>Date.now()}={}){
 if(typeof repository?.get!=='function'||typeof repository.compareAndSwap!=='function')throw new TypeError('An identity repository is required.');
 return Object.freeze({
  async get(owner){
   if(!uuid(owner))throw new TypeError('Invalid account identifier');const account=await repository.get(owner);if(!account)return null;
   const email=typeof account.verifiedEmail==='string'&&Number.isSafeInteger(account.emailVerifiedAt)?account.verifiedEmail:null;
   return {status:account.status,assignmentId:account.assignmentId,createdAt:account.createdAt,verifiedEmail:email,emailVerifiedAt:email?account.emailVerifiedAt:null};
  },
  async tombstone(owner,{assignmentId}={}){
   if(!uuid(owner)||typeof assignmentId!=='string'&&assignmentId!==undefined)throw new TypeError('Invalid tombstone request');
   for(let attempt=0;attempt<4;attempt++){
    const account=await repository.get(owner);if(!account)return false;
    if(assignmentId!==undefined&&account.assignmentId!==assignmentId)throw Object.assign(new Error('Account assignment changed.'),{code:'lifecycle_assignment_changed',status:409});
    if(account.status==='deleted')return true;
    const now=clock(),next=Object.fromEntries(RETAINED.filter(key=>account[key]!==undefined).map(key=>[key,structuredClone(account[key])]));
    revokeAllLineage(account,now);if(account.lineageOutbox?.length)next.lineageOutbox=account.lineageOutbox;
    Object.assign(next,{status:'deleted',deletedAt:now,revision:account.revision+1,sessions:[],credentials:[],challenges:[],emailChallenges:[],passwordHash:null,recoveryHash:null,audit:[{event:'account-deleted-inactive',at:now}]});
    if(await repository.compareAndSwap(owner,account.revision,next))return true;
   }
   throw Object.assign(new Error('The identity changed during deletion; retry later.'),{code:'lifecycle_identity_conflict',status:409});
  }
 });
}

/** Administrator-hold port for the account lifecycle. Uses AdminService's own
 * hold semantics when an admin store exists; an identity suspended by an
 * administrator also counts as held. Failure is reported to the caller, which
 * treats an unreadable hold as held. */
export function lifecycleAdminHoldPort({store,repository}){
 if(typeof repository?.get!=='function')throw new TypeError('An identity repository is required.');
 return async owner=>{
  const hold=store?await AdminService.prototype.lifecycleHold.call({store,repository},owner):{held:false,since:null,releasedAt:null};
  const account=await repository.get(owner);if(!account)throw new Error('Account unavailable');
  return account.status==='suspended'&&!hold.held?{...hold,held:true}:hold;
 };
}
