import {h,badge,helpers,interfaceText} from './release-primitives.mjs';
const refusal={
 'paid-required':'Developer contact links are currently available to paid accounts.',
 'developer-unavailable':'The platform developer account is not ready to receive messages.',
 'eligibility-unavailable':'Your eligibility could not be verified. Recheck your subscription or try again shortly.',
 'contact-unavailable':'Today’s developer contact link is unavailable or has been revoked.',
 'contact-capacity':'The developer has reached the contact-link limit. Try again later.'
};
export function developerContact(state){const {btn,date}=helpers(state),result=state.developerContact;return h('section',h('h2','Contact the developer'),h('p','Request a limited contact link for today. Availability depends on your subscription and the service’s early-access policy.').classes('muted'),result?.granted?h('div',badge('Platform developer'),h('p',interfaceText('This link expires {date} (UTC).',{date:new Date(result.expiresAt).toISOString().replace('T',' ').slice(0,16)})),h('p','Signed tags identify your plan and topic. They do not guarantee a response time.').classes('field-help'),h('div',...(result.requiredTags??[]).map(tag=>h('span',tag).attrs({translate:'no'}).classes('pill'))).classes('contact-tag-list'),btn('Open developer contact',{kind:'open-developer-contact'},'button primary'),btn('Copy contact link',{kind:'copy-developer-contact'},'button secondary')):result?h('p',Object.hasOwn(refusal,result.reason)?refusal[result.reason]:'Developer contact is not available right now. Try again later.').attrs({role:'status'}):null,btn('Request today’s contact link',{kind:'request-developer-contact'},'button secondary')).classes('panel','developer-contact-panel');}
