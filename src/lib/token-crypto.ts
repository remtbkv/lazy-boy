// Spotify tokens encrypted at rest (docs/multi-user/PLAN.md §5.3).
//
// AES-256-GCM from node:crypto, a random 12-byte IV per write, stored as
// `<key id>.<base64url(iv ‖ ciphertext ‖ tag)>` with both tokens in one blob. The associated
// data is `lazyboy:tokens:v1:<uid>` (v1 is this format's version, not the key's id), so a
// ciphertext copied into another user's row fails to authenticate: write access to the app
// database without the key cannot graft one person's grant onto another's account.
//
// Keys come from TOKEN_KEYS="v2:<base64 32 bytes>,v1:<…>": the first key writes, a read picks
// its key by the blob's prefix, so a new key can go first while older blobs still read. A
// malformed list throws instead of guessing, and the sentinel check (token-keys.ts) turns that
// into a refusal to serve. Nothing here logs or returns a blob in an error.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type TokenKey = { id: string; key: Buffer };
export type TokenPair = { accessToken: string; refreshToken: string };

const KEY_ID = /^v[0-9]+$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class DecryptError extends Error {
  constructor(why: string) {
    super(`token blob does not decrypt: ${why}`);
    this.name = "DecryptError";
  }
}

export function parseTokenKeys(raw: string | undefined): TokenKey[] {
  const parts = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("TOKEN_KEYS is unset or empty");
  const keys = parts.map((p) => {
    const i = p.indexOf(":");
    const id = i > 0 ? p.slice(0, i) : "";
    const b64 = i > 0 ? p.slice(i + 1).trim() : "";
    if (!KEY_ID.test(id)) throw new Error("TOKEN_KEYS: every entry is v<n>:<base64 key>");
    if (!B64.test(b64)) throw new Error(`TOKEN_KEYS: key ${id} is not base64`);
    const key = Buffer.from(b64, "base64");
    if (key.length !== 32) throw new Error(`TOKEN_KEYS: key ${id} is ${key.length} bytes, not 32`);
    return { id, key };
  });
  if (new Set(keys.map((k) => k.id)).size !== keys.length) throw new Error("TOKEN_KEYS: a key id repeats");
  return keys;
}

export const tokenAad = (uid: string) => `lazyboy:tokens:v1:${uid}`;

export function seal(key: TokenKey, aad: string, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv("aes-256-gcm", key.key, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return `${key.id}.${Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64url")}`;
}

export function open(keys: TokenKey[], aad: string, blob: string): string {
  const dot = blob.indexOf(".");
  const key = dot > 0 ? keys.find((k) => k.id === blob.slice(0, dot)) : undefined;
  if (!key) throw new DecryptError("no configured key for its prefix");
  const raw = Buffer.from(blob.slice(dot + 1), "base64url");
  if (raw.length < IV_BYTES + TAG_BYTES + 1) throw new DecryptError("too short");
  try {
    const d = createDecipheriv("aes-256-gcm", key.key, raw.subarray(0, IV_BYTES));
    d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    return Buffer.concat([d.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), d.final()]).toString("utf8");
  } catch {
    throw new DecryptError("authentication failed");
  }
}

export function encryptTokens(keys: TokenKey[], uid: string, t: TokenPair): string {
  return seal(keys[0], tokenAad(uid), JSON.stringify({ a: t.accessToken, r: t.refreshToken }));
}

export function decryptTokens(keys: TokenKey[], uid: string, blob: string): TokenPair {
  let o: { a?: unknown; r?: unknown };
  try {
    o = JSON.parse(open(keys, tokenAad(uid), blob));
  } catch (e) {
    throw e instanceof DecryptError ? e : new DecryptError("not a token pair");
  }
  if (typeof o?.a !== "string" || typeof o?.r !== "string") throw new DecryptError("not a token pair");
  return { accessToken: o.a, refreshToken: o.r };
}
