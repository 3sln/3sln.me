// LA7 owner APIs: account routing is authenticated; the federation shard repeats owner and mutation checks.
import {json} from './shared.mjs';
import {deviceAuthorizationEnabled} from '../device-grant.mjs';
export const allowedMethods=path=>path==='/api/app-sessions'?['GET','DELETE']:path.startsWith('/api/app-sessions/')?['DELETE']:null;
export const stages={async beforeActivity({request,env,path,context}){
 if(!deviceAuthorizationEnabled(env)||!allowedMethods(path))return;
 const authority=env.FEDERATION_AUTHORITY;if(!authority?.appSessions||!authority.ready())return request.method==='GET'?json({sessions:[]}):json({error:'not_found'},404);
 if(request.method==='GET'&&path==='/api/app-sessions')return json(await authority.appSessions(context));
 if(request.method==='DELETE'){const id=path.slice('/api/app-sessions/'.length);return json(await authority.appSessions(context,path==='/api/app-sessions'?{all:true}:{id}));}
 return json({error:'method_not_allowed'},405);
}};
