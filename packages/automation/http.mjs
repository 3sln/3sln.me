export const automationAllowedMethods=path=>({'/api/automation/tools':['GET'],'/api/automation/grant':['PUT','DELETE'],'/api/automation/prepare':['POST'],'/api/automation/confirm':['POST'],'/api/automation/invoke':['POST']})[path]??null;
export async function automationRoutes({path,request,owner,object,body,json}){
 if(!automationAllowedMethods(path))return null;
 const device=owner.devices?.find(d=>d.current);if(!device)throw Object.assign(Error('Active browser session unavailable.'),{code:'unauthorized',status:401});
 const s={id:device.id,expiresAt:owner.expiresAt},id=owner.account.id;
 if(path.endsWith('/tools'))return json(await object.automationTools(id,s));
 if(path.endsWith('/grant'))return json(request.method==='DELETE'?await object.automationRevoke(id,s):await object.automationGrant(id,s,await body(request)));
 const method={'/api/automation/prepare':'automationPrepare','/api/automation/confirm':'automationConfirm','/api/automation/invoke':'automationInvoke'}[path];return json(await object[method](id,s,await body(request)));
}
