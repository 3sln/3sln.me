import { encode, decode } from './crypto.mjs';

function topLevel(response) {
  const encoded = response?.response?.clientDataJSON;
  if (typeof encoded !== 'string' || encoded.length > 16384) throw new Error('Invalid client data');
  const data = JSON.parse(new TextDecoder().decode(decode(encoded)));
  if (data.crossOrigin === true || data.topOrigin !== undefined) throw new Error('Embedded authentication is disabled');
}

export async function createWebAuthnAdapter() {
  const library = await import('@simplewebauthn/server');
  return {
    async registrationOptions({ account, config }) {
      return library.generateRegistrationOptions({ rpName: config.rpName, rpID: config.rpID,
        userName: account.handle, userID: new TextEncoder().encode(account.id),
        attestationType: 'none', supportedAlgorithmIDs: [-7, -257],
        excludeCredentials: account.credentials.map(({ id, transports }) => ({ id, transports })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' } });
    },
    async verifyRegistration({ response, challenge, config }) {
      topLevel(response);
      const result = await library.verifyRegistrationResponse({ response, expectedChallenge: challenge,
        expectedOrigin: config.origin, expectedRPID: config.rpID, requireUserPresence: true,
        requireUserVerification: true, supportedAlgorithmIDs: [-7, -257] });
      if (!result.verified || !result.registrationInfo) throw new Error('Invalid registration');
      const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
      return { id: credential.id, publicKey: encode(credential.publicKey), counter: credential.counter,
        transports: credential.transports, deviceType: credentialDeviceType, backedUp: credentialBackedUp };
    },
    async authenticationOptions({ config }) {
      // Omitting an allow-list gives identical options for existing/unknown
      // handles and supports the resident passkeys required at registration.
      return library.generateAuthenticationOptions({ rpID: config.rpID, userVerification: 'required' });
    },
    async verifyAuthentication({ response, challenge, credential, account, config }) {
      topLevel(response);
      if (response.response?.userHandle && response.response.userHandle !== encode(new TextEncoder().encode(account.id))) throw new Error('Invalid account binding');
      const result = await library.verifyAuthenticationResponse({ response, expectedChallenge: challenge,
        expectedOrigin: config.origin, expectedRPID: config.rpID, requireUserVerification: true,
        credential: { ...credential, publicKey: decode(credential.publicKey) } });
      if (!result.verified || !result.authenticationInfo) throw new Error('Invalid authentication');
      return { counter: result.authenticationInfo.newCounter, backedUp: result.authenticationInfo.credentialBackedUp };
    },
  };
}
