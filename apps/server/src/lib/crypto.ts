import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

export const hashPassword = (password: string) => hash(password);

export async function verifyPassword(hashValue: string | null | undefined, password: string): Promise<boolean> {
  if (!hashValue) return false;
  try {
    return await verify(hashValue, password);
  } catch {
    return false;
  }
}

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export function randomToken(prefix = ''): string {
  return prefix + randomBytes(32).toString('base64url');
}

export function hmacSha256(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** AES-256-GCM field encryption. Key is derived from SECRET_KEY. Output: base64(iv | tag | ciphertext). */
export class FieldCipher {
  private key: Buffer;
  constructor(secret: string) {
    this.key = createHash('sha256').update(`openpers-field-encryption:${secret}`).digest();
  }
  encrypt(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
  }
  decrypt(payload: string): unknown {
    const buf = Buffer.from(payload, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8'));
  }
}
