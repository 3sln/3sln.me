// Roles are privilege bundles; badges remain presentation. Pure policy only:
// callers supply the current catalog, target evidence and actor, then commit
// the decision under optimistic revisions so a concurrent change cannot race it.
export const ADMIN_ROLE='admin',CLASSES=Object.freeze(['internal','user']),BADGE_CLASSES=Object.freeze(['internal','delegable','user']);
const slug=value=>typeof value==='string'&&/^[a-z][a-z0-9-]{0,31}$/.test(value);
const capabilityID=value=>typeof value==='string'&&/^[a-z][a-z0-9-]{0,31}(?:\.[a-z][a-z0-9-]{0,31})?$/.test(value)&&!/^(?:admin|boot)(?:\.|$)/.test(value);
const text=(value,max)=>typeof value==='string'&&value.trim()===value&&value.length>0&&Array.from(value).length<=max&&!/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩\ud800-\udfff]/u.test(value);
const plain=value=>value&&Object.getPrototypeOf(value)===Object.prototype;
const exact=(value,keys)=>plain(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const fail=(code,message,status=400)=>{throw Object.assign(new Error(message),{code,status});};
const invalid=()=>fail('invalid_role_catalog','The role catalog is invalid.');
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
// Built-in administrator authority is implicit and never part of a custom role.
export const BUILTIN_ROLES=freeze({[ADMIN_ROLE]:{class:'internal',name:'Administrator',description:'Operates this host: reservations, claims, roles below administrator, badges and user lookup.',capabilities:[]}});
export const EMPTY_CATALOG=freeze({version:1,capabilities:{},roles:{},badgeClasses:{}});
export function validateCatalog(value){
 if(!exact(value,['version','capabilities','roles','badgeClasses'])||value.version!==1||!plain(value.capabilities)||!plain(value.roles)||!plain(value.badgeClasses))invalid();
 const capabilities={},roles={},badgeClasses={},caps=Object.entries(value.capabilities),list=Object.entries(value.roles),badges=Object.entries(value.badgeClasses);
 if(caps.length>128||list.length>64||badges.length>32)invalid();
 for(const [id,cap] of caps){if(!capabilityID(id)||!exact(cap,['class','description'])||!CLASSES.includes(cap.class)||!text(cap.description,240))invalid();capabilities[id]={class:cap.class,description:cap.description};}
 for(const [id,role] of list){if(!slug(id)||Object.hasOwn(BUILTIN_ROLES,id)||!(exact(role,['class','name','description','capabilities'])||exact(role,['class','name','description','capabilities','delegable'])&&role.delegable===true&&role.class==='internal')||!CLASSES.includes(role.class)||!text(role.name,48)||!text(role.description,240)||!Array.isArray(role.capabilities)||role.capabilities.length>32||new Set(role.capabilities).size!==role.capabilities.length)invalid();
  // A user-class role may hold only capabilities boot classified as safe for anyone.
  for(const cap of role.capabilities)if(!Object.hasOwn(capabilities,cap)||role.class==='user'&&capabilities[cap].class!=='user')invalid();
  roles[id]={class:role.class,name:role.name,description:role.description,capabilities:[...role.capabilities].sort(),...role.delegable?{delegable:true}:{}};}
 for(const [id,cls] of badges){if(!/^[a-z][a-z0-9-]{0,47}$/.test(id)||!BADGE_CLASSES.includes(cls))invalid();badgeClasses[id]=cls;}
 return freeze({version:1,capabilities,roles,badgeClasses});
}
export const catalogRole=(catalog,id)=>Object.hasOwn(BUILTIN_ROLES,id)?BUILTIN_ROLES[id]:Object.hasOwn(catalog.roles,id)?catalog.roles[id]:null;
// Unclassified badges are internal and boot-only: an admin cannot decorate any
// account with staff-looking artwork merely because a definition exists.
export const badgeClass=(catalog,id)=>BADGE_CLASSES.includes(catalog.badgeClasses[id])?catalog.badgeClasses[id]:'internal';
const same=(a,b)=>JSON.stringify(a??null)===JSON.stringify(b??null);
/** Admins may edit only user-class roles using user-class capabilities; class,
 * capability and badge classification is boot-only. */
export function catalogChangeAllowed(actor,before,after){
 if(actor?.kind==='boot')return true;if(actor?.kind!=='admin')return false;
 if(!same(before.capabilities,after.capabilities)||!same(before.badgeClasses,after.badgeClasses))return false;
 for(const id of new Set([...Object.keys(before.roles),...Object.keys(after.roles)]))if(!same(before.roles[id],after.roles[id])&&(before.roles[id]&&before.roles[id].class!=='user'||after.roles[id]&&after.roles[id].class!=='user'))return false;
 return true;
}
export function normalizeRoles(value){if(!Array.isArray(value)||value.length>16||new Set(value).size!==value.length||value.some(id=>!slug(id)))fail('invalid_roles','Choose up to 16 distinct roles.');return [...value].sort();}
/** target: {owner, internal, roles(before)}; actor: {kind:'boot'}|{kind:'admin',owner}. */
export function assignmentDecision(actor,target,catalog,next){
 const roles=normalizeRoles(next),before=target.roles??[];
 for(const id of roles){const role=catalogRole(catalog,id);if(!role)fail('unknown_role','A selected role is not defined.');if(role.class==='internal'&&target.internal!==true)fail('role_class_forbidden','Internal roles require a reserved internal account.',403);}
 if(actor?.kind==='boot')return roles;
 if(actor?.kind!=='admin')fail('forbidden','Administrator authority is required.',403);
 if(target.owner===actor.owner)fail('self_forbidden','Administrators cannot change their own roles.',403);
 if(before.includes(ADMIN_ROLE))fail('admin_target_forbidden','Only boot can change an administrator.',403);
 if(roles.includes(ADMIN_ROLE))fail('admin_role_boot_only','Only boot can create administrators.',403);
 // Admins can mint internal accounts, so internal roles they add must be ones
 // boot explicitly delegated; everything else internal stays boot-only.
 for(const id of roles)if(!before.includes(id)&&catalogRole(catalog,id).class==='internal'&&catalog.roles[id]?.delegable!==true)fail('role_boot_only','Only boot can assign this internal role.',403);
 return roles;
}
export function badgeDecision(actor,target,catalog,known,next){
 if(!Array.isArray(next)||next.length>4||new Set(next).size!==next.length||next.some(id=>!known.includes(id)))fail('invalid_badges','Choose up to four configured badges.');
 for(const id of next)if(badgeClass(catalog,id)!=='user'&&target.internal!==true)fail('badge_class_forbidden','This badge is limited to reserved internal accounts.',403);
 if(actor?.kind==='boot')return [...next];
 if(actor?.kind!=='admin')fail('forbidden','Administrator authority is required.',403);
 if(target.owner===actor.owner)fail('self_forbidden','Administrators cannot change their own account.',403);
 if((target.roles??[]).includes(ADMIN_ROLE))fail('admin_target_forbidden','Only boot can change an administrator.',403);
 for(const id of next)if(!(target.badgeIds??[]).includes(id)&&badgeClass(catalog,id)==='internal')fail('badge_boot_only','Only boot can assign this badge.',403);
 return [...next];
}
/** Fail closed: undefined roles and class-mismatched roles disappear at read time. */
export function effectiveAuthority(catalog,principal,{internal,active}){
 const roles=(principal?.roles??[]).filter(id=>{const role=catalogRole(catalog,id);return role&&(role.class==='user'||internal===true)&&(id!==ADMIN_ROLE||active===true);});
 const capabilities=[...new Set(roles.flatMap(id=>catalogRole(catalog,id).capabilities.filter(cap=>catalog.capabilities[cap]&&(catalog.capabilities[cap].class==='user'||internal===true))))].sort();
 return {roles,capabilities,admin:roles.includes(ADMIN_ROLE)};
}
