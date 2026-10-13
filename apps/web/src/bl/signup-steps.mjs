export function signupSteps(state){return ['method',...state.config.signupContactRequired===true?['contact',...state.signupChannel==='email'?['email']:[]]:[],'terms','credential'];}
export function signupStep(state){const steps=signupSteps(state);return steps.includes(state.signupStep)?state.signupStep:'method';}
