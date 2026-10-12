import { argon2id } from 'hash-wasm';

// One dedicated worker per derivation. The caller terminates it after receiving
// a result; answer material is never persisted or sent to a server.
self.onmessage = async ({ data }) => {
  let key;
  try {
    const options = data?.options;
    if (!options || options.memorySize !== 65536 || options.iterations !== 3 ||
        options.parallelism !== 1 || options.hashLength !== 32 ||
        options.outputType !== 'binary' || !(options.salt instanceof Uint8Array) ||
        options.salt.length !== 16 || !(options.password instanceof Uint8Array) ||
        options.password.length > 32768) throw new Error('Invalid recovery key parameters.');
    key = await argon2id(options);
    self.postMessage({ key }, [key.buffer]);
  } catch {
    self.postMessage({ error: 'We could not prepare the recovery key on this device.' });
  } finally {
    data?.options?.password?.fill?.(0);
  }
};
