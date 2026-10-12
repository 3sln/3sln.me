// Archived v1 interoperability input. Expected key/ciphertext are fixed by the
// maintained Argon2id implementation and Web Crypto, never generated at test time.
export const RECOVERY_V1_VECTOR = Object.freeze({
  payload: { version: 1, issuer: 'https://identity.example', handle: 'alice', recoveryToken: 'account-id.independent-random-recovery-credential', warning: 'Keep this file private.' },
  questions: [
    { id: 'name', type: 'text', prompt: 'A name with "quotes" and a \\?', hint: 'Public hint' },
    { id: 'birth', type: 'date', prompt: 'Your selected date', hint: '' },
    { id: 'ssn', type: 'ssn', prompt: 'Your selected SSN', hint: '' },
    { id: 'document', type: 'national-id', prompt: 'Your chosen document ID', hint: 'Document and country are user chosen' },
    { id: 'phone', type: 'phone', prompt: 'Your saved international phone', hint: '' },
    { id: 'pin', type: 'pin', prompt: 'Your private PIN', hint: '' },
    { id: 'phrase', type: 'passphrase', prompt: 'Your extra private phrase', hint: '' },
  ],
  answers: [' \t JOSÉ\\ "One"\n', '2000/2/29', '001-02-0003', 'ab-00123', '+44 (0)20 1234 5678', '0017', ' Quoted "Secret" \\ Café '],
  normalizedAnswers: ['josé\\ "one"', '2000-02-29', '001020003', 'AB00123', '+4402012345678', '0017', ' Quoted "Secret" \\ Café '],
  salt: 'AAECAwQFBgcICQoLDA0ODw',
  iv: 'EBESExQVFhcYGRob',
  keyHex: '1f916b78b1e77917d2098c972105b23b4b371e8291389d7175c9b4a64b0aed31',
  ciphertext: 'V7sb4XdT0YtkvZlC6kMzsyFdzHUTHPs2t_BMA9rW_x0tBQXjduA90yoGa-ekTDJAPr16B3wWPJjmMA4amELrTVJUnMkp_rJEsWc6mqwjeSWafTW7CBOCOhEphe5X3d0lQnmSGXtnjh6niUfaSW2ri7SutFItC1sRmHbK2q0IEZptXsTM47Z0q1Onfn_1st0G60Eizpr1Jngdj-GJNziqVOl8EHtpLw-e-8soUFLT96zSAqSsqXvYqJDk',
});
