// Tokens encrypted at rest (PLAN.md §5.3, T5's crypto half): AES-256-GCM, a random 12-byte IV per
// write, `<key id>.<base64url(iv ‖ ciphertext ‖ tag)>`, the associated data
// `lazyboy:tokens:v1:<uid>`, and TOKEN_KEYS with the first key writing and reads picking by prefix.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DecryptError, decryptTokens, encryptTokens, parseTokenKeys, tokenAad } from "@/lib/token-crypto";
import { expectCiphertextBoundToUser, expectFreshIvPerWrite } from "./harness";

const k = () => randomBytes(32).toString("base64");
const T = { accessToken: "at-A", refreshToken: "rt-A" };
const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";

describe("TOKEN_KEYS", () => {
  it("parses id:base64 pairs in order; the first key writes", () => {
    const keys = parseTokenKeys(` v2:${k()} , v1:${k()}`);
    expect(keys.map((x) => x.id)).toEqual(["v2", "v1"]);
    expect(keys.every((x) => x.key.length === 32)).toBe(true);
  });

  it("refuses anything else rather than guessing", () => {
    for (const bad of [
      undefined,
      "",
      " , ",
      `x1:${k()}`,
      `v1${k()}`,
      `v1:${randomBytes(31).toString("base64")}`,
      `v1:${randomBytes(33).toString("base64")}`,
      `v1:${k()},v1:${k()}`,
      "v1:not base64 at all!!",
    ]) {
      expect(() => parseTokenKeys(bad), String(bad)).toThrow();
    }
  });
});

describe("the blob", () => {
  const keys = parseTokenKeys(`v1:${k()}`);

  it("round-trips, names its key and holds iv ‖ ciphertext ‖ tag", () => {
    const blob = encryptTokens(keys, A, T);
    expect(blob).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    const raw = Buffer.from(blob.slice(3), "base64url");
    const plain = Buffer.byteLength(JSON.stringify({ a: T.accessToken, r: T.refreshToken }));
    expect(raw.length).toBe(12 + plain + 16);
    expect(decryptTokens(keys, A, blob)).toEqual(T);
    expect(blob).not.toContain("rt-A");
  });

  it("is bound to its user by the associated data", () => {
    expect(tokenAad(A)).toBe(`lazyboy:tokens:v1:${A}`);
    expectCiphertextBoundToUser({ encrypt: encryptTokens, decrypt: decryptTokens });
  });

  it("takes a fresh IV on every write", () => {
    expectFreshIvPerWrite(encryptTokens);
  });

  it("fails closed on a tampered byte, an unknown key id, a wrong key or garbage", () => {
    const blob = encryptTokens(keys, A, T);
    const raw = Buffer.from(blob.slice(3), "base64url");
    raw[20] ^= 1;
    expect(() => decryptTokens(keys, A, `v1.${raw.toString("base64url")}`)).toThrow(DecryptError);
    expect(() => decryptTokens(keys, A, `v9${blob.slice(2)}`)).toThrow(DecryptError);
    expect(() => decryptTokens(parseTokenKeys(`v1:${k()}`), A, blob)).toThrow(DecryptError);
    for (const g of ["", "v1.", "v1.AAAA", "nodot", "v1.!!!"]) expect(() => decryptTokens(keys, A, g)).toThrow(DecryptError);
  });

  it("the error names no part of the blob", () => {
    const blob = encryptTokens(keys, A, T);
    try {
      decryptTokens(keys, B, blob);
      throw new Error("decrypted under the wrong user");
    } catch (e) {
      expect(e).toBeInstanceOf(DecryptError);
      expect(String((e as Error).message)).not.toContain(blob.slice(3, 20));
    }
  });
});

describe("key rotation", () => {
  it("a blob under an older key still reads once a new key is first; new writes take the new key", () => {
    const v1 = `v1:${k()}`;
    const old = encryptTokens(parseTokenKeys(v1), A, T);
    const rotated = parseTokenKeys(`v2:${k()},${v1}`);
    expect(decryptTokens(rotated, A, old)).toEqual(T);
    expect(encryptTokens(rotated, A, T).startsWith("v2.")).toBe(true);
  });
});
