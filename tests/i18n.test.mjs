import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalization,resolveLocale,createTranslator,ObjectCatalogue,catalogueForContributions} from '../packages/i18n/index.mjs';
import {catalogues} from '../packages/i18n/catalogues.mjs';
test('actual bab runtime translates source text, scoped messages, interpolation and fallback',()=>{
 const tr=createTranslator({locale:'es',catalogue:new ObjectCatalogue({'':{'Hello {name}':'Hola {name}'},sample:{'Hello {name}':'Buenas {name}'}})});
 assert.equal(String(tr('Hello {name}',{name:'Ray'})),'Hola Ray');assert.equal(String(tr.scope('sample')('Hello {name}',{name:'Ray'})),'Buenas Ray');
 assert.equal(String(tr('Missing {name}',{name:'<script>text</script>'})),'Missing <script>text</script>');assert.equal(String(tr('Unknown {param}',{})),'Unknown {param}');
 assert.equal(String(tr('{#} days',{count:1}).singular('{#} day')),'1 day');assert.equal(String(tr('{#} days',{count:2}).singular('{#} day')),'2 days');
});
test('English and Spanish translations cover UI catalogs, with locale-safe formatting',()=>{
 const en=createLocalization({locale:'en'}),es=createLocalization({locale:'es-MX'});
 assert.equal(en.t('Sign in'),'Sign in');assert.equal(es.t('Sign in'),'Iniciar sesión');assert.equal(es.t('New to {brand}? ',{brand:'TuCasa'}),'¿Nuevo en TuCasa? ');
 assert.equal(es.t.plural('{#} messages','{#} message',1),'1 mensaje');assert.equal(es.t.plural('{#} messages','{#} message',2),'2 mensajes');
 assert.equal(es.number(1234.5),new Intl.NumberFormat('es').format(1234.5));assert.equal(es.date(0,{timeZone:'UTC',year:'numeric'}),'1970');assert.equal(es.date(NaN),'Fecha desconocida');
 assert.equal(es.direction,'ltr');assert.equal(resolveLocale('es-MX'),'es');assert.equal(resolveLocale('not_a_locale'),'en');assert.equal(resolveLocale('ar'),'en');
 assert.equal(en.t('User-authored content stays unchanged'),'User-authored content stays unchanged');assert.ok(Object.keys(catalogues.es['']).length>350);assert.deepEqual(Object.keys(catalogues.en['']).sort(),Object.keys(catalogues.es['']).sort());
});
test('bab missing-message hook is once per source/scope and module catalog overrides base',()=>{
 const missing=[],local=createLocalization({locale:'es',onMissing:(scope,id)=>missing.push([scope,id]),catalogue:{'':{'Sign in':'Entrar'}}});
 assert.equal(local.t('Sign in'),'Entrar');assert.equal(local.t('Missing'),'Missing');local.t('Missing');assert.deepEqual(missing,[['','Missing']]);assert.equal(local.t('Sign out'),'Cerrar sesión');
});

test('translation contributions use real bab catalogs without changing unknown source fallback',()=>{
 const catalogue=catalogueForContributions([{catalogue:{es:{'':{'Module title':'Título del módulo'}}}}],'es');
 const local=createLocalization({locale:'es',catalogue});assert.equal(local.t('Module title'),'Título del módulo');assert.equal(local.t('Sign in'),'Iniciar sesión');
});
