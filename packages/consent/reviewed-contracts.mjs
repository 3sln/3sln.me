// CX-1 catalogue data. Exact immutable source pins, not a host-wide review badge.
// Copy describes allowed effects only. Local/provisional; human release sign-off
// remains in docs/release/events-consent-review.md and docs/spec/security.md.
const method=(effect,en,es,categories=[])=>({effect,categories,text:{en,es}});
const base='https://3sln.me/artefacts/contracts/';
export const EVENT_BUS_CONTRACT='https://spec.bindle.example/contracts/event-bus/v1';
export const REVIEWED_CONTRACTS=freeze({
 [base+'profile/v1']:{source:'docs/artefacts/profile-v1.json',digest:'sha256-W36u9unuZTo-ARVFOwxsdwoYGeI6NjLMryA1vtcACzs',methods:{read:method('read','See your name, handle and picture','Ver tu nombre, alias y foto',['personal-data'])}},
 [base+'preferences/v1']:{source:'docs/artefacts/preferences-v1.json',digest:'sha256-ZDGpUDUYWRa161-VVYGh5cdVqCxTVJ3bifeceFEDud4',methods:{read:method('read','See your approved shared settings','Ver tus ajustes compartidos autorizados',['personal-data'])}},
 [base+'object-storage/v1']:{source:'docs/artefacts/object-storage-v1.json',digest:'sha256-EHTB47yMoYbtZXOYZME_e1_spi9QW6d5f8O2bOmgoYo',methods:{
  capabilities:method('read','See available file operations','Ver las operaciones disponibles para archivos'),get:method('read','See files','Ver archivos'),put:method('write','Add and replace files','Añadir y reemplazar archivos'),delete:method('destructive',"Delete files. This can't be undone.",'Eliminar archivos. No se puede deshacer.'),presign:method('write','Create temporary links to read or upload files','Crear enlaces temporales para leer o subir archivos'),
 }},
 [base+'resource-descriptor/v1']:{source:'docs/artefacts/resource-descriptor-v1.json',digest:'sha256-gQtIb95zYizUv5iGKFXDDsR8MgxVBz2xgjrg0vVhog0',methods:{describe:method('read','See resource details and available operations','Ver los detalles del recurso y las operaciones disponibles')}},
 [base+'resource-scoping/v1']:{source:'docs/artefacts/resource-scoping-v1.json',digest:'sha256-aBXaODzzKmFcbNXqefqFB66M2q9LXIuSeYAW5XVmy34',methods:{describe:method('read','See available access limits','Ver los límites de acceso disponibles')}},
 [base+'app-messages/v1']:{source:'docs/artefacts/app-messages-v1.json',digest:'sha256-yz4rGPd4e0t43q7ckSU26LoqEkpRxpDYo4IreLzcHkg',methods:{createOwn:method('write','Send you notifications in Activity','Enviarte notificaciones en Actividad')}},
 [EVENT_BUS_CONTRACT]:{source:'docs/artefacts/event-bus-v1.json',digest:'sha256-SE2L-x0k3nOgb8dRdjlDg_hcgMdDM9pPcMaJjzjQs4Y',methods:{read:method('read','See events in this feed','Ver eventos de esta fuente'),publish:method('write','Add events to this feed','Añadir eventos a esta fuente'),subscribe:method('read','Receive notices of new events in this feed','Recibir avisos de nuevos eventos de esta fuente'),unsubscribe:method('read','Stop notices of new events in this feed','Dejar de recibir avisos de nuevos eventos de esta fuente')}},
});
function freeze(value){for(const child of Object.values(value))if(child&&typeof child==='object')freeze(child);return Object.freeze(value);}
