// Zero-knowledge key derivation and AEAD for LANote. Everything here runs
// client-side; the server never sees a passphrase, a derived key, or plaintext.
//
// A single room secret is expanded (PBKDF2 -> HKDF) into three independent
// values so that possessing one reveals nothing about the others:
//   - encKey:    AES-GCM key, never leaves the client, never sent anywhere
//   - authToken: server-facing bearer credential (server may learn this)
//   - roomId:    opaque room identifier (server may learn this)

export type AADKind = 'file' | 'room-state' | 'ws';

export interface RoomKeys {
  roomId: string;
  authToken: Uint8Array<ArrayBuffer>;
  encKey: CryptoKey;
}

const PBKDF2_ITERATIONS = 210_000;
const IV_LENGTH = 12; // 96-bit GCM nonce, per NIST SP 800-38D recommendation

// Fixed, non-secret application-context salt. A salt normally exists to defeat
// rainbow tables against reused low-entropy passwords; here the default secret
// is already a random 120-bit value (see generateRoomSecret) and there is no
// prior shared channel between two devices to exchange a per-room salt before
// they both already have the room code. Uniqueness comes from the secret's own
// entropy, not the salt.
const APP_SALT = new TextEncoder().encode('lanote-v1-static-salt-do-not-reuse-as-secret') as Uint8Array<ArrayBuffer>;

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// Uint8Array's default generic parameter is the wider ArrayBufferLike (which
// includes SharedArrayBuffer); WebCrypto's BufferSource requires the narrower
// ArrayBuffer-backed form, so every Uint8Array handed to crypto.subtle or
// WebSocket.send() in this file is explicitly typed/cast as Uint8Array<ArrayBuffer>.
function utf8(s: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;
}

export function base64UrlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeCrockfordBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += CROCKFORD_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += CROCKFORD_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return output;
}

/** Generates a 120-bit random room code, e.g. "K7QM-9XJ2-4RTN-VB3W-XHNC". */
export function generateRoomSecret(): string {
  const bytes = new Uint8Array(15); // 15 bytes = 120 bits, divides evenly into 24 base32 chars
  crypto.getRandomValues(bytes);
  const raw = encodeCrockfordBase32(bytes);
  return (raw.match(/.{1,4}/g) ?? [raw]).join('-');
}

/**
 * Normalizes user-typed or pasted room codes: uppercases, strips separators,
 * and maps the classic Crockford confusables (O -> 0, I/L -> 1) so a
 * hand-copied code still derives the same keys.
 */
export function normalizeSecret(secret: string): string {
  return secret
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/[^0-9A-Z]/g, '');
}

async function pbkdf2Master(secret: string): Promise<ArrayBuffer> {
  const normalized = normalizeSecret(secret);
  const baseKey = await crypto.subtle.importKey('raw', utf8(normalized), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: APP_SALT, iterations: PBKDF2_ITERATIONS },
    baseKey,
    256
  );
}

async function hkdfBits(masterBits: ArrayBuffer, info: string, length: number): Promise<ArrayBuffer> {
  const hkdfKey = await crypto.subtle.importKey('raw', masterBits, 'HKDF', false, ['deriveBits']);
  return crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: APP_SALT, info: utf8(info) },
    hkdfKey,
    length
  );
}

async function hkdfEncKey(masterBits: ArrayBuffer, info: string): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey('raw', masterBits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: APP_SALT, info: utf8(info) },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable: the raw key bytes can never be read back out of this CryptoKey
    ['encrypt', 'decrypt']
  );
}

/** Derives (encKey, authToken, roomId) from a room secret. Same secret -> same three values on every device, with none reversible into another (HKDF domain separation via distinct `info` strings). */
export async function deriveRoomKeys(secret: string): Promise<RoomKeys> {
  const master = await pbkdf2Master(secret);
  const encKey = await hkdfEncKey(master, 'lanote:v1:enc-key');
  const authTokenBits = await hkdfBits(master, 'lanote:v1:auth-token', 256);
  const roomIdBits = await hkdfBits(master, 'lanote:v1:room-id', 128);
  return {
    roomId: base64UrlEncode(roomIdBits),
    authToken: new Uint8Array(authTokenBits),
    encKey,
  };
}

export function makeAAD(roomId: string, kind: AADKind): Uint8Array<ArrayBuffer> {
  return utf8(`lanote:v1:${kind}:${roomId}`);
}

/** Encrypts to the wire envelope [12-byte random IV][ciphertext + 16-byte tag]. */
export async function encryptBytes(encKey: CryptoKey, plaintext: ArrayBuffer, aad: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  // Random (not counter) IVs: multiple devices write under the same encKey
  // concurrently with no central nonce-sequencing authority.
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    encKey,
    plaintext
  );
  const envelope = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  envelope.set(iv, 0);
  envelope.set(new Uint8Array(ciphertext), IV_LENGTH);
  return envelope.buffer;
}

/** Inverse of encryptBytes. Throws if the envelope is truncated, the AAD doesn't match the context it was sealed for, or the key/secret is wrong. */
export async function decryptBytes(encKey: CryptoKey, envelope: ArrayBuffer, aad: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(envelope);
  if (bytes.byteLength < IV_LENGTH) throw new Error('Ciphertext envelope too short');
  const iv = bytes.slice(0, IV_LENGTH);
  const ciphertext = bytes.slice(IV_LENGTH);
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    encKey,
    ciphertext
  );
}
