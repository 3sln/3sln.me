// dodo writes every attribute it is given (null would become "null"), so optional attributes are omitted instead.
export {h} from '../../../../vendor/dodo/index.js';
export const defined=attributes=>Object.fromEntries(Object.entries(attributes).filter(([,value])=>value!==null&&value!==undefined));
