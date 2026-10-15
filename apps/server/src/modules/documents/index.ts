import { and, asc, desc, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { Exec } from '../../db';
import { company, documentCategories, documents, documentTemplates, persons } from '../../db/schema';
import { makeRoute } from '../../lib/api';
import type { Principal } from '../../lib/authz';
import { audit, emit, type AppContext, type OpenPersModule } from '../../lib/context';
import { forbidden, HttpError, notFound, unprocessable } from '../../lib/errors';
import { currentEmployment, isoDateSchema } from '../people/service';
import { atLeast, DATA_CATEGORIES, type DataCategory } from '@openpers/shared';

type Doc = typeof documents.$inferSelect;

/** Allowed upload types with a magic-byte check so the declared type cannot be spoofed. */
const ALLOWED: Record<string, { ext: string[]; magic?: (b: Buffer) => boolean }> = {
  'application/pdf': { ext: ['pdf'], magic: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  'image/png': { ext: ['png'], magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/jpeg': { ext: ['jpg', 'jpeg'], magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { ext: ['docx'], magic: (b) => b[0] === 0x50 && b[1] === 0x4b },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { ext: ['xlsx'], magic: (b) => b[0] === 0x50 && b[1] === 0x4b },
  'text/plain': { ext: ['txt'], magic: (b) => !b.subarray(0, 4096).includes(0) },
  'text/markdown': { ext: ['md'], magic: (b) => !b.subarray(0, 4096).includes(0) },
};

export function checkFileType(mime: string, filename: string, data: Buffer): void {
  const rule = ALLOWED[mime];
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (!rule || !rule.ext.includes(ext) || (rule.magic && !rule.magic(data))) {
    throw new HttpError(415, `File type not allowed (allowed: ${Object.values(ALLOWED).flatMap((r) => r.ext).join(', ')})`);
  }
}

const DEFAULT_CATEGORIES = [
  // Contracts usually state the salary, so they fall under compensation.
  { name: 'Arbeitsvertrag', employeeVisible: false, dataCategory: 'compensation', position: 0 },
  { name: 'Gehaltsabrechnungen', employeeVisible: true, dataCategory: 'payroll', position: 1 },
  { name: 'Bescheinigungen', employeeVisible: true, dataCategory: 'personal', position: 2 },
  { name: 'Zeugnisse', employeeVisible: true, dataCategory: 'employment', position: 3 },
  { name: 'Sonstiges', employeeVisible: false, dataCategory: 'employment', position: 4 },
];

function renderTemplate(body: string, data: Record<string, Record<string, unknown>>): string {
  return body.replace(/\{\{\s*([a-zA-Z]+)\.([a-zA-Z]+)\s*\}\}/g, (_m, obj: string, key: string) => {
    const v = data[obj]?.[key];
    return v === null || v === undefined ? '' : String(v);
  });
}

export const documentsModule: OpenPersModule = {
  name: 'documents',

  async seed(tx) {
    await tx.insert(documentCategories).values(DEFAULT_CATEGORIES);
  },

  register(app, ctx: AppContext) {
    const { db, authz, storage } = ctx;
    const route = makeRoute(app, ctx.registry);

    ctx.exporters.documents = async (x: Exec, personId: string) =>
      x.select({ id: documents.id, name: documents.name, mime: documents.mime, size: documents.size, documentDate: documents.documentDate, createdAt: documents.createdAt }).from(documents).where(eq(documents.ownerPersonId, personId));

    /** Full access (incl. HR-only documents) requires documents.write over the owner. */
    /** Data category of a document, via its document category (uncategorized → employment). */
    async function dataCategoryOf(categoryId: string | null): Promise<DataCategory> {
      if (!categoryId) return 'employment';
      const [c] = await db.select({ dataCategory: documentCategories.dataCategory }).from(documentCategories).where(eq(documentCategories.id, categoryId));
      return (c?.dataCategory as DataCategory) ?? 'employment';
    }

    /** Managing (upload for others, hidden docs, delete) needs documents.write and `edit` on the data category. */
    async function canManage(user: Principal, ownerPersonId: string, cat: DataCategory) {
      return (await authz.can(user, 'documents.write', ownerPersonId)) && atLeast((await authz.categoryAccess(user, ownerPersonId))[cat], 'edit');
    }

    /** Viewing needs document read access and `view` on the data category; owners only see documents shared with them. */
    async function canSee(user: Principal, d: Doc) {
      const owner = d.ownerPersonId!;
      const cat = await dataCategoryOf(d.categoryId);
      if (await canManage(user, owner, cat)) return true;
      if (!(await authz.can(user, 'documents.read', owner)) && !(await authz.can(user, 'documents.write', owner))) return false;
      if (!atLeast((await authz.categoryAccess(user, owner))[cat], 'view')) return false;
      return owner === user.personId ? d.employeeVisible : true;
    }

    async function loadDoc(user: Principal, id: string): Promise<Doc> {
      const [d] = await db.select().from(documents).where(eq(documents.id, id));
      if (!d || !d.ownerPersonId) throw notFound('Document not found');
      if (!(await canSee(user, d))) throw forbidden();
      return d;
    }

    async function store(user: Principal, ownerPersonId: string, input: { name: string; mime: string; data: Buffer; categoryId: string | null; documentDate: string | null; employeeVisible?: boolean }) {
      let visible = input.employeeVisible;
      if (visible === undefined) {
        const [cat] = input.categoryId ? await db.select().from(documentCategories).where(eq(documentCategories.id, input.categoryId)) : [];
        if (input.categoryId && !cat) throw unprocessable('Unknown category', [{ path: 'categoryId', message: 'Category not found' }]);
        visible = cat?.employeeVisible ?? false;
      }
      const file = await storage.put(input.data);
      const [row] = await db.transaction(async (tx) => {
        const r = await tx
          .insert(documents)
          .values({ ownerPersonId, categoryId: input.categoryId, name: input.name, fileKey: file.key, mime: input.mime, size: file.size, sha256: file.sha256, documentDate: input.documentDate, employeeVisible: visible!, uploadedByUserId: user.userId })
          .returning();
        await audit(tx, user.userId, 'document', r[0].id, 'create', { ownerPersonId, name: input.name, size: file.size });
        await emit(tx, 'document.created', { documentId: r[0].id, personId: ownerPersonId, categoryId: input.categoryId });
        return r;
      });
      return row;
    }

    // ---------- Categories ----------
    const catBody = z.object({ name: z.string().min(1).max(100), employeeVisible: z.boolean().default(false), dataCategory: z.enum(DATA_CATEGORIES).default('employment'), position: z.number().int().default(0) });
    route({ method: 'GET', url: '/api/v1/document-categories', tag: 'documents', summary: 'List document categories' }, async () => ({ items: await db.select().from(documentCategories).orderBy(asc(documentCategories.position), asc(documentCategories.name)) }));
    route({ method: 'POST', url: '/api/v1/document-categories', perm: 'documents.manage', tag: 'documents', summary: 'Create category', body: catBody }, async ({ user, body }, reply) => {
      const [c] = await db.insert(documentCategories).values(body).returning();
      await audit(db, user.userId, 'document_category', c.id, 'create', body);
      reply.code(201);
      return c;
    });
    route({ method: 'PATCH', url: '/api/v1/document-categories/:id', perm: 'documents.manage', tag: 'documents', summary: 'Update category', body: catBody.partial() }, async ({ user, body, params }) => {
      const [c] = await db.update(documentCategories).set(body).where(eq(documentCategories.id, params.id)).returning();
      if (!c) throw notFound();
      await audit(db, user.userId, 'document_category', c.id, 'update', body);
      return c;
    });
    route({ method: 'DELETE', url: '/api/v1/document-categories/:id', perm: 'documents.manage', tag: 'documents', summary: 'Delete category (documents stay, uncategorized)' }, async ({ user, params }) => {
      const res = await db.delete(documentCategories).where(eq(documentCategories.id, params.id)).returning();
      if (!res.length) throw notFound();
      await audit(db, user.userId, 'document_category', params.id, 'delete');
    });

    // ---------- Documents ----------
    route({ method: 'GET', url: '/api/v1/persons/:id/documents', tag: 'documents', summary: 'Documents of a person' }, async ({ user, params }) => {
      if (!(await authz.can(user, 'documents.read', params.id)) && !(await authz.can(user, 'documents.write', params.id))) throw forbidden();
      const all = await db.select().from(documents).where(eq(documents.ownerPersonId, params.id)).orderBy(desc(documents.createdAt));
      const items = [];
      for (const d of all) if (await canSee(user, d)) items.push({ ...d, manageable: await canManage(user, params.id, await dataCategoryOf(d.categoryId)) });
      return { items };
    });

    route({ method: 'POST', url: '/api/v1/persons/:id/documents', tag: 'documents', summary: 'Upload a document (multipart: file, categoryId?, name?, documentDate?, employeeVisible?)' }, async ({ user, params, raw }, reply) => {
      const self = params.id === user.personId && authz.has(user, 'documents.read');
      // Whether the uploader may manage documents of the chosen category is checked once the fields are read.
      if (!self && !(await authz.can(user, 'documents.write', params.id))) throw forbidden();
      const [owner] = await db.select({ id: persons.id }).from(persons).where(eq(persons.id, params.id));
      if (!owner) throw notFound('Person not found');
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
        .object({ categoryId: z.string().uuid().optional(), name: z.string().min(1).max(200).optional(), documentDate: isoDateSchema.optional(), employeeVisible: z.enum(['true', 'false']).optional() })
        .parse(fields);
      const full = await canManage(user, params.id, await dataCategoryOf(meta.categoryId ?? null));
      if (!full && !self) throw forbidden('No edit access to this document category');
      const row = await store(user, params.id, {
        name: meta.name ?? file.filename,
        mime: file.mimetype,
        data: file.data,
        categoryId: meta.categoryId ?? null,
        documentDate: meta.documentDate ?? null,
        // Self-uploads are always visible to the uploader.
        employeeVisible: full ? (meta.employeeVisible ? meta.employeeVisible === 'true' : undefined) : true,
      });
      reply.code(201);
      return row;
    });

    route({ method: 'GET', url: '/api/v1/documents/:id/download', tag: 'documents', summary: 'Download a document' }, async ({ user, params }, reply) => {
      const d = await loadDoc(user, params.id);
      if (!(await storage.exists(d.fileKey))) throw notFound('File missing in storage');
      const safeName = d.name.replace(/[^\w.\- äöüÄÖÜß]/g, '_');
      reply
        .header('content-type', d.mime)
        .header('content-disposition', `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(d.name)}`)
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, no-store');
      return reply.send(storage.stream(d.fileKey));
    });

    route(
      { method: 'PATCH', url: '/api/v1/documents/:id', tag: 'documents', summary: 'Update document metadata', body: z.object({ name: z.string().min(1).max(200).optional(), categoryId: z.string().uuid().nullable().optional(), documentDate: isoDateSchema.nullable().optional(), employeeVisible: z.boolean().optional() }) },
      async ({ user, params, body }) => {
        const d = await loadDoc(user, params.id);
        if (!(await canManage(user, d.ownerPersonId!, await dataCategoryOf(d.categoryId)))) throw forbidden();
        const [row] = await db.update(documents).set(body).where(eq(documents.id, d.id)).returning();
        await audit(db, user.userId, 'document', d.id, 'update', body);
        return row;
      },
    );

    route({ method: 'DELETE', url: '/api/v1/documents/:id', tag: 'documents', summary: 'Delete a document' }, async ({ user, params }) => {
      const d = await loadDoc(user, params.id);
      if (!(await canManage(user, d.ownerPersonId!, await dataCategoryOf(d.categoryId)))) throw forbidden();
      await db.transaction(async (tx) => {
        await tx.delete(documents).where(eq(documents.id, d.id));
        await audit(tx, user.userId, 'document', d.id, 'delete', { name: d.name });
        await emit(tx, 'document.deleted', { documentId: d.id, personId: d.ownerPersonId });
      });
      // Content-addressed storage: only remove the file if no other document uses it.
      const [other] = await db.select({ id: documents.id }).from(documents).where(and(eq(documents.fileKey, d.fileKey), ne(documents.id, d.id))).limit(1);
      if (!other) await storage.delete(d.fileKey);
    });

    // ---------- Templates ----------
    const tplBody = z.object({ name: z.string().min(1).max(200), body: z.string().min(1).max(100_000), categoryId: z.string().uuid().nullish() });
    route({ method: 'GET', url: '/api/v1/document-templates', perm: 'documents.write', tag: 'documents', summary: 'List templates' }, async () => ({ items: await db.select().from(documentTemplates).orderBy(asc(documentTemplates.name)) }));
    route({ method: 'POST', url: '/api/v1/document-templates', perm: 'documents.manage', tag: 'documents', summary: 'Create template', body: tplBody }, async ({ user, body }, reply) => {
      const [t] = await db.insert(documentTemplates).values({ ...body, categoryId: body.categoryId ?? null }).returning();
      await audit(db, user.userId, 'document_template', t.id, 'create', { name: body.name });
      reply.code(201);
      return t;
    });
    route({ method: 'PATCH', url: '/api/v1/document-templates/:id', perm: 'documents.manage', tag: 'documents', summary: 'Update template', body: tplBody.partial() }, async ({ user, body, params }) => {
      const [t] = await db.update(documentTemplates).set(body).where(eq(documentTemplates.id, params.id)).returning();
      if (!t) throw notFound();
      await audit(db, user.userId, 'document_template', t.id, 'update', { name: body.name });
      return t;
    });
    route({ method: 'DELETE', url: '/api/v1/document-templates/:id', perm: 'documents.manage', tag: 'documents', summary: 'Delete template' }, async ({ user, params }) => {
      const res = await db.delete(documentTemplates).where(eq(documentTemplates.id, params.id)).returning();
      if (!res.length) throw notFound();
      await audit(db, user.userId, 'document_template', params.id, 'delete');
    });
    route(
      { method: 'POST', url: '/api/v1/document-templates/:id/render/:personId', tag: 'documents', summary: 'Render a template for a person, optionally saving it as a document', body: z.object({ save: z.boolean().default(false) }) },
      async ({ user, params, body }) => {
        await authz.assert(user, 'documents.write', params.personId);
        const [t] = await db.select().from(documentTemplates).where(eq(documentTemplates.id, params.id));
        if (!t) throw notFound('Template not found');
        if (!(await canManage(user, params.personId, await dataCategoryOf(t.categoryId)))) throw forbidden('No edit access to this document category');
        const [person] = await db.select().from(persons).where(eq(persons.id, params.personId));
        if (!person) throw notFound('Person not found');
        const today = new Date().toISOString().slice(0, 10);
        const employment = (await currentEmployment(db, params.personId, today)) ?? {};
        const [c] = await db.select().from(company).limit(1);
        const content = renderTemplate(t.body, { person: person as any, employment: employment as any, company: { name: c?.name }, today: { date: today } });
        const document = body.save
          ? await store(user, params.personId, { name: `${t.name} – ${person.firstName} ${person.lastName}.md`, mime: 'text/markdown', data: Buffer.from(content, 'utf8'), categoryId: t.categoryId, documentDate: today })
          : null;
        return { content, document };
      },
    );
  },
};
