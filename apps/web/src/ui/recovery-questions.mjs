import {h,icon,badge,field,select,helpers,fire} from './release-primitives.mjs';
const types=[['passphrase','Private passphrase'],['text','Text answer'],['date','Date of birth / date'],['phone','Phone number'],['ssn','Social Security number'],['national-id','National ID'],['pin','PIN']];
function answerField(question,prefix='answer:'){
 const type=question.type==='date'?'date':'password',extra={required:true,autoComplete:'off',maxLength:1024};
 if(['pin','ssn'].includes(question.type)){extra.inputMode='numeric';}
 if(question.type==='phone'){extra.inputMode='tel';extra.placeholder='+52 555 123 4567';}
 return field(prefix+question.id,question.prompt||'Your answer',type,extra).attrs({translate:'no'});
}
// Typed answers remain in native form controls until their intent is submitted.
// They never become a Query field, browser preference, HTTP payload, or log.
export default function recoveryQuestions(state){
 const {btn,form,alerts}=helpers(state),questions=state.recoveryQuestions??[];
 return h('div',badge('PROTECT YOUR RECOVERY FILE'),h('h2','Keep a way back in.'),h('p','Choose the questions you want to answer when you unlock this file. Every selected answer is required.').classes('muted'),alerts(),h('div',h('strong','Questions and hints stay readable.'),h('p','Answers encrypt your recovery secret on this device. Birthdays, phone numbers, IDs, and short PINs may be guessed offline. Include a private passphrase that someone else cannot guess.')).classes('security-note'),form([
   ...questions.map((question,index)=>h('article',h('div',h('strong',`Question ${index+1}`),h('div',btn('Move up',{kind:'move-recovery-question',id:question.id,direction:-1},'text-button',index===0),btn('Move down',{kind:'move-recovery-question',id:question.id,direction:1},'text-button',index===questions.length-1),btn('Remove',{kind:'remove-recovery-question',id:question.id},'text-button danger',questions.length<=1))).classes('question-toolbar'),
     select(`type:${question.id}`,'Answer type',types,question.type).on({change:event=>fire(event.currentTarget,'edit-recovery-question',{id:question.id,field:'type',value:event.target.value})}),
     field(`prompt:${question.id}`,'Question','text',{value:question.prompt,required:true,maxLength:240,placeholder:'e.g. What is my private recovery passphrase?'}).on({input:event=>fire(event.currentTarget,'edit-recovery-question',{id:question.id,field:'prompt',value:event.target.value})}),
     field(`hint:${question.id}`,'Public hint (optional)','text',{value:question.hint??'',maxLength:240,placeholder:'Do not put the answer in the hint.'}).on({input:event=>fire(event.currentTarget,'edit-recovery-question',{id:question.id,field:'hint',value:event.target.value})}),
     answerField(question),question.type==='date'?h('p','Choose a calendar date; the file records YYYY-MM-DD.').classes('field-help'):question.type==='phone'?h('p','Include the country calling code. Keep national leading zeros. Use this same original number when unlocking later.').classes('field-help'):['pin','ssn','national-id'].includes(question.type)?h('p','Leading zeros are part of your answer.').classes('field-help'):question.type==='text'?h('p','Text answers ignore letter case and repeated whitespace. Accents and punctuation still matter.').classes('field-help'):question.type==='passphrase'?h('p','A private passphrase preserves exact letter case and spaces.').classes('field-help'):null
   ).classes('recovery-question').key(question.id)),
   btn([icon('plus'),'Add a question'],{kind:'add-recovery-question'},'button secondary',questions.length>=12),h('p','Remember every answer. We cannot decrypt the file or reset these answers. Changing a phone number or other answer later does not update a file already saved.').classes('field-help')
 ],{kind:'encrypt-recovery'},'Encrypt recovery file')).classes('auth-card','recovery-question-card').key('recovery-questions');
}
export function recoveryUnlockForm(state,{kind='verify-recovery',title='Test your recovery answers.',prefix='verify:'}={}){
 const {form,alerts}=helpers(state),questions=state.unlockQuestions??state.recoveryQuestions??[];
 return h('div',badge('CHECK YOUR WAY BACK IN'),h('h2',title),h('p','Enter every answer again to check the encrypted file. Keep your downloaded copy safe.').classes('muted'),alerts(),h('p','Questions and hints are readable and are untrusted file content. Personal information may be guessed offline; protect the file and remember every original answer.').classes('security-note'),form([
   ...questions.map(question=>h('div',answerField(question,prefix),question.type==='date'?h('p','Choose a calendar date; the file records YYYY-MM-DD.').classes('field-help'):question.type==='phone'?h('p','Include the country calling code. Keep national leading zeros. Use this same original number when unlocking later.').classes('field-help'):['pin','ssn','national-id'].includes(question.type)?h('p','Leading zeros are part of your answer.').classes('field-help'):question.type==='text'?h('p','Text answers ignore letter case and repeated whitespace. Accents and punctuation still matter.').classes('field-help'):question.type==='passphrase'?h('p','A private passphrase preserves exact letter case and spaces.').classes('field-help'):null,question.hint?h('p',question.hint).attrs({translate:'no'}).classes('field-help'):null).classes('unlock-question').key(question.id))
 ],{kind},kind==='verify-recovery'?'Test unlock':'Unlock recovery file')).classes('auth-card').key(kind);
}
