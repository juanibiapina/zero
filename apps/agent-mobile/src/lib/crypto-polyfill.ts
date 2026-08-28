import * as ExpoCrypto from 'expo-crypto';

// Hermes (React Native) ships no Web Crypto. TanStack DB's safeRandomUUID needs
// crypto.getRandomValues / crypto.randomUUID (for collection + transaction ids),
// so polyfill both from expo-crypto. Import this before anything that builds a
// collection.
type Cryptoish = {
  getRandomValues?: (array: ArrayBufferView) => ArrayBufferView;
  randomUUID?: () => string;
};

const globalCrypto: Cryptoish = ((globalThis as { crypto?: Cryptoish }).crypto ??=
  {});

if (typeof globalCrypto.getRandomValues !== 'function') {
  globalCrypto.getRandomValues = (array) =>
    ExpoCrypto.getRandomValues(
      array as Parameters<typeof ExpoCrypto.getRandomValues>[0],
    );
}

if (typeof globalCrypto.randomUUID !== 'function') {
  globalCrypto.randomUUID = () => ExpoCrypto.randomUUID();
}
