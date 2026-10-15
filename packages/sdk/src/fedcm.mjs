// App-as-RP FedCM transport (auth.md "FedCM exchange", adaptive sign-in §11.6),
// loaded only for providers that declare `fedcm.v1`. It creates the
// authorization entry with presentation "fedcm", asks the browser for an
// assertion with `mediation:'required'` (never auto-selected), and validates the
// returned {v,code,state,iss} exactly as callback parameters. Non-user failures
// report `unavailable`, so the controller continues with a popup or, once the
// click's activation has expired, a redirect. Provisional: no provider declares
// fedcm.v1 yet; verified against testing.mjs only.
// Errors raised before any browser UI could show; everything else may be a user dismissal,
// which browsers deliberately report as a generic NetworkError/IdentityCredentialError.
const beforeUI=new Set(['NotAllowedError','NotSupportedError','SecurityError','InvalidStateError']);

export async function authorizeWithFedCM({intent,params,client,navigator,capabilities,failures,requests,uiLocales,colorScheme,extensions,signal}){
  const issuer=capabilities.issuer;let begun;
  try{
    begun=await client.beginAuthorization({intent,identity:params.identity,host:params.host,requests,maxAge:params.maxAge,uiLocales,colorScheme,presentation:'fedcm',extensions:typeof extensions==='function'?await extensions({intent}):undefined,signal});
  }catch(error){
    if(error?.code==='canceled'||error?.name==='AbortError')return {outcome:'canceled'};
    return ['invalid-identity','identity-required','discovery-unavailable','unsupported-provider','unregistered-client','no-provider'].includes(error?.code)?{outcome:'discovery-error',code:error.code}:{outcome:'unavailable'};
  }
  if(begun.kind!=='provider')return {outcome:'discovery-error',code:'no-provider',fallback:begun};
  const configURL=begun.declaration.features.fedcm?.configUrl,clientId=client.clientIdFor(issuer);
  let credential;
  try{
    credential=await navigator.credentials.get({identity:{providers:[{configURL,clientId,params:{v:1,entry:begun.entryId}}],mode:'active',context:'signin'},mediation:'required',signal});
  }catch(error){
    client.cancelLogin(begun.state);
    // Once the dialog may have shown, any rejection ends the flow (never a surprise redirect after a dismissal).
    if(!beforeUI.has(error?.name))return {outcome:'canceled'};
    // Twice unavailable for non-user reasons degrades FedCM for this issuer (decision note §4); an expired
    // activation (NotAllowedError) is not evidence that FedCM is missing.
    if(error.name!=='NotAllowedError'){const count=(failures.get(issuer)??0)+1;failures.set(issuer,count);if(count>=2)client.capabilities.degrade(issuer,'fedcm');}
    return {outcome:'unavailable'};
  }
  let token;try{token=typeof credential?.token==='string'?JSON.parse(credential.token):null;}catch{token=null;}
  if(!token||typeof token!=='object'||Object.keys(token).sort().join()!=='code,iss,state,v'||token.v!==1){client.cancelLogin(begun.state);return {outcome:'network-error',code:'invalid-callback'};}
  try{await client.completeCode(token,{signal,presentation:'fedcm'});return {outcome:'completed'};}
  catch(error){return error?.code==='canceled'?{outcome:'canceled'}:{outcome:'network-error',code:error?.code==='invalid-callback'?'invalid-callback':'network-error'};}
}
