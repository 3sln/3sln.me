import {Action,Query} from '../../vendor/ngin/index.js';
export class Publications extends Query {static deps={publications:{operation:'list'}};fetch({publications}){return publications.list();}}
export class ListPublications extends Action {static deps={publications:{operation:'list'}};execute({publications}){return publications.list();}}
export class CreatePublication extends Action {static deps={publications:{operation:'create'}};constructor(value){super();this.value=value;}execute({publications}){return publications.create(this.value);}}
export class UpdatePublication extends Action {static deps={publications:{operation:'update'}};constructor({id,...value}){super();this.id=id;this.value=value;}execute({publications}){return publications.update(this.id,this.value);}}
export class DeletePublication extends Action {static deps={publications:{operation:'remove'}};constructor({id,revision}){super();this.id=id;this.revision=revision;}execute({publications}){return publications.remove(this.id,this.revision);}}
