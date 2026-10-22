// TOKEN_KEYS and its sentinels (docs/multi-user/PLAN.md §5.3).
//
// A blob that fails to decrypt is the deployment's fault, not the user's: a wrong, truncated or
// missing key would otherwise strand every user one by one. So before a process decrypts or
// encrypts anything it checks one sentinel blob per configured key, kept in `app_meta` as
// `sentinel:<key id>`, and refuses to serve if any fails: the identity read waits on this
// check, so a bad key answers every request with the retryable "unavailable" and leaves every
// user `active`; the next correct deploy serves again with no sign-in.
//
// A key's sentinel is written the first time a runtime holding that key boots (PLAN.md §11.4
// step 1: from the runtime, never from the Mac), and only where none exists.
//
// The verdict is kept per process for the configured keys and database. A key or decrypt
// failure stays (it is the deploy's fault); a store error is dropped so the next call retries.
import "server-only";
import { appDatabaseUrl, getAppMeta, setAppMetaIfAbsent } from "@/lib/app-db";
import { DecryptError, open, parseTokenKeys, seal, type TokenKey } from "@/lib/token-crypto";

const sentinelAad = (id: string) => `lazyboy:sentinel:v1:${id}`;
const sentinelText = (id: string) => `lazyboy token key sentinel ${id}`;

export class TokenKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenKeyError";
  }
}

async function check(raw: string | undefined): Promise<TokenKey[]> {
  let keys: TokenKey[];
  try {
    keys = parseTokenKeys(raw);
  } catch (e) {
    throw new TokenKeyError(String((e as Error).message));
  }
  for (const key of keys) {
    const name = `sentinel:${key.id}`;
    let blob = await getAppMeta(name);
    if (blob === null) {
      await setAppMetaIfAbsent(name, seal(key, sentinelAad(key.id), sentinelText(key.id)));
      blob = await getAppMeta(name);
    }
    let text: string | null = null;
    try {
      text = blob === null ? null : open([key], sentinelAad(key.id), blob);
    } catch (e) {
      if (!(e instanceof DecryptError)) throw e;
    }
    if (text !== sentinelText(key.id)) throw new TokenKeyError(`TOKEN_KEYS: key ${key.id} does not open its sentinel`);
  }
  return keys;
}

let verdict: { raw: string | undefined; url: string; keys: Promise<TokenKey[]> } | null = null;

/** The configured keys, once their sentinels have checked out in this process. Rejects with
 *  TokenKeyError when the keys are missing, malformed or wrong: the caller refuses to serve. */
export function tokenKeysReady(): Promise<TokenKey[]> {
  const raw = process.env.TOKEN_KEYS;
  const url = appDatabaseUrl();
  if (verdict && verdict.raw === raw && verdict.url === url) return verdict.keys;
  const keys = check(raw);
  const mine = { raw, url, keys };
  verdict = mine;
  keys.catch((e) => {
    if (e instanceof TokenKeyError) {
      console.error(`[tokens] ${e.message}: refusing to serve`);
    } else if (verdict === mine) {
      verdict = null;
    }
  });
  return keys;
}
