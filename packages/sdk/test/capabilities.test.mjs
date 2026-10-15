// Declaration validation and per-feature capability computation (components-profile
// decision note §4–§5, protocol §2). Fixtures use .example hosts.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readDeclaration,computeCapabilities,checkFloor,CapabilityStore,COMPONENTS_V1,declarationLimits,freshness} from '../src/capabilities.mjs';
import {componentsDeclaration} from '../src/testing.mjs';

const issuer='https://idp.example';
const floor={version:'0',issuer,authorization_endpoint:`${issuer}/authorize`,token_endpoint:`${issuer}/token`,rpc_endpoint:`${issuer}/rpc`,jwks_uri:`${issuer}/jwks`,authorization_request_endpoint:`${issuer}/requests`,preferences_contract:'https://contracts.example/preferences/v1',login_presentation:['redirect']};
const entry=(intents=['login','select-account','reauthenticate','end-session'])=>({'authorization-entry.v1':{endpoint:`${issuer}/entries`,intents}});
const full={...floor,login_presentation:['redirect','popup'],revocation_endpoint:`${issuer}/revoke`,dpop_signing_alg_values_supported:['ES256'],grant_types_supported:['authorization_code','refresh_token'],features:{...entry(),'fedcm.v1':{config_url:`${issuer}/fedcm.json`},'client-id-metadata.v1':{}},profiles:{[COMPONENTS_V1]:componentsDeclaration(issuer)}};
const caps=(manifest,options)=>computeCapabilities(readDeclaration(manifest,issuer,{embedderOrigin:'https://app.example'}),options);

test('conformance floor: every required member fails closed with unsupported-provider',()=>{
  checkFloor(floor,issuer);
  for(const patch of [{version:'1'},{issuer:'https://other.example'},{login_presentation:['popup']},{login_presentation:'redirect'},{token_endpoint:'https://other.example/token'},{rpc_endpoint:undefined},{authorization_request_endpoint:`${issuer}/r#x`},{jwks_uri:'https://u:p@idp.example/jwks'},{preferences_contract:'http://contracts.example/p'},{preferences_contract:undefined}])
    assert.throws(()=>readDeclaration({...floor,...patch},issuer),{code:'unsupported-provider'},JSON.stringify(patch));
  assert.throws(()=>readDeclaration(null,issuer),{code:'unsupported-provider'});
});

test('minimal (floor only): identity-pinned redirect, nothing optional, issuer-root manage link',()=>{
  const c=caps(floor);
  assert.deepEqual({entry:c.entry,identityless:c.identityless,selectAccount:c.selectAccount,reauth:c.reauthenticate,end:c.endSession,popup:c.popup,fedcm:c.fedcm,revoke:c.revoke,dpop:c.dpop,profile:c.profile},{entry:false,identityless:false,selectAccount:false,reauth:false,end:false,popup:false,fedcm:false,revoke:false,dpop:false,profile:false});
  assert.equal(c.manageUrl,issuer+'/');assert.deepEqual(c.islands,{avatar:null,switcher:null,signIn:null});
});

test('standard and full compute per feature; FedCM needs the entry, the feature and the user agent',()=>{
  const standard=caps({...floor,login_presentation:['redirect','popup'],revocation_endpoint:`${issuer}/revoke`,features:entry(['login','select-account'])});
  assert.equal(standard.identityless,true);assert.equal(standard.selectAccount,true);assert.equal(standard.reauthenticate,false);assert.equal(standard.popup,true);assert.equal(standard.revoke,true);assert.equal(standard.dpop,false);
  const all=caps(full,{identityCredential:true,defaultIssuer:issuer});
  assert.equal(all.fedcm,true);assert.equal(all.dpop,true);assert.equal(all.clientIdMetadata,true);assert.equal(all.profile,true);assert.equal(all.manageUrl,`${issuer}/console/apps`);
  assert.deepEqual(all.islands.avatar,{version:1,fedcm:false});assert.ok(all.islands.switcher);assert.ok(all.islands.signIn);
  assert.equal(caps(full,{identityCredential:false}).fedcm,false);
  assert.equal(caps({...full,features:{'fedcm.v1':{config_url:`${issuer}/fedcm.json`}}},{identityCredential:true}).fedcm,false,'fedcm requires authorization-entry');
  // DPoP needs ES256, the entry (it carries dpopJkt) and a refresh grant.
  assert.equal(caps({...full,grant_types_supported:['authorization_code']}).dpop,false);
  assert.equal(caps({...full,dpop_signing_alg_values_supported:['RS256']}).dpop,false);
});

test('absent or invalid entry intents mean none, never all; unknown intent values are ignored',()=>{
  assert.equal(caps({...floor,features:{'authorization-entry.v1':{endpoint:`${issuer}/entries`}}}).entry,false);
  assert.equal(caps({...floor,features:{'authorization-entry.v1':{endpoint:`${issuer}/entries`,intents:[]}}}).entry,false);
  assert.equal(caps({...floor,features:{'authorization-entry.v1':{endpoint:`${issuer}/entries`,intents:['teleport']}}}).entry,false);
  assert.deepEqual(caps({...floor,features:entry(['login','teleport'])}).intents,['login']);
  assert.equal(caps({...floor,features:{'authorization-entry.v1':{endpoint:'https://other.example/entries',intents:['login']}}}).entry,false,'feature endpoints stay on the issuer origin');
});

test('bounded containers, unknown features and versions ignored, highest implemented version wins',()=>{
  const declaration=readDeclaration({...floor,features:{...entry(['login']),'authorization-entry.v7':{anything:true},'teleport.v1':{},'Bad.Key':{},'authorization-entry.v2':{endpoint:`${issuer}/x`,intents:['login']}},unknown_member:{nested:true}},issuer);
  assert.equal(declaration.features['authorization-entry'].version,1);assert.equal(declaration.features.teleport,undefined);
  const oversize=readDeclaration({...floor,features:{'authorization-entry.v1':{endpoint:`${issuer}/entries`,intents:['login'],padding:'x'.repeat(declarationLimits.featureBytes)}}},issuer);
  assert.equal(oversize.features['authorization-entry'],undefined);assert.ok(oversize.warnings.includes('authorization-entry.v1'));
  const many=Object.fromEntries(Array.from({length:declarationLimits.features+1},(_,i)=>[`f${i}.v1`,{}]));
  assert.deepEqual(readDeclaration({...floor,features:{...many,...entry()}},issuer).features,{},'an oversized container is ignored as a whole');
  assert.deepEqual(readDeclaration({...floor,features:[1]},issuer).features,{});
  const profiles=Object.fromEntries(Array.from({length:declarationLimits.profiles+1},(_,i)=>[`https://p${i}.example/v1`,{}]));
  assert.deepEqual(readDeclaration({...floor,profiles},issuer).profiles,{});
});

test('components profile: member validation, binding and cross-checks remove only what fails',()=>{
  const profile=overrides=>caps({...full,profiles:{[COMPONENTS_V1]:{...componentsDeclaration(issuer),...overrides}}},{identityCredential:true,defaultIssuer:issuer});
  for(const bad of [{embed_origin:issuer},{embed_origin:'https://app.example'},{embed_origin:'https://embed.idp.example/path'},{embed_origin:'http://embed.idp.example'},{embed_origin:'https://10.0.0.1'},{protocol:[2]},{protocol:[]},{parts:'x'}])
    assert.equal(profile(bad).profile,false,JSON.stringify(bad));
  // No recognised binding: identity-bearing parts are absent, sign-in remains.
  const unbound=profile({credential_binding:['other.v9']});assert.equal(unbound.islands.avatar,null);assert.equal(unbound.islands.switcher,null);assert.ok(unbound.islands.signIn);
  // Unknown parts and unimplemented versions are ignored.
  const parts=profile({parts:{avatar:{versions:[9]},'sign-in':{versions:[1,2]},teleporter:{versions:[1]}}});assert.equal(parts.islands.avatar,null);assert.equal(parts.islands.signIn.version,1);
  // Without identity-optional login, flow parts are absent.
  assert.equal(caps({...full,features:entry(['select-account'])}).islands.signIn,null);
  assert.equal(profile({manage_url:'https://evil.example/apps'}).manageUrl,issuer+'/');
  assert.deepEqual(profile({theme_tokens:['surface','font','radius']}).themeTokens,['surface','radius']);
  // FedCM is delegated to an island only for the default provider or an allowlisted issuer (profile §2.1).
  const fedcmParts=overrides=>caps({...full,profiles:{[COMPONENTS_V1]:componentsDeclaration(issuer,{fedcm:true})}},{identityCredential:true,...overrides});
  assert.equal(fedcmParts({defaultIssuer:issuer}).islands.signIn.fedcm,true);
  assert.equal(fedcmParts({defaultIssuer:'https://other.example'}).islands.signIn.fedcm,false);
  assert.equal(fedcmParts({defaultIssuer:'https://other.example',islandIssuers:[issuer]}).islands.signIn.fedcm,true);
});

test('island policy: auto by default, off disables, an allowlist restricts to listed issuers',()=>{
  assert.equal(caps(full).profile,true);
  assert.equal(caps(full,{islands:'off'}).profile,false);
  assert.equal(caps(full,{islandIssuers:['https://other.example']}).profile,false);
  assert.equal(caps(full,{islandIssuers:[issuer]}).profile,true);
});

test('runtime degradation is per issuer, dependent flags inherit it, and it never reverses',()=>{
  const store=new CapabilityStore(),other='https://other.example',events=[];
  store.subscribe(value=>events.push(value));
  store.remember(readDeclaration(full,issuer,{}));store.remember(readDeclaration({...full,issuer:other,...Object.fromEntries(['authorization_endpoint','token_endpoint','rpc_endpoint','jwks_uri','authorization_request_endpoint','revocation_endpoint'].map(key=>[key,full[key].replace(issuer,other)])),features:{'authorization-entry.v1':{endpoint:`${other}/entries`,intents:['login']}},profiles:{}},other,{}));
  store.degrade(issuer,'authorization-entry');
  const degraded=store.capabilities(issuer,{identityCredential:true});
  assert.equal(degraded.entry,false);assert.equal(degraded.fedcm,false,'fedcm depends on the entry');assert.equal(degraded.dpop,false);assert.equal(degraded.islands.signIn,null);
  assert.equal(store.capabilities(other).entry,true,'no cross-issuer degradation');
  store.remember(readDeclaration(full,issuer,{}));assert.equal(store.capabilities(issuer).entry,false,'a refetch never reverses a degradation');
  store.degrade(issuer,'part:avatar');assert.equal(store.capabilities(issuer).islands.avatar,null);
  assert.deepEqual(events,[issuer,other,issuer,issuer]);
});

test('declarations are cached for the HTTP freshness lifetime, capped at one hour',()=>{
  let now=0;const store=new CapabilityStore({clock:()=>now}),declaration=readDeclaration(floor,issuer);
  const headers=value=>({headers:{get:()=>value}});
  assert.equal(freshness(headers('max-age=999999')),3600000);assert.equal(freshness(headers('no-store')),0);assert.equal(freshness(headers(null)),300000);
  store.remember(declaration,freshness(headers('max-age=60')));
  assert.ok(store.declaration(issuer));now=61000;assert.equal(store.declaration(issuer),null);assert.ok(store.declaration(issuer,{stale:true}));
  assert.ok(Object.isFrozen(declaration)&&Object.isFrozen(declaration.features));
});
