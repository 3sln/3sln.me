// Island mounter: the hook through which <bindle-account>, <bindle-sign-in> and
// <bindle-avatar> mount provider islands (components profile §3–§8; embed-islands
// §8.2, §12.4). Loaded lazily, only when the provider's capability set lists the
// part (so the embedder's islands="auto|off" and island-issuers policy and the
// profile cross-checks already passed).
//
// PLACEHOLDER: the islands slice owns this implementation (iframe creation per
// profile §3.1, handshake and port validation through ../islands-protocol.mjs,
// teardown and degradation via session.client.capabilities.degrade(issuer,
// 'part:<name>' | 'profile')). Until it lands, every part reports nothing and the
// elements keep their standard composition.
//
// Contract:
//   mountIsland({element, container, session, onState, part, issuer, embedOrigin, version, fedcm, themeTokens})
//     element      the host element (read its lang, theme and attributes; never its light DOM)
//     container    an empty element in the host's shadow root to append the iframe to
//     session      the <bindle-session> element; its controller offers prepareIsland(issuer) (fresh
//                  in-memory PKCE/state/dpopJkt for `prepare`), completeIslandCode({code,state,iss}) and
//                  selectAccount(subject)
//     onState(s)   's' is 'mounting' | 'live' | 'fallback'; elements show the island only while 'live'
//   returns null (not mounted) or {destroy(), scheme(colorScheme), session(subject|null), forget(subject?)}
// Island events reach elements as calls on the host: element.islandFlow(phase, outcome),
// element.islandSelect(subject) (switcher only), element.islandClose(reason).
export async function mountIsland(){return null;}
