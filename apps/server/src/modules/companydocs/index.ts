import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Exec } from '../../db';
import { companyDocumentAcks, companyDocuments, employmentOrgUnits, employments, persons, users } from '../../db/schema';
import { makeRoute } from '../../lib/api';
import type { Principal } from '../../lib/authz';
import { audit, type AppContext, type OpenPersModule } from '../../lib/context';
import { forbidden, notFound, unprocessable } from '../../lib/errors';
import { releaseFile } from '../../lib/images';
import { checkFileType } from '../documents';
import { notify } from '../workflow';

type CompanyDoc = typeof companyDocuments.$inferSelect;
const today = () => new Date().toISOString().slice(0, 10);

/** People with a current employment, optionally limited to members of one org unit. */
async function audienceOf(db: Exec, orgUnitId: string | null): Promise<Set<string>> {
  const emps = await db.select({ id: employments.id, personId: employments.personId, status: employments.status, endDate: employments.endDate }).from(employments);
  const current = emps.filter((e) => e.status !== 'INACTIVE' && (!e.endDate || e.endDate >= today()));
  if (!orgUnitId) return new Set(current.map((e) => e.personId));
  const links = await db.select().from(employmentOrgUnits).where(eq(employmentOrgUnits.orgUnitId, orgUnitId));
  const inUnit = new Set(links.map((l) => l.employmentId));
  return new Set(current.filter((e) => inUnit.has(e.id)).map((e) => e.personId));
}

const view = ({ fileKey: _k, ...d }: CompanyDoc) => d;

export const companyDocsModule: OpenPersModule = {
  name: 'companydocs',
  register(app, ctx: AppContext) {
    const { db, authz, storage } = ctx;
    const route = makeRoute(app, ctx.registry);
    const manages = (user: Principal) => authz.has(user, 'documents.manage');

    ctx.exporters.companyDocumentAcks = async (x: Exec, personId: string) =>
      x
        .select({ title: companyDocuments.title, acknowledgedAt: companyDocumentAcks.acknowledgedAt })
        .from(companyDocumentAcks)
        .innerJoin(companyDocuments, eq(companyDocuments.id, companyDocumentAcks.documentId))
        .where(eq(companyDocumentAcks.personId, personId));
    ctx.anonymizers.push(async (tx, personId) => {
      await tx.delete(companyDocumentAcks).where(eq(companyDocumentAcks.personId, personId));
    });

    async function load(user: Principal, id: string): Promise<CompanyDoc> {
      const [d] = await db.select().from(companyDocuments).where(eq(companyDocuments.id, id));
      if (!d) throw notFound('Document not found');
      if (manages(user)) return d;
      if (!user.personId || !(await audienceOf(db, d.orgUnitId)).has(user.personId)) throw forbidden();
      return d;
    }

    route({ method: 'GET', url: '/api/v1/company-documents', tag: 'company-documents', summary: 'Company documents visible to the caller, with own read confirmation (and totals for managers)' }, async ({ user }) => {
      const docs = await db.select().from(companyDocuments).orderBy(desc(companyDocuments.createdAt));
      const own = user.personId ? await db.select().from(companyDocumentAcks).where(eq(companyDocumentAcks.personId, user.personId)) : [];
      const all = manages(user) && docs.length ? await db.select().from(companyDocumentAcks).where(inArray(companyDocumentAcks.documentId, docs.map((d) => d.id))) : [];
      const audiences = new Map<string | null, Set<string>>();
      const audience = async (unit: string | null) => audiences.get(unit) ?? audiences.set(unit, await audienceOf(db, unit)).get(unit)!;
      const items = [];
      for (const d of docs) {
        const people = await audience(d.orgUnitId);
        if (!manages(user) && !(user.personId && people.has(user.personId))) continue;
        items.push({
          ...view(d),
          acknowledgedAt: own.find((a) => a.documentId === d.id)?.acknowledgedAt ?? null,
          ...(manages(user) && d.requiresAck ? { stats: { acknowledged: all.filter((a) => a.documentId === d.id && people.has(a.personId)).length, audience: people.size } } : {}),
        });
      }
      return { items };
    });

    route({ method: 'POST', url: '/api/v1/company-documents', perm: 'documents.manage', tag: 'company-documents', summary: 'Upload a company document (multipart: file, title, description?, requiresAck?, orgUnitId?)' }, async ({ user, raw }, reply) => {
      if (!raw.isMultipart()) throw unprocessable('Expected multipart/form-data', [{ path: 'file', message: 'Required' }]);
      const fields: Record<string, string> = {};
      let file: { filename: string; mimetype: string; data: Buffer } | undefined;
      for await (const part of raw.parts()) {
        if (part.type === 'file') file = { filename: part.filename, mimetype: part.mimetype, data: await part.toBuffer() };
        else fields[part.fieldname] = String(part.value);
      }
      if (!file) throw unprocessable('File missing', [{ path: 'file', message: 'Required' }]);
      checkFileType(file.mimetype, file.filename, file.data);
      const meta = z
        .object({ title: z.string().trim().min(1).max(200), description: z.string().max(1000).optional(), requiresAck: z.enum(['true', 'false']).optional(), orgUnitId: z.string().uuid().optional() })
        .parse(fields);
      const stored = await storage.put(file.data);
      const doc = await db.transaction(async (tx) => {
        const [d] = await tx
          .insert(companyDocuments)
          .values({ title: meta.title, description: meta.description ?? null, fileName: file.filename, fileKey: stored.key, mime: file.mimetype, size: stored.size, requiresAck: meta.requiresAck === 'true', orgUnitId: meta.orgUnitId ?? null, uploadedByUserId: user.userId })
          .returning();
        await audit(tx, user.userId, 'company_document', d.id, 'create', { title: d.title, requiresAck: d.requiresAck });
        if (d.requiresAck) {
          const people = [...(await audienceOf(tx, d.orgUnitId))];
          // Whoever publishes the document has read it.
          if (user.personId && people.includes(user.personId)) await tx.insert(companyDocumentAcks).values({ documentId: d.id, personId: user.personId });
          const accounts = people.length ? await tx.select({ id: users.id }).from(users).where(and(inArray(users.personId, people), eq(users.active, true))) : [];
          await notify(tx, accounts.map((a) => a.id).filter((id) => id !== user.userId), 'company_document', { title: d.title }, '/documents');
        }
        return d;
      });
      reply.code(201);
      return view(doc);
    });

    route(
      { method: 'PATCH', url: '/api/v1/company-documents/:id', perm: 'documents.manage', tag: 'company-documents', summary: 'Update title, description, confirmation or audience', body: z.object({ title: z.string().trim().min(1).max(200), description: z.string().max(1000).nullable(), requiresAck: z.boolean(), orgUnitId: z.string().uuid().nullable() }).partial() },
      async ({ user, params, body }) => {
        const d = await load(user, params.id);
        const [u] = await db.update(companyDocuments).set({ ...body, updatedAt: new Date() }).where(eq(companyDocuments.id, d.id)).returning();
        await audit(db, user.userId, 'company_document', d.id, 'update', body);
        return view(u);
      },
    );

    route({ method: 'DELETE', url: '/api/v1/company-documents/:id', perm: 'documents.manage', tag: 'company-documents', summary: 'Delete a company document and its confirmations' }, async ({ user, params }) => {
      const d = await load(user, params.id);
      await db.delete(companyDocuments).where(eq(companyDocuments.id, d.id));
      await audit(db, user.userId, 'company_document', d.id, 'delete', { title: d.title });
      await releaseFile(db, storage, d.fileKey);
    });

    route({ method: 'GET', url: '/api/v1/company-documents/:id/download', tag: 'company-documents', summary: 'Download a company document' }, async ({ user, params }, reply) => {
      const d = await load(user, params.id);
      if (!(await storage.exists(d.fileKey))) throw notFound('File missing in storage');
      const safeName = d.fileName.replace(/[^\w.\- äöüÄÖÜß]/g, '_');
      reply
        .header('content-type', d.mime)
        .header('content-disposition', `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(d.fileName)}`)
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, no-store');
      return reply.send(storage.stream(d.fileKey));
    });

    route({ method: 'POST', url: '/api/v1/company-documents/:id/acknowledge', tag: 'company-documents', summary: 'Confirm having read the document (idempotent)' }, async ({ user, params }) => {
      if (!user.personId) throw forbidden('Only employees confirm documents');
      const d = await load(user, params.id);
      if (!(await audienceOf(db, d.orgUnitId)).has(user.personId)) throw forbidden();
      await db.insert(companyDocumentAcks).values({ documentId: d.id, personId: user.personId }).onConflictDoNothing();
      const [a] = await db.select().from(companyDocumentAcks).where(and(eq(companyDocumentAcks.documentId, d.id), eq(companyDocumentAcks.personId, user.personId)));
      return { acknowledgedAt: a.acknowledgedAt };
    });

    route({ method: 'GET', url: '/api/v1/company-documents/:id/acknowledgements', perm: 'documents.manage', tag: 'company-documents', summary: 'Who has and has not confirmed the document' }, async ({ user, params }) => {
      const d = await load(user, params.id);
      const people = [...(await audienceOf(db, d.orgUnitId))];
      const rows = people.length ? await db.select({ id: persons.id, firstName: persons.firstName, lastName: persons.lastName }).from(persons).where(inArray(persons.id, people)) : [];
      const acks = await db.select().from(companyDocumentAcks).where(eq(companyDocumentAcks.documentId, d.id));
      const byPerson = new Map(acks.map((a) => [a.personId, a.acknowledgedAt]));
      const sorted = rows.sort((a, b) => a.lastName.localeCompare(b.lastName));
      return {
        acknowledged: sorted.filter((p) => byPerson.has(p.id)).map((person) => ({ person, acknowledgedAt: byPerson.get(person.id) })),
        pending: sorted.filter((p) => !byPerson.has(p.id)).map((person) => ({ person })),
      };
    });
  },
};
