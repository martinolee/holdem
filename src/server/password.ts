// Room passwords. A random salt per room, SHA-256 over salt + password.
// The plaintext is never stored and never leaves the object that checks it.

const hex = (b: ArrayBuffer | Uint8Array): string =>
  Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');

/** What a room stores. Neither field may be sent to a client. */
export interface PwRecord {
  salt: string;
  hash: string;
}

async function digest(salt: string, password: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + password)));
}

export async function makePwRecord(password: string): Promise<PwRecord> {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, hash: await digest(salt, password) };
}

export async function verifyPw(password: string, rec: PwRecord): Promise<boolean> {
  return (await digest(rec.salt, password)) === rec.hash;
}

/** Shape only: the room decides whether a password is required at all. */
export function validPwShape(password: unknown): password is string {
  return typeof password === 'string' && password.length >= 4 && password.length <= 32;
}
