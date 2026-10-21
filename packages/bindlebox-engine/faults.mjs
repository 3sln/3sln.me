// BindleBox's own safe fault vocabulary; no dependency on the provider composition.
export class MailboxFault extends Error {
 constructor(code,message=code,status){super(message);this.name='MailboxFault';this.code=code;if(status!==undefined)this.status=status;}
}
export const fault=(code,message,status)=>{throw new MailboxFault(code,message,status);};
const CODE=/^[a-z][a-z0-9_]{0,63}$/;
export function faultOf(error){
 if(!error||typeof error.code!=='string'||!CODE.test(error.code))return {code:'internal_error',message:'The operation could not be completed.',status:500};
 return {code:error.code,message:typeof error.message==='string'&&error.message?error.message:error.code,...Number.isSafeInteger(error.status)?{status:error.status}:{},...Number.isSafeInteger(error.retryAfter)&&error.retryAfter>0?{retryAfter:error.retryAfter}:{}};
}
