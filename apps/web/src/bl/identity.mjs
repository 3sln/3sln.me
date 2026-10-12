import {OwnerFlow,snapshot,publish} from './owner-flow.mjs';
import {verifyNameAssignment} from '../../../../packages/recovery/identity-backup.mjs';

export class ClaimHandle extends OwnerFlow {
  async perform(r,ctx,detail){
    const account=snapshot(r).data?.account??snapshot(r).session.account;
    if(account.paidHandle)throw Error('This identity already has its permanent custom handle.');
    if(detail.values?.confirmed!=='on')throw Error('Confirm that this is your one permanent custom handle.');
    const handle=detail.values?.handle;
    if(typeof handle!=='string'||!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(handle))throw Error('Use 3–32 lowercase letters, digits, underscores or hyphens, starting with a letter or digit.');
    await r.api.request('/api/auth/handles/claim',{handle});
    const data=await r.api.get('/api/account');
    publish(r,ctx,{data,session:{account:data.account},notice:'Your permanent custom handle is ready. Your identity and recovery file stay the same.',error:''});
  }
}

export class DownloadNameCertificate extends OwnerFlow {
  async perform(r,ctx,detail){
    const state=snapshot(r),account=state.data?.account??state.session.account;
    const handle=detail.handle??account.handle;
    if(handle!==account.handle&&handle!==account.paidHandle)throw Error('Choose one of your assigned handles.');
    const result=await r.api.request('/api/auth/handles/certificate',{handle});
    if(typeof result.content!=='string'||result.content.length>16384||typeof result.fileName!=='string'||result.fileName.length>128||!/^[a-zA-Z0-9_.-]+\.json$/.test(result.fileName))throw Error('The service returned an invalid name certificate.');
    const authority=await r.api.get('/api/recovery/authority');
    const certificate=await verifyNameAssignment(result.content,authority,{issuer:state.config.origin,entity:account.id,handle});
    if(!r.current())return;
    r.browser.download(result.fileName,JSON.stringify(certificate,null,2));
    publish(r,ctx,{notice:'Name certificate downloaded. It is public proof of your name assignment, separate from your private recovery file.',error:''});
  }
}
