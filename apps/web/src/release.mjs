import * as googleDriveActions from './bl/google-drive.mjs';
import * as identityActions from './bl/identity.mjs';
import * as conversationActions from './bl/conversations.mjs';
import * as mcpActions from './bl/mcp.mjs';
import * as automationActions from './bl/automation.mjs';
import AutomationProvider from './providers/automation.mjs';
import {Engine,dodo,watch,queryCell} from './shared/stack.mjs';
import BeamingProvider from './providers/beaming.mjs';
import * as beamActions from './bl/beaming.mjs';
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
const engine=new Engine({providers:{automation:AutomationProvider,beaming:BeamingProvider,api:APIProvider,browser:BrowserProvider,state:BrowserStateProvider,portalContributions:portalContributionsProvider(builtInModules),portalAccess:PortalAccessProvider,recoveryFile:RecoveryFileProvider}});
const registry=await engine.container.use(['portalContributions'],({portalContributions})=>portalContributions);
// Registry data is immutable; this read composes UI factories once per locale.
const surfaces=Object.fromEntries(['en','es'].map(locale=>{const localization=createLocalization({locale,catalogue:catalogueForContributions(registry.list('translations'),locale)}),localize=tree=>localizeTree(tree,localization),views=composePortalViews(registry,{t:localization.t,number:localization.number,date:localization.date,localize});return [locale,createApp({views,localize})];}));
const cancelRecovery=await engine.container.use(['recoveryFile'],({recoveryFile})=>recoveryFile.cancel);
const captureSubmission=await engine.container.use(['browser'],({browser})=>browser.captureSubmission);
const readModel=await engine.container.use(['state'],({state})=>state.snapshot);
const prepareBeamDestination=await engine.container.use(['beaming'],({beaming})=>beaming.prepareDestination);
const constructors={
 'claim-handle':identityActions.ClaimHandle,'download-name-certificate':identityActions.DownloadNameCertificate,
 'start-google-drive':googleDriveActions.StartGoogleDrive,
 'clear-automation-review':automationActions.ClearAutomationReview,'load-automation':automationActions.LoadAutomation,'enable-automation':automationActions.EnableAutomation,'disable-automation':automationActions.DisableAutomation,'confirm-automation':automationActions.ConfirmAutomation,
 'load-mcp-request':mcpActions.LoadMCPRequest,'decide-mcp':mcpActions.DecideMCP,'load-mcp-grants':mcpActions.LoadMCPGrants,'revoke-bindle-grant':mcpActions.RevokeBindleGrant,'revoke-mcp-grant':mcpActions.RevokeMCPGrant,'disconnect-app':mcpActions.DisconnectApp,
 'load-conversations':conversationActions.LoadConversations,'open-conversation':conversationActions.OpenConversation,'create-conversation':conversationActions.CreateConversation,'conversation-action':conversationActions.ConversationAction,'conversation-reply':conversationActions.ConversationReply,'copy-conversation-access':conversationActions.CopyConversationAccess,
 'select-beam-file':beamActions.SelectBeamFiles,'decline-beam-file':beamActions.SelectBeamFiles,'remove-saved-contact':beamActions.RemoveSavedContact,'copy-saved-contact':beamActions.CopySavedContact,'load-beaming':beamActions.LoadBeaming,'stage-beam-files':beamActions.StageBeamFiles,'send-beam':beamActions.SendBeam,'accept-beam':beamActions.AcceptBeam,'reject-beam':beamActions.RejectBeam,'cancel-beam':beamActions.RejectBeam,'rename-device':beamActions.RenameDevice,'redeem-contact':beamActions.RedeemContact,'update-beam-grant':beamActions.UpdateBeamGrant,'save-profile':beamActions.SaveProfile,'create-beam-invite':beamActions.CreateBeamInvite,'redeem-beam-invite':beamActions.RedeemBeamInvite,'write-beam-nfc':beamActions.WriteBeamNFC,
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
  'reset-shortcuts':actions.ResetShortcuts,
  'load-billing':actions.LoadBilling,'billing-currency':actions.ChangeBillingCurrency,'review-plan-change':actions.ReviewPlanChange,'review-scheduled-cancel':actions.ReviewScheduledCancel,'confirm-scheduled-cancel':actions.ConfirmScheduledCancel,'cancel-plan-change-review':actions.CancelPlanChangeReview,'confirm-plan-change':actions.ConfirmPlanChange,'billing-checkout':actions.BillingCheckout,
  'save-semantic-preferences':actions.SaveSemanticPreferences,'billing-portal':actions.BillingPortal,'search-space':actions.SearchSpace,
  'search-next-page':actions.SearchSpace,'read-search-message':actions.ReadSearchMessage
};
function dispatchIntent(input){if(input.kind==='save-resource'&&readModel().modal?.provider?.id==='google-drive'){if(input.nativeEvent?.isTrusted!==true)return;input={...input,kind:'start-google-drive'};}if(['enable-automation','confirm-automation'].includes(input.kind)&&input.nativeEvent?.isTrusted!==true)return;let detail={...input};delete detail.nativeEvent;if(input.kind==='accept-beam'){if(!input.files?.length){engine.dispatch(new actions.ReportCommandError({message:'Select at least one file.'}));return;}detail={...input,destination:prepareBeamDestination(input.files,input.mode)};detail.destination.catch(()=>{});}if(input.form){detail={...detail,operationId:captureSubmission(input.form)};delete detail.form;}if(detail.kind==='run-command'){dispatchCommand(detail.id);return;}const Action=constructors[detail.kind]??actions.NavigateSpace;engine.dispatch(new Action(detail));if(detail.kind==='navigate'&&detail.view==='beaming')engine.dispatch(new beamActions.LoadBeaming());if(detail.kind==='navigate'&&detail.view==='conversations')engine.dispatch(new conversationActions.LoadConversations());if(detail.kind==='navigate'&&detail.view==='connected-apps')engine.dispatch(new mcpActions.LoadMCPGrants());if(detail.kind==='navigate'&&detail.view==='automation')engine.dispatch(new automationActions.LoadAutomation());}
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
engine.feed.addEventListener('beam-invite-opened',()=>engine.dispatch(new beamActions.LoadBeaming({invite:true})));
engine.feed.addEventListener('beam-poll-due',()=>engine.dispatch(new beamActions.PollBeaming()));
engine.feed.addEventListener('beam-progress',event=>engine.dispatch(new beamActions.BeamProgress(event.detail)));
engine.feed.addEventListener('mcp-request-opened',()=>engine.dispatch(new mcpActions.LoadMCPRequest()));
engine.feed.addEventListener('automation-call',event=>engine.dispatch(new automationActions.InvokeAutomation(event.detail)));
engine.feed.addEventListener('google-drive-returned',()=>engine.dispatch(new googleDriveActions.CompleteGoogleDrive()));
const googleDriveCell=queryCell(engine.query(new googleDriveActions.GoogleDriveReturn()));
const automationCell=queryCell(engine.query(new automationActions.AutomationState()));
const beamCell=queryCell(engine.query(new beamActions.BeamingState()));
const stateCell=queryCell(engine.query(new actions.BrowserState())),contextCell=queryCell(engine.query(new actions.PortalContext()));
dodo.reconcile(root,[watch(stateCell,state=>watch(contextCell,context=>{return watch(googleDriveCell,()=>watch(automationCell,enabled=>watch(beamCell,()=>surfaces[state.locale??'en']({...state,notice:state.notice||(state.route.googleDriveCallback&&!state.session?'Sign in to finish Google Drive authorization. If this browser session changed, start a new connection from Resources.':state.notice),automation:{...state.automation,enabled},context}))));} ))]);
engine.dispatch(new actions.InitializeSpace());
window.addEventListener('pagehide',()=>{cancelRecovery();window.removeEventListener('keydown',keydown);dodo.reconcile(root,[]);engine.dispose();},{once:true});
