import {tagDisplay} from '../../../../packages/messaging/tags.mjs';
import {h,interfaceText} from './release-primitives.mjs';
// Tags are IDs: system labels are catalogue source text; owner labels/unknown IDs stay literal and isolated.
export function tagPill(id,state){const d=tagDisplay(id,state?.data?.tagLabels?.labels);return d.system?h('span',interfaceText(d.label)).attrs({title:id}).classes('pill','system-tag',...d.suspected?['suspected-tag']:[]):h('span',h('bdi',d.label).attrs({dir:'auto'})).attrs({translate:'no',title:d.label===id?null:id}).classes('pill');}
