import c0 from '../../docs/artefacts/profile-v1.json' with {type:'json'};
import c1 from '../../docs/artefacts/preferences-v1.json' with {type:'json'};
import c2 from '../../docs/artefacts/object-storage-v1.json' with {type:'json'};
import c3 from '../../docs/artefacts/resource-descriptor-v1.json' with {type:'json'};
import c4 from '../../docs/artefacts/resource-scoping-v1.json' with {type:'json'};
import c5 from '../../docs/artefacts/app-messages-v1.json' with {type:'json'};
import c6 from '../../docs/artefacts/event-bus-v1.json' with {type:'json'};
import {digest,canonical} from '../core/records.mjs';
let cached;
export function consentContracts(){return cached??=Promise.all([c0,c1,c2,c3,c4,c5,c6].map(async schema=>[schema.$id,{schema,digest:await digest(crypto,canonical(schema))}])).then(Object.fromEntries);}
