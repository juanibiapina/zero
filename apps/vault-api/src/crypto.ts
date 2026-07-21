/**
 * ============================================================================
 * ZeroVault Crypto — Envelope Encryption
 * ============================================================================
 *
 * Envelope encryption with per-project DEKs:
 *
 *   MASTER_KEY (Worker secret)
 *       │ AES-256-GCM
 *       ▼
 *   Project DEK (256-bit, stored encrypted in ProjectVaultDO)
 *       │ HKDF-SHA256
 *       ├──► Encryption sub-key (AES-256-GCM for secret keys + values)
 *       └──► HMAC sub-key (HMAC-SHA256 for secret key lookups)
 *
 * All functions use Web Crypto API (available in Workers runtime).
 */

const ENCRYPTION_INFO = new TextEncoder().encode("zerovault-encryption");
const HMAC_INFO = new TextEncoder().encode("zerovault-hmac");

// ============================================================================
// DEK Lifecycle
// ============================================================================

/**
 * Generates a random 256-bit DEK.
 */
export function generateDek(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * Encrypts a DEK with the master key using AES-256-GCM.
 * Returns base64(iv + ciphertext).
 */
export async function encryptDek(
  dek: Uint8Array,
  masterKeyBase64: string,
): Promise<string> {
  const masterKey = await importMasterKey(masterKeyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    masterKey,
    dek,
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypts a DEK using the master key.
 * Returns the raw 256-bit DEK bytes.
 */
export async function decryptDek(
  encryptedDek: string,
  masterKeyBase64: string,
): Promise<Uint8Array> {
  const masterKey = await importMasterKey(masterKeyBase64);
  const combined = base64ToBytes(encryptedDek);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    masterKey,
    ciphertext,
  );
  return new Uint8Array(plaintext);
}

// ============================================================================
// Key Derivation (HKDF)
// ============================================================================

/**
 * Derives two sub-keys from a DEK using HKDF-SHA256:
 * - encryptionKey: for AES-256-GCM encryption of secret keys and values
 * - hmacKey: for HMAC-SHA256 lookup hashes of secret key names
 */
export async function deriveSubKeys(dek: Uint8Array): Promise<{
  encryptionKey: CryptoKey;
  hmacKey: CryptoKey;
}> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    dek,
    "HKDF",
    false,
    ["deriveKey"],
  );

  const encryptionKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: ENCRYPTION_INFO },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  const hmacKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: HMAC_INFO },
    baseKey,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );

  return { encryptionKey, hmacKey };
}

// ============================================================================
// AES-256-GCM Encrypt / Decrypt (for secret keys and values)
// ============================================================================

/**
 * Encrypts a plaintext string with AES-256-GCM.
 * Returns base64(iv + ciphertext).
 */
export async function encryptValue(
  plaintext: string,
  encryptionKey: CryptoKey,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    encryptionKey,
    encoded,
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypts a base64-encoded AES-256-GCM ciphertext.
 * Returns the original plaintext string.
 */
export async function decryptValue(
  encoded: string,
  encryptionKey: CryptoKey,
): Promise<string> {
  const combined = base64ToBytes(encoded);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    encryptionKey,
    ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}

// ============================================================================
// HMAC-SHA256 (for secret key name lookups)
// ============================================================================

/**
 * Computes HMAC-SHA256 of a plaintext key name.
 * Returns hex-encoded hash for use as a database lookup key.
 */
export async function hmacKeyName(
  keyName: string,
  hmacKey: CryptoKey,
): Promise<string> {
  const encoded = new TextEncoder().encode(keyName);
  const signature = await crypto.subtle.sign("HMAC", hmacKey, encoded);
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ============================================================================
// Helpers
// ============================================================================

async function importMasterKey(base64Key: string): Promise<CryptoKey> {
  const keyBytes = base64ToBytes(base64Key);
  return crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(
    atob(b64)
      .split("")
      .map((c) => c.charCodeAt(0)),
  );
}
