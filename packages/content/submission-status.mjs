export const SUBMISSION_STATUS_MIME='application/vnd.bindle.submission-status+json';
export function submissionStatus(value){
 const invalid=()=>{throw new Error('Invalid submission status');};
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['type','message','actions'].includes(k))||!['success','info','warning','error'].includes(value.type)||typeof value.message!=='string'||Array.from(value.message).length>500||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value.message))invalid();
 if(value.actions!==undefined&&(!Array.isArray(value.actions)||value.actions.length>2))invalid();const actions=(value.actions||[]).map(a=>{if(!a||typeof a!=='object'||Array.isArray(a)||Object.keys(a).some(k=>!['label','href'].includes(k))||typeof a.label!=='string'||!a.label.trim()||Array.from(a.label).length>80||/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(a.label)||typeof a.href!=='string'||a.href.length>2048||/[\u0000-\u0020\u007f]/.test(a.href))invalid();let url;try{url=new URL(a.href);}catch{invalid();}if(url.protocol!=='https:'||url.username||url.password)invalid();return {label:a.label,href:url.href};});
 return {type:value.type,message:value.message,...actions.length?{actions}:{}};
}
