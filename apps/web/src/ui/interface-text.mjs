import {createLocalization} from '../shared/i18n.mjs';
const english=createLocalization({locale:'en'});
// A pure text value records an interface key separately from its user-supplied
// variables. It renders in component tests and is translated by the UI factory.
export class InterfaceText extends String {
  constructor(source,variables={}){super(english.t(source,variables));this.source=source;this.variables=variables;Object.freeze(this);}
}
export const interfaceText=(source,variables)=>new InterfaceText(source,variables);
