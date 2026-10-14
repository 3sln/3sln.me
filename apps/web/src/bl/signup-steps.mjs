export const paidSignupPlan=value=>['paid','plus','ultra'].includes(value);
export const signupRequiresContact=state=>state.config.signupContactRequired===true||state.signupMode==='system';
export function signupSteps(state){return [...state.signupMode==='system'?['invitation']:state.signupMode==='onboarding'?['onboarding','name']:[],'method',...state.signupMode!=='onboarding'&&paidSignupPlan(state.signupPlan)?['plan']:[],...signupRequiresContact(state)?['contact',...state.signupChannel==='email'?['email']:[]]:[],'terms','credential'];}
export function signupStep(state){const steps=signupSteps(state);return steps.includes(state.signupStep)?state.signupStep:steps[0];}
