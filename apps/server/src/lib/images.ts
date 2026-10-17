import { eq } from 'drizzle-orm';
import type { Exec } from '../db';
import { applications, company, companyDocuments, documents, persons } from '../db/schema';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError, unprocessable } from './errors';
import type { StorageAdapter } from './storage';

/** Profile photos and logos are small; the browser resizes before uploading. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';

/** Detects the image type from its bytes; the declared content type is never trusted. */
export function sniffImage(b: Buffer, allowSvg: boolean): ImageMime {
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (allowSvg) {
    const head = b.subarray(0, 1024).toString('utf8').trimStart().toLowerCase();
    if ((head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) && !b.includes(0)) return 'image/svg+xml';
  }
  throw new HttpError(415, `Image type not allowed (allowed: PNG, JPEG, WebP${allowSvg ? ', SVG' : ''})`);
}

/** Reads the single `file` part of a multipart upload. */
export async function readImageUpload(req: FastifyRequest, allowSvg: boolean): Promise<{ data: Buffer; mime: ImageMime }> {
  if (!req.isMultipart()) throw unprocessable('Expected multipart/form-data', [{ path: 'file', message: 'Required' }]);
  const part = await req.file();
  if (!part) throw unprocessable('File missing', [{ path: 'file', message: 'Required' }]);
  const data = await part.toBuffer();
  if (data.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'Image larger than 2 MB');
  return { data, mime: sniffImage(data, allowSvg) };
}

/** Streams a stored image with headers that keep SVG inert and let `?v=` URLs be cached. */
export async function sendImage(reply: FastifyReply, storage: StorageAdapter, key: string, mime: string, cache: 'public' | 'private') {
  if (!(await storage.exists(key))) throw new HttpError(404, 'Image missing in storage');
  reply
    .header('content-type', mime)
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
    .header('cache-control', `${cache}, max-age=86400`);
  return reply.send(storage.stream(key));
}

/**
 * Storage is content-addressed, so the same bytes may back several records. Removes the file
 * only when no person photo, company logo, document, company document or CV still points to it.
 */
export async function releaseFile(db: Exec, storage: StorageAdapter, key: string | null | undefined) {
  if (!key) return;
  const refs = await Promise.all([
    db.select({ id: persons.id }).from(persons).where(eq(persons.photoKey, key)).limit(1),
    db.select({ id: company.id }).from(company).where(eq(company.logoKey, key)).limit(1),
    db.select({ id: documents.id }).from(documents).where(eq(documents.fileKey, key)).limit(1),
    db.select({ id: applications.id }).from(applications).where(eq(applications.cvFileKey, key)).limit(1),
    db.select({ id: companyDocuments.id }).from(companyDocuments).where(eq(companyDocuments.fileKey, key)).limit(1),
  ]);
  if (refs.every((r) => !r.length)) await storage.delete(key);
}

/** Cache-busting URL of a person's photo, or null. Photos are visible like the directory: to every signed-in user. */
export const photoUrl = (p: { id: string; photoUpdatedAt: Date | null }) => (p.photoUpdatedAt ? `/api/v1/persons/${p.id}/photo?v=${p.photoUpdatedAt.getTime()}` : null);

/** Public, cache-busting URL of the company logo, or null. */
export const logoUrl = (c: { logoUpdatedAt: Date | null }) => (c.logoUpdatedAt ? `/api/v1/public/logo?v=${c.logoUpdatedAt.getTime()}` : null);
