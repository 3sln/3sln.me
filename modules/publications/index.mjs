import publicationsView from './ui.mjs';
import {CreatePublication,UpdatePublication,DeletePublication,ListPublications} from './bl.mjs';
export {PublicationsProvider,MemoryPublicationStorage} from './store.mjs';
export * from './bl.mjs';
export const PUBLICATIONS_CONTRACT='https://spec.bindle.example/contracts/publications/v1';
// A compile-time code contribution, shipped as an opt-in integration sample.
// A host must wire storage, an authorizer, HTTP adaptation and a UI projection.
export const publicationsModule=Object.freeze({id:'publications',dependencies:[],sample:true,contributions:{
 navigation:[{id:'publications',title:'Publications',view:'publications',icon:'document',order:100}],
 views:[{id:'publications',factory:publicationsView}],
 commands:[
  {id:'publications.create',title:'Create publication',capability:'publications.create',deps:CreatePublication.deps,execute:({publications},detail)=>publications.create(detail)},
  {id:'publications.update',title:'Edit publication',capability:'publications.update',deps:UpdatePublication.deps,execute:({publications},detail)=>publications.update(detail.id,{title:detail.title,body:detail.body,revision:detail.revision})},
  {id:'publications.delete',title:'Delete publication',capability:'publications.remove',deps:DeletePublication.deps,execute:({publications},detail)=>publications.remove(detail.id,detail.revision)}
 ],
 settings:[{id:'publications.pageSize',type:'integer',default:20,minimum:1,maximum:100,title:'Publications per page'}],
 translations:[{id:'publications',catalogue:{es:{'':{'Publications':'Publicaciones','Create publication':'Crear publicación','Edit publication':'Editar publicación','Delete publication':'Eliminar publicación'}}}}],
 contracts:[{id:PUBLICATIONS_CONTRACT,methods:['list','create','update','remove'],sample:true}],
 routes:[{id:'publications.list',method:'GET',path:'/api/publications',action:ListPublications,capability:'publications.list'},{id:'publications.create',method:'POST',path:'/api/publications',action:CreatePublication,capability:'publications.create'},{id:'publications.update',method:'PATCH',path:'/api/publications/:id',action:UpdatePublication,capability:'publications.update'},{id:'publications.delete',method:'DELETE',path:'/api/publications/:id',action:DeletePublication,capability:'publications.remove'}],
 keybindings:[]
}});
