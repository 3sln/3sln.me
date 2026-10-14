import test from 'node:test';
import assert from 'node:assert/strict';
import {configuredNamePolicy,configuredReservedName,configuredTokenNames,validateHostAlias,publicBadgePolicy,accountBadges,projectAccountBadges,defaultBadgeResolver,compileBadgeSprite,configuredBadgeDefinitions,configuredBadgeIDs} from '../packages/identity/badge-policy.mjs';
const account={id:'11111111-1111-4111-8111-111111111111',handle:'n.1',status:'active',badgeIds:['staff']};
const namePolicy=()=>({version:1,reserved:['admin','alice'],onboarding:['alice','ray']});
const definitions=()=>[{id:'staff',name:'Host team',description:'An account designated by this host.',svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M1 1 L23 23"/><circle cx="12" cy="12" r="4"/></svg>'}];
const config=(defs=definitions())=>({HOST_NAME_POLICY:JSON.stringify(namePolicy()),BADGE_DEFINITIONS:defs,ONBOARDING_ENABLED:'false'});
const bad=fn=>assert.throws(fn,e=>['host_name_policy_unavailable','badge_policy_unavailable'].includes(e.code)&&e.status===503);

test('name-only policy retains defaults, permits explicit replacement/overlap and protects disabled token names',()=>{
 assert.deepEqual(configuredNamePolicy({HOST_NAME_POLICY:''}),configuredNamePolicy({}));assert(configuredReservedName({},'ADMIN'));assert.equal(validateHostAlias('RAY'),'ray');assert.throws(()=>validateHostAlias('n.123'));
 const c=config();assert.deepEqual(configuredTokenNames(c),['alice','ray']);assert(configuredReservedName(c,'ALICE'));assert(configuredReservedName(c,'RAY'));assert.equal(configuredReservedName(c,'system'),false);
 bad(()=>configuredNamePolicy({HOST_NAME_POLICY:{...namePolicy(),badges:[]}}));bad(()=>configuredNamePolicy({HOST_NAME_POLICY:{...namePolicy(),onboarding:['n.1']}}));
});

test('definitions compile into deterministic sprite and accessible escaped text with no private names',async()=>{
 const c=config();c.BADGE_DEFINITIONS[0].name='<team>';c.BADGE_DEFINITIONS[0].description='A & B';const sprite=await compileBadgeSprite(c);assert.match(sprite.svg,/<symbol id="staff" viewBox="0 0 24 24">/);assert.match(sprite.svg,/<title>&lt;team&gt;<\/title><desc>A &amp; B<\/desc>/);assert.match(sprite.digest,/^[a-f0-9]{64}$/);assert.deepEqual(await compileBadgeSprite(c),sprite);assert.deepEqual(sprite.ids,['staff']);assert.deepEqual(configuredBadgeIDs(c),['staff']);assert(Object.isFrozen(configuredBadgeDefinitions(c)));
 const pub=publicBadgePolicy(c);assert.equal(pub.path,'/api/badges/sprite.svg');assert.equal('svg' in pub.definitions[0],false);assert.equal(JSON.stringify(pub).includes('alice'),false);assert.deepEqual(Object.keys(pub.definitions[0]),['id','name','description']);
 assert((await compileBadgeSprite({})).ids.includes('system'));
});

test('trusted resolver output and identity badgeIds select only known IDs with no role/name inference',()=>{
 const c=config();assert.deepEqual(accountBadges(account,c),['staff']);assert.deepEqual(accountBadges({...account,badgeIds:undefined,paidHandle:'alice',systemIdentity:{role:'system'}},c),[]);
 assert.deepEqual(projectAccountBadges({...account,badgeIds:[]},c,['staff']),['staff']);assert.deepEqual(projectAccountBadges(account,c,['unknown','staff']),['staff']);
 for(const ids of [undefined,'staff',Promise.resolve(['staff']),['staff','staff'],['a','b','c','d','e'],['bad id']])assert.deepEqual(projectAccountBadges(account,c,ids),[]);
 for(const patch of [{id:'bad'},{handle:'bad handle'},{status:'deleted'},{status:'unknown'}])assert.deepEqual(accountBadges({...account,...patch},c),[]);
 const copy=defaultBadgeResolver(account);copy.push('other');assert.deepEqual(account.badgeIds,['staff']);assert.deepEqual(accountBadges(account,config([])),[]);
});

test('sprite compiler rejects executable or fetching SVG and unsupported features instead of dropping them silently',()=>{
 const badSources=[
 '<svg viewBox="0 0 24 24"><script>alert(1)</script></svg>',
 '<svg viewBox="0 0 24 24" onload="alert(1)"><path d="M0 0"/></svg>',
 '<svg viewBox="0 0 24 24"><foreignObject><div>Hi</div></foreignObject></svg>',
 '<svg viewBox="0 0 24 24"><image href="https://tracking.example/i"/></svg>',
 '<svg viewBox="0 0 24 24"><use href="#other"/></svg>',
 '<svg viewBox="0 0 24 24"><path d="M0 0" fill="url(https://tracking.example/p)"/></svg>',
 '<svg viewBox="0 0 24 24"><path style="fill:red" d="M0 0"/></svg>',
 '<svg viewBox="0 0 24 24"><animate attributeName="x"/></svg>',
 '<svg viewBox="0 0 24 24"><defs><linearGradient id="g"/></defs></svg>',
 '<svg viewBox="0 0 24 24"><path id="collision" d="M0 0"/></svg>',
 '<!DOCTYPE svg [<!ENTITY secret SYSTEM "file:///private">]><svg viewBox="0 0 24 24">&secret;</svg>',
 '<svg viewBox="0 0 24 24"><path d="M0 0" d="M1 1"/></svg>',
 '<svg viewBox="0 0 24 24"><path d="M1e999 1"/></svg>',
 '<svg viewBox="0 0 24 24">'+('<g>'.repeat(13))+'<path d="M0 0"/>'+('</g>'.repeat(13))+'</svg>'
 ];
 for(const svg of badSources){const defs=definitions();defs[0].svg=svg;bad(()=>configuredBadgeDefinitions(config(defs)));assert.deepEqual(publicBadgePolicy(config(defs)),{path:null,definitions:[]});assert.deepEqual(accountBadges(account,config(defs)),[]);}
});

test('definition schema, Unicode, IDs and aggregate/shape budgets are bounded',()=>{
 for(const mutate of [d=>d.push({...d[0]}),d=>d[0].id='bad#id',d=>d[0].name='x'.repeat(49),d=>d[0].description='x'.repeat(241),d=>d[0].name='safe\u202edanger',d=>d[0].name='\ud800',d=>d[0].url='https://private.example',d=>d[0].svg='x'.repeat(16385),d=>d[0].svg='<svg viewBox="0 0 24 24">'+('<g/>'.repeat(513))+'</svg>']){const d=definitions();mutate(d);bad(()=>configuredBadgeDefinitions(config(d)));}
 const d=definitions();d[0].name='😀'.repeat(48);assert.deepEqual(configuredBadgeIDs(config(d)),['staff']);
 for(const value of ['{',null,{},'x'.repeat(262145)])bad(()=>configuredBadgeIDs({BADGE_DEFINITIONS:value}));
});

test('supported primitive shapes and transforms preserve safe geometry without external references',async()=>{
 const d=definitions();d[0].svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32"><g transform="translate(1 2) rotate(30)"><rect x="1" y="2" width="4" height="8" rx="2" fill="#fff"/><ellipse cx="2" cy="3" rx="1" ry="2"/><line x1="0" y1="0" x2="4" y2="4"/><polygon points="0,0 1,2 3,4"/><polyline points="0 0 1 1"/></g></svg>';const sprite=await compileBadgeSprite(config(d));assert.match(sprite.svg,/viewBox="0 0 32 32"/);assert.match(sprite.svg,/<rect /);assert(!sprite.svg.includes('href='));
});

test('single-entry content cache shares immutable compilation but detects changed mutable config',async()=>{
 const c=config(),first=await compileBadgeSprite(c);assert.equal(await compileBadgeSprite(c),first);assert.throws(()=>first.ids.push('other'));assert.throws(()=>first.definitions[0].name='Mutated');const defs=configuredBadgeDefinitions(c);assert.equal(configuredBadgeDefinitions(c),defs);
 c.BADGE_DEFINITIONS[0].name='Changed';const second=await compileBadgeSprite(c);assert.notEqual(second.digest,first.digest);assert.equal(second.definitions[0].name,'Changed');assert.equal(first.definitions[0].name,'Host team');assert.equal(await compileBadgeSprite(c),second);
 const cyclic=[];cyclic.push(cyclic);bad(()=>configuredBadgeIDs({BADGE_DEFINITIONS:cyclic}));
});
