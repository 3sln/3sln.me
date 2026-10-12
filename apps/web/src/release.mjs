import {Engine,dodo,watch,queryCell} from './shared/stack.mjs';
import APIProvider from './providers/api.mjs';
import BrowserProvider,{isTextInputTarget} from './providers/browser.mjs';
import RecoveryFileProvider from './providers/recovery-file.mjs';
import PortalAccessProvider from './providers/portal-access.mjs';
import {portalContributionsProvider,composePortalViews,RunPortalCommand,compileKeybindings,resolveKeybinding,normalizeKeyStroke,portalContext} from '/packages/portal/index.mjs';
import {builtInModules,defaultKeybindings} from './shared/portal-modules.mjs';
import {createLocalization,catalogueForContributions} from './shared/i18n.mjs';
import localizeTree from './ui/localize.mjs';
import BrowserStateProvider from './providers/browser-state.mjs';
import * as actions from './bl/release.mjs';
import createApp from './ui/release-app.mjs';

// Composition is the only layer naming concrete browser resources and domain
// Actions. Components receive the Query projection and bubble native intents.
const root=document.getElementById('app');
const engine=new Engine({providers:{api:APIProvider,browser:BrowserProvider,state:BrowserStateProvider,portalContributions:portalContributionsProvider(builtInModules),portalAccess:PortalAccessProvider,recoveryFile:RecoveryFileProvider}});
const registry=await engine.container.use(['portalContributions'],({portalContributions})=>portalContributions);
// Registry data is immutable; this read composes UI factories once per locale.
const surfaces=Object.fromEntries(['en','es'].map(locale=>{const localization=createLocalization({locale,catalogue:catalogueForContributions(registry.list('translations'),locale)}),localize=tree=>localizeTree(tree,localization),views=composePortalViews(registry,{t:localization.t,number:localization.number,date:localization.date,localize});return [locale,createApp({views,localize})];}));
const cancelRecovery=await engine.container.use(['recoveryFile'],({recoveryFile})=>recoveryFile.cancel);
const captureSubmission=await engine.container.use(['browser'],({browser})=>browser.captureSubmission);
const readModel=await engine.container.use(['state'],({state})=>state.snapshot);
const constructors={
  signup:actions.SignUp,signin:actions.SignIn,signout:actions.SignOut,
  'start-recovery':actions.StartRecovery,'inspect-recovery':actions.InspectRecovery,
  'recover-account':actions.RecoverAccount,'encrypt-recovery':actions.EncryptRecovery,
  'verify-recovery':actions.VerifyRecovery,
  'add-recovery-question':actions.EditRecoveryQuestion,'remove-recovery-question':actions.EditRecoveryQuestion,
  'move-recovery-question':actions.EditRecoveryQuestion,'edit-recovery-question':actions.EditRecoveryQuestion,'set-pending-passkey':actions.SetPendingPasskey,
  'set-pending-password':actions.SetPendingPassword,'prepare-recovery':actions.PrepareRecovery,
  'download-recovery':actions.DownloadRecovery,'confirm-recovery':actions.ConfirmRecovery,
  'email-signin':actions.RequestEmailSignIn,'confirm-email':actions.ConfirmEmail,
  unsubscribe:actions.UnsubscribeChannel,'send-contact-message':actions.SendContactMessage,
  'load-account':actions.LoadAccount,'recheck-session':actions.RecheckSession,
  'read-message':actions.ReadMessage,'update-message':actions.UpdateMessage,
  'organize-message':actions.OrganizeMessage,'create-collection':actions.CreateCollection,
  'create-contact':actions.CreateContact,'share-contact':actions.ShareContact,
  'copy-contact-link':actions.CopyContactLink,'save-contact-link':actions.SaveContactLink,
  'revoke-contact':actions.RevokeContact,'quarantine-contact':actions.QuarantineContact,
  'create-rule':actions.CreateRule,'toggle-rule':actions.ToggleRule,'delete-rule':actions.DeleteRule,
  'save-resource':actions.SaveResource,'verify-resource':actions.VerifyResource,
  'disconnect-resource':actions.DisconnectResource,'save-notifications':actions.SaveNotifications,
  'disable-notifications':actions.DisableNotifications,'remove-push-device':actions.RemovePushDevice,
  'link-email':actions.LinkEmail,'revoke-grant':actions.RevokeGrant,
  'add-passkey':actions.AddPasskey,'remove-passkey':actions.RemovePasskey,
  'revoke-device':actions.RevokeDevice,'revoke-other-devices':actions.RevokeOtherDevices,
  'start-device':actions.StartDeviceLogin,'cancel-device':actions.CancelDeviceLogin,
  'inspect-device':actions.InspectDeviceLogin,'approve-device':actions.ApproveDeviceLogin,
  'deny-device':actions.DenyDeviceLogin,'set-language':actions.SetLanguage,
  'save-shortcut':actions.SetShortcut,'reset-shortcut':actions.ResetShortcuts,
  'reset-shortcuts':actions.ResetShortcuts
};
function dispatchIntent(input){let detail=input;if(input.form){detail={...input,operationId:captureSubmission(input.form)};delete detail.form;}if(detail.kind==='run-command'){dispatchCommand(detail.id);return;}const Action=constructors[detail.kind]??actions.NavigateSpace;engine.dispatch(new Action(detail));}
function dispatchCommand(id){try{engine.dispatch(new RunPortalCommand(registry,id)).next('complete').catch(error=>engine.dispatch(new actions.ReportCommandError({message:error.message})));}catch(error){engine.dispatch(new actions.ReportCommandError({message:error.message}));}}
root.addEventListener('3sln-intent',event=>{event.stopPropagation();dispatchIntent(event.detail);});
engine.feed.addEventListener('portal-command-requested',event=>dispatchCommand(event.detail.id));
engine.feed.addEventListener('portal-intent',event=>dispatchIntent(event.detail));
engine.feed.addEventListener('shortcut-chord-expired',event=>engine.dispatch(new actions.ClearShortcutChord(event.detail)));
// Native default prevention must use the provider's current read handle, not
// wait for the next paint of the Query Cell. No second keyboard model is held.
function keydown(event){if(event.repeat)return;const model=readModel(),stroke=normalizeKeyStroke(event,navigator.platform);if(!stroke)return;const context=portalContext(model,{textInputFocus:isTextInputTarget(event.target)});const result=resolveKeybinding(compileKeybindings(defaultKeybindings(registry),model.keybindingOverrides??[],registry.list('commands')),context,model.keyChord,stroke);if(result.consumed){event.preventDefault();event.stopPropagation();}if(!result.consumed&&context.textInputFocus){if(model.keyChord?.strokes?.length)engine.dispatch(new actions.ClearShortcutChord({startedAt:model.keyChord.startedAt}));return;}engine.dispatch(new actions.PressShortcut({stroke}));}
window.addEventListener('keydown',keydown);
engine.feed.addEventListener('device-poll-due',()=>engine.dispatch(new actions.PollDeviceLogin()));
engine.feed.addEventListener('network-changed',event=>engine.dispatch(new actions.NetworkChanged({online:event.detail})));
const stateCell=queryCell(engine.query(new actions.BrowserState())),contextCell=queryCell(engine.query(new actions.PortalContext()));
dodo.reconcile(root,[watch(stateCell,state=>watch(contextCell,context=>{return surfaces[state.locale??'en']({...state,context});} ))]);
engine.dispatch(new actions.InitializeSpace());
window.addEventListener('pagehide',()=>{cancelRecovery();window.removeEventListener('keydown',keydown);dodo.reconcile(root,[]);engine.dispose();},{once:true});
