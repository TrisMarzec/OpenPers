import { and, asc, eq, ilike, inArray, isNull, lte, or } from 'drizzle-orm';
import { z } from 'zod';
import { atLeast, DATA_CATEGORIES, PERSON_FIELD_CATEGORY, type DataCategory } from '@openpers/shared';

/** Categories whose reads by third parties are written to the audit log. */
const SENSITIVE_CATEGORIES: DataCategory[] = ['compensation', 'payroll'];
import type { Exec } from '../../db';
import {
  attributeDefinitions,
  attributeValues,
  employmentChanges,
  employmentCostCenters,
  employmentOrgUnits,
  employments,
  orgUnits,
  persons,
  sessions,
  users,
  workplaces,
  workSchedules,
} from '../../db/schema';
import { registerCompensationRoutes } from './compensation';
import { decodeCursor, makeRoute, page, paginationQuery } from '../../lib/api';
import type { Principal } from '../../lib/authz';
import { audit, diff, emit, type AppContext, type OpenPersModule } from '../../lib/context';
import { forbidden, notFound, unprocessable } from '../../lib/errors';
import { photoUrl, readImageUpload, releaseFile, sendImage } from '../../lib/images';
import { createPersonInput, createPersonWithEmployment, employmentInput, isoDateSchema, personInput, weeklyHoursSchema } from './service';

const today = () => new Date().toISOString().slice(0, 10);


const employmentPatch = employmentInput
  .omit({ startDate: true, weeklyHours: true, fullTimeWeeklyHours: true })
  .partial()
  .extend({ startDate: isoDateSchema.optional(), effectiveDate: isoDateSchema.optional() });

type EmploymentChanges = Omit<z.infer<typeof employmentPatch>, 'effectiveDate'>;

async function applyEmploymentChange(tx: Exec, employmentId: string, changes: EmploymentChanges) {
  const { orgUnitIds, costCenters, ...fields } = changes;
  const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  if (Object.keys(clean).length) await tx.update(employments).set(clean).where(eq(employments.id, employmentId));
  if (orgUnitIds) {
    await tx.delete(employmentOrgUnits).where(eq(employmentOrgUnits.employmentId, employmentId));
    if (orgUnitIds.length) await tx.insert(employmentOrgUnits).values(orgUnitIds.map((orgUnitId) => ({ employmentId, orgUnitId })));
  }
  if (costCenters) {
    await tx.delete(employmentCostCenters).where(eq(employmentCostCenters.employmentId, employmentId));
    if (costCenters.length) await tx.insert(employmentCostCenters).values(costCenters.map((c) => ({ employmentId, costCenterId: c.id, weight: c.weight })));
  }
}

/** Applies scheduled employment changes whose effective date has been reached. */
export async function applyDueEmploymentChanges(db: Exec) {
  const due = await db
    .select()
    .from(employmentChanges)
    .where(and(isNull(employmentChanges.appliedAt), lte(employmentChanges.effectiveDate, today())))
    .orderBy(asc(employmentChanges.effectiveDate), asc(employmentChanges.createdAt));
  for (const c of due) {
    await db.transaction(async (tx) => {
      await applyEmploymentChange(tx, c.employmentId, c.changes as EmploymentChanges);
      await tx.update(employmentChanges).set({ appliedAt: new Date() }).where(eq(employmentChanges.id, c.id));
      await audit(tx, c.createdByUserId, 'employment', c.employmentId, 'scheduled_change_applied', c.changes);
      await emit(tx, 'employment.updated', { employmentId: c.employmentId, changes: c.changes });
    });
  }
}

function pickCurrent<T extends { startDate: string; endDate: string | null }>(list: T[]): T | undefined {
  const d = today();
  const sorted = [...list].sort((a, b) => b.startDate.localeCompare(a.startDate));
  return sorted.find((e) => e.startDate <= d && (!e.endDate || e.endDate >= d)) ?? sorted[0];
}

export const peopleModule: OpenPersModule = {
  name: 'people',
  register(app, ctx: AppContext) {
    const { db, authz, cipher, storage } = ctx;
    const route = makeRoute(app, ctx.registry);
    registerCompensationRoutes(app, ctx);

    async function loadPerson(id: string) {
      const [p] = await db.select().from(persons).where(eq(persons.id, id));
      if (!p) throw notFound('Person not found');
      return p;
    }

    async function employmentsOf(personIds: string[]) {
      if (!personIds.length) return [];
      const emps = await db.select().from(employments).where(inArray(employments.personId, personIds));
      const ids = emps.map((e) => e.id);
      const [ous, ccs, schedules] = ids.length
        ? await Promise.all([
            db.select({ employmentId: employmentOrgUnits.employmentId, id: orgUnits.id, name: orgUnits.name, type: orgUnits.type }).from(employmentOrgUnits).innerJoin(orgUnits, eq(orgUnits.id, employmentOrgUnits.orgUnitId)).where(inArray(employmentOrgUnits.employmentId, ids)),
            db.select().from(employmentCostCenters).where(inArray(employmentCostCenters.employmentId, ids)),
            db.select().from(workSchedules).where(inArray(workSchedules.employmentId, ids)).orderBy(asc(workSchedules.validFrom)),
          ])
        : [[], [], []];
      return emps.map((e) => ({
        ...e,
        orgUnits: ous.filter((o) => o.employmentId === e.id).map(({ employmentId: _, ...o }) => o),
        orgUnitIds: ous.filter((o) => o.employmentId === e.id).map((o) => o.id),
        costCenters: ccs.filter((c) => c.employmentId === e.id).map((c) => ({ id: c.costCenterId, weight: c.weight })),
        schedules: schedules.filter((s) => s.employmentId === e.id).map((s) => ({ id: s.id, validFrom: s.validFrom, hours: s.hours, fullTimeWeeklyHours: s.fullTimeWeeklyHours })),
      }));
    }

    /** Custom attributes the user may see, decided per attribute by its data category. */
    async function attributesOf(user: Principal, personId: string, forceAll = false) {
      const defs = await db.select().from(attributeDefinitions).orderBy(asc(attributeDefinitions.position));
      const values = await db.select().from(attributeValues).where(eq(attributeValues.personId, personId));
      const access = forceAll ? null : await authz.categoryAccess(user, personId);
      const out: Record<string, unknown> = {};
      let readSensitive = false;
      for (const d of defs) {
        const v = values.find((x) => x.definitionId === d.id);
        if (!v) continue;
        if (access && !atLeast(access[d.category as DataCategory] ?? 'none', 'view')) continue;
        out[d.key] = d.sensitive ? cipher.decrypt((v.value as { enc: string }).enc) : v.value;
        if (SENSITIVE_CATEGORIES.includes(d.category as DataCategory)) readSensitive = true;
      }
      if (readSensitive && user.personId !== personId) await audit(db, user.userId, 'person', personId, 'read_sensitive', { categories: ['payroll'] });
      return out;
    }

    /** Fields every viewer of an employment may see (they also appear in the company directory). */
    const PUBLIC_EMPLOYMENT_FIELDS = ['id', 'personId', 'positionTitle', 'status', 'orgUnits', 'orgUnitIds', 'workplaceId'] as const;

    async function detail(user: Principal, id: string) {
      const p = await loadPerson(id);
      const access = await authz.categoryAccess(user, id);
      const emps = await employmentsOf([id]);
      const supIds = [...new Set(emps.map((e) => e.supervisorPersonId).filter(Boolean))] as string[];
      const sups = supIds.length ? await db.select({ id: persons.id, firstName: persons.firstName, lastName: persons.lastName }).from(persons).where(inArray(persons.id, supIds)) : [];
      const [account] = await db.select({ id: users.id, email: users.email, active: users.active }).from(users).where(eq(users.personId, id));
      const { photoKey: _k, photoMime: _m, photoUpdatedAt: _u, photoDocumentId: _d, ...rest } = p;
      const person: Record<string, unknown> = { ...rest, photoUrl: photoUrl(p) };
      for (const [field, cat] of Object.entries(PERSON_FIELD_CATEGORY)) if (!atLeast(access[cat], 'view')) delete person[field];
      const fullEmployment = atLeast(access.employment, 'view');
      const employments = emps.map((e) => {
        const withSup = { ...e, supervisor: sups.find((s) => s.id === e.supervisorPersonId) ?? null };
        return fullEmployment ? withSup : Object.fromEntries(PUBLIC_EMPLOYMENT_FIELDS.map((k) => [k, (withSup as Record<string, unknown>)[k]]));
      });
      const current = pickCurrent(emps);
      return {
        ...person,
        access,
        employments,
        currentEmployment: current ? employments.find((e) => e.id === current.id) ?? null : null,
        attributes: await attributesOf(user, id),
        user: account && (user.personId === id || authz.has(user, 'users.manage')) ? account : null,
      };
    }

    /** Throws 403 unless the user has `edit` on every given category for this person. */
    async function assertEdit(user: Principal, personId: string, categories: DataCategory[]) {
      const access = await authz.categoryAccess(user, personId);
      const denied = categories.filter((c) => !atLeast(access[c], 'edit'));
      if (denied.length) throw forbidden(`No edit access to: ${denied.join(', ')}`);
    }

    // ---------- Directory ----------
    route({ method: 'GET', url: '/api/v1/directory', tag: 'people', summary: 'Company directory (basic fields, all employees)' }, async () => {
      await applyDueEmploymentChanges(db);
      const list = await db.select({ id: persons.id, firstName: persons.firstName, lastName: persons.lastName, preferredName: persons.preferredName, email: persons.email, photoUpdatedAt: persons.photoUpdatedAt }).from(persons).where(isNull(persons.anonymizedAt)).orderBy(asc(persons.lastName), asc(persons.firstName));
      const emps = await employmentsOf(list.map((p) => p.id));
      const wps = await db.select().from(workplaces);
      return {
        items: list
          .map((p) => {
            const e = pickCurrent(emps.filter((x) => x.personId === p.id));
            if (!e || e.status === 'INACTIVE') return null;
            const { photoUpdatedAt: _u, ...base } = p;
            return { ...base, photoUrl: photoUrl(p), positionTitle: e.positionTitle, status: e.status, orgUnits: e.orgUnits, supervisorPersonId: e.supervisorPersonId, workplace: wps.find((w) => w.id === e.workplaceId)?.name ?? null };
          })
          .filter(Boolean),
      };
    });

    // ---------- Persons ----------
    route(
      {
        method: 'GET',
        url: '/api/v1/persons',
        perm: 'people.read',
        tag: 'people',
        summary: 'List persons visible to the caller',
        query: paginationQuery.extend({ search: z.string().optional(), status: z.enum(['ACTIVE', 'INACTIVE', 'ONBOARDING', 'LEAVE']).optional(), orgUnitId: z.string().uuid().optional(), includeAnonymized: z.coerce.boolean().default(false) }),
      },
      async ({ user, query }) => {
        await applyDueEmploymentChanges(db);
        const visible = await authz.visiblePersonIds(user, 'people.read');
        if (visible !== 'all' && visible.size === 0) return { items: [], nextCursor: null };
        const conds = [
          visible === 'all' ? undefined : inArray(persons.id, [...visible]),
          query.includeAnonymized ? undefined : isNull(persons.anonymizedAt),
          query.search ? or(ilike(persons.firstName, `%${query.search}%`), ilike(persons.lastName, `%${query.search}%`), ilike(persons.email, `%${query.search}%`)) : undefined,
        ].filter(Boolean) as any[];
        const list = await db.select().from(persons).where(conds.length ? and(...conds) : undefined).orderBy(asc(persons.lastName), asc(persons.firstName));
        const emps = await employmentsOf(list.map((p) => p.id));
        let rows = list.map((p) => {
          const e = pickCurrent(emps.filter((x) => x.personId === p.id));
          return {
            id: p.id,
            firstName: p.firstName,
            lastName: p.lastName,
            preferredName: p.preferredName,
            email: p.email,
            photoUrl: photoUrl(p),
            employmentId: e?.id ?? null,
            positionTitle: e?.positionTitle ?? null,
            status: e?.status ?? null,
            startDate: e?.startDate ?? null,
            endDate: e?.endDate ?? null,
            supervisorPersonId: e?.supervisorPersonId ?? null,
            orgUnits: e?.orgUnits ?? [],
          };
        });
        if (query.status) rows = rows.filter((r) => r.status === query.status);
        if (query.orgUnitId) rows = rows.filter((r) => r.orgUnits.some((o) => o.id === query.orgUnitId));
        const offset = decodeCursor(query.cursor);
        return page(rows.slice(offset, offset + query.limit + 1), offset, query.limit);
      },
    );

    route({ method: 'POST', url: '/api/v1/persons', perm: 'people.write', tag: 'people', summary: 'Create a person with an employment', body: createPersonInput }, async ({ user, body }, reply) => {
      if ((await authz.visiblePersonIds(user, 'people.write')) !== 'all') throw forbidden('Creating persons requires company-wide people.write');
      if (body.employment.supervisorPersonId) await loadPerson(body.employment.supervisorPersonId);
      const { personId } = await db.transaction((tx) => createPersonWithEmployment(tx, body, user.userId));
      reply.code(201);
      return detail(user, personId);
    });

    route({ method: 'GET', url: '/api/v1/persons/:id', tag: 'people', summary: 'Person details' }, async ({ user, params }) => {
      await applyDueEmploymentChanges(db);
      await authz.assert(user, 'people.read', params.id);
      return detail(user, params.id);
    });

    // ---------- Photo ----------
    route({ method: 'GET', url: '/api/v1/persons/:id/photo', tag: 'people', summary: 'Profile photo (404 if none)' }, async ({ params }, reply) => {
      const p = await loadPerson(params.id);
      if (!p.photoKey || !p.photoMime || p.anonymizedAt) throw notFound('No photo');
      return sendImage(reply, storage, p.photoKey, p.photoMime, 'private');
    });
    /** Own photo always; others need edit access to their basic data (profile category). */
    async function assertPhotoEdit(user: Principal, personId: string) {
      if (user.personId === personId) return;
      if (!atLeast((await authz.categoryAccess(user, personId)).profile, 'edit')) throw forbidden();
    }
    route({ method: 'PUT', url: '/api/v1/persons/:id/photo', tag: 'people', summary: 'Upload a profile photo (multipart: file; PNG, JPEG or WebP, max. 2 MB)' }, async ({ user, params, raw }) => {
      const before = await loadPerson(params.id);
      await assertPhotoEdit(user, params.id);
      const img = await readImageUpload(raw, false);
      const file = await storage.put(img.data);
      const [p] = await db.update(persons).set({ photoKey: file.key, photoMime: img.mime, photoUpdatedAt: new Date() }).where(eq(persons.id, params.id)).returning();
      await audit(db, user.userId, 'person', params.id, 'photo_update');
      if (before.photoKey !== file.key) await releaseFile(db, storage, before.photoKey);
      return { photoUrl: photoUrl(p) };
    });
    route({ method: 'DELETE', url: '/api/v1/persons/:id/photo', tag: 'people', summary: 'Remove the profile photo' }, async ({ user, params }) => {
      const before = await loadPerson(params.id);
      await assertPhotoEdit(user, params.id);
      await db.update(persons).set({ photoKey: null, photoMime: null, photoUpdatedAt: null }).where(eq(persons.id, params.id));
      await audit(db, user.userId, 'person', params.id, 'photo_delete');
      await releaseFile(db, storage, before.photoKey);
    });

    route({ method: 'PATCH', url: '/api/v1/persons/:id', tag: 'people', summary: 'Update personal data', body: personInput.partial() }, async ({ user, params, body }) => {
      // Every changed field needs `edit` on its data category (own profile or others in scope).
      const categories = [...new Set(Object.keys(body).map((k) => PERSON_FIELD_CATEGORY[k]).filter(Boolean))] as DataCategory[];
      await assertEdit(user, params.id, categories);
      const before = await loadPerson(params.id);
      await db.transaction(async (tx) => {
        await tx.update(persons).set({ ...body, updatedAt: new Date() }).where(eq(persons.id, params.id));
        await audit(tx, user.userId, 'person', params.id, 'update', diff(before, body));
        await emit(tx, 'person.updated', { personId: params.id, fields: Object.keys(body) });
      });
      return detail(user, params.id);
    });

    route({ method: 'POST', url: '/api/v1/persons/:id/anonymize', tag: 'people', summary: 'Anonymize a person (DSGVO Art. 17)' }, async ({ user, params }) => {
      if ((await authz.visiblePersonIds(user, 'people.write')) !== 'all') throw forbidden();
      const before = await loadPerson(params.id);
      await db.transaction(async (tx) => {
        await tx
          .update(persons)
          .set({ firstName: 'Anonymisiert', lastName: params.id.slice(0, 8), preferredName: null, email: `anonymized-${params.id}@invalid.local`, gender: 'UNKNOWN', birthDate: null, phone: null, privateAddress: null, emergencyContact: null, photoDocumentId: null, photoKey: null, photoMime: null, photoUpdatedAt: null, anonymizedAt: new Date(), updatedAt: new Date() })
          .where(eq(persons.id, params.id));
        await tx.delete(attributeValues).where(eq(attributeValues.personId, params.id));
        const accounts = await tx.update(users).set({ active: false, email: `anonymized-${params.id}@invalid.local`, passwordHash: null }).where(eq(users.personId, params.id)).returning({ id: users.id });
        for (const a of accounts) await tx.delete(sessions).where(eq(sessions.userId, a.id));
        for (const anonymize of ctx.anonymizers) await anonymize(tx, params.id);
        await audit(tx, user.userId, 'person', params.id, 'anonymize');
        await emit(tx, 'person.anonymized', { personId: params.id });
      });
      await releaseFile(db, storage, before.photoKey);
      return detail(user, params.id);
    });

    route({ method: 'GET', url: '/api/v1/persons/:id/export', tag: 'people', summary: 'Export all personal data (DSGVO Art. 15)' }, async ({ user, params }) => {
      await authz.assert(user, 'people.read', params.id);
      const person = await loadPerson(params.id);
      const emps = await employmentsOf([params.id]);
      const changes = emps.length ? await db.select().from(employmentChanges).where(inArray(employmentChanges.employmentId, emps.map((e) => e.id))) : [];
      const self = user.personId === params.id;
      const extra: Record<string, unknown> = {};
      for (const [name, exporter] of Object.entries(ctx.exporters)) extra[name] = await exporter(db, params.id);
      await audit(db, user.userId, 'person', params.id, 'export');
      return { exportedAt: new Date().toISOString(), person, employments: emps, employmentChanges: changes, attributes: await attributesOf(user, params.id, self), ...extra };
    });

    // ---------- Employments ----------
    route({ method: 'POST', url: '/api/v1/persons/:id/employments', perm: 'people.write', tag: 'people', summary: 'Add an employment', body: employmentInput }, async ({ user, params, body }, reply) => {
      await authz.assert(user, 'people.write', params.id);
      await assertEdit(user, params.id, ['employment']);
      await loadPerson(params.id);
      if (body.supervisorPersonId === params.id) throw unprocessable('Invalid supervisor', [{ path: 'supervisorPersonId', message: 'A person cannot supervise themselves' }]);
      const [e] = await db.transaction(async (tx) => {
        const rows = await tx
          .insert(employments)
          .values({ personId: params.id, startDate: body.startDate, endDate: body.endDate ?? null, probationEndDate: body.probationEndDate ?? null, status: body.status, type: body.type, contractType: body.contractType, employeeNumber: body.employeeNumber ?? null, positionTitle: body.positionTitle ?? null, legalEntityId: body.legalEntityId ?? null, workplaceId: body.workplaceId ?? null, supervisorPersonId: body.supervisorPersonId ?? null })
          .returning();
        await applyEmploymentChange(tx, rows[0].id, { orgUnitIds: body.orgUnitIds, costCenters: body.costCenters });
        await tx.insert(workSchedules).values({ employmentId: rows[0].id, validFrom: body.startDate, hours: body.weeklyHours, fullTimeWeeklyHours: body.fullTimeWeeklyHours });
        await audit(tx, user.userId, 'employment', rows[0].id, 'create', { personId: params.id });
        await emit(tx, 'employment.created', { personId: params.id, employmentId: rows[0].id });
        return rows;
      });
      reply.code(201);
      return (await employmentsOf([params.id])).find((x) => x.id === e.id);
    });

    route(
      { method: 'PATCH', url: '/api/v1/persons/:id/employments/:eid', perm: 'people.write', tag: 'people', summary: 'Change an employment, optionally effective at a future date', body: employmentPatch },
      async ({ user, params, body }) => {
        await authz.assert(user, 'people.write', params.id);
      await assertEdit(user, params.id, ['employment']);
        const [before] = await db.select().from(employments).where(and(eq(employments.id, params.eid), eq(employments.personId, params.id)));
        if (!before) throw notFound('Employment not found');
        const { effectiveDate, ...changes } = body;
        if (changes.supervisorPersonId === params.id) throw unprocessable('Invalid supervisor', [{ path: 'supervisorPersonId', message: 'A person cannot supervise themselves' }]);
        await db.transaction(async (tx) => {
          if (effectiveDate && effectiveDate > today()) {
            await tx.insert(employmentChanges).values({ employmentId: params.eid, effectiveDate, changes, createdByUserId: user.userId });
            await audit(tx, user.userId, 'employment', params.eid, 'schedule_change', { effectiveDate, ...changes });
          } else {
            await applyEmploymentChange(tx, params.eid, changes);
            await audit(tx, user.userId, 'employment', params.eid, 'update', diff(before, changes));
            await emit(tx, 'employment.updated', { personId: params.id, employmentId: params.eid, changes });
          }
        });
        return (await employmentsOf([params.id])).find((x) => x.id === params.eid);
      },
    );

    route({ method: 'GET', url: '/api/v1/persons/:id/employments/:eid/changes', tag: 'people', summary: 'Scheduled and applied employment changes' }, async ({ user, params }) => {
      await authz.assert(user, 'people.read', params.id);
      const items = await db.select().from(employmentChanges).where(eq(employmentChanges.employmentId, params.eid)).orderBy(asc(employmentChanges.effectiveDate));
      return { items };
    });

    route({ method: 'DELETE', url: '/api/v1/persons/:id/employments/:eid/changes/:cid', perm: 'people.write', tag: 'people', summary: 'Cancel a scheduled change' }, async ({ user, params }) => {
      await authz.assert(user, 'people.write', params.id);
      await assertEdit(user, params.id, ['employment']);
      const res = await db.delete(employmentChanges).where(and(eq(employmentChanges.id, params.cid), eq(employmentChanges.employmentId, params.eid), isNull(employmentChanges.appliedAt))).returning();
      if (!res.length) throw notFound();
      await audit(db, user.userId, 'employment', params.eid, 'cancel_scheduled_change', { changeId: params.cid });
    });

    route(
      {
        method: 'POST',
        url: '/api/v1/persons/:id/employments/:eid/schedules',
        perm: 'people.write',
        tag: 'people',
        summary: 'Add a work schedule version',
        body: z.object({ validFrom: isoDateSchema, weeklyHours: weeklyHoursSchema, fullTimeWeeklyHours: z.number().min(1).max(80).default(40) }),
      },
      async ({ user, params, body }, reply) => {
        await authz.assert(user, 'people.write', params.id);
      await assertEdit(user, params.id, ['employment']);
        const [e] = await db.select().from(employments).where(and(eq(employments.id, params.eid), eq(employments.personId, params.id)));
        if (!e) throw notFound('Employment not found');
        const [row] = await db
          .insert(workSchedules)
          .values({ employmentId: params.eid, validFrom: body.validFrom, hours: body.weeklyHours, fullTimeWeeklyHours: body.fullTimeWeeklyHours })
          .onConflictDoUpdate({ target: [workSchedules.employmentId, workSchedules.validFrom], set: { hours: body.weeklyHours, fullTimeWeeklyHours: body.fullTimeWeeklyHours } })
          .returning();
        await audit(db, user.userId, 'employment', params.eid, 'schedule', body);
        reply.code(201);
        return row;
      },
    );

    // ---------- Custom attributes ----------
    const defBody = z.object({
      key: z.string().regex(/^[a-z][a-z0-9_]{1,49}$/),
      label: z.string().min(1).max(100),
      type: z.enum(['text', 'number', 'date', 'select', 'boolean']),
      options: z.array(z.string()).nullish(),
      section: z.string().max(50).default('general'),
      sensitive: z.boolean().default(false),
      category: z.enum(DATA_CATEGORIES).optional(),
      position: z.number().int().default(0),
    });
    route({ method: 'GET', url: '/api/v1/attribute-definitions', tag: 'people', summary: 'List custom attribute definitions' }, async () => ({
      items: (await db.select().from(attributeDefinitions).orderBy(asc(attributeDefinitions.position), asc(attributeDefinitions.label))).map((d) => ({ ...d, sensitive: !!d.sensitive })),
    }));
    route({ method: 'POST', url: '/api/v1/attribute-definitions', perm: 'people.write', tag: 'people', summary: 'Create a custom attribute', body: defBody }, async ({ user, body }, reply) => {
      if (body.type === 'select' && !body.options?.length) throw unprocessable('Select attributes need options', [{ path: 'options', message: 'Required for select' }]);
      const [d] = await db.insert(attributeDefinitions).values({ ...body, options: body.options ?? null, sensitive: body.sensitive ? 1 : 0, category: body.category ?? (body.sensitive ? 'payroll' : 'employment') }).returning();
      await audit(db, user.userId, 'attribute_definition', d.id, 'create', body);
      reply.code(201);
      return { ...d, sensitive: !!d.sensitive };
    });
    route({ method: 'PATCH', url: '/api/v1/attribute-definitions/:id', perm: 'people.write', tag: 'people', summary: 'Update a custom attribute', body: defBody.omit({ key: true, sensitive: true, type: true }).partial() }, async ({ user, params, body }) => {
      const [d] = await db.update(attributeDefinitions).set(body).where(eq(attributeDefinitions.id, params.id)).returning();
      if (!d) throw notFound();
      await audit(db, user.userId, 'attribute_definition', d.id, 'update', body);
      return { ...d, sensitive: !!d.sensitive };
    });
    route({ method: 'DELETE', url: '/api/v1/attribute-definitions/:id', perm: 'people.write', tag: 'people', summary: 'Delete a custom attribute and its values' }, async ({ user, params }) => {
      const res = await db.delete(attributeDefinitions).where(eq(attributeDefinitions.id, params.id)).returning();
      if (!res.length) throw notFound();
      await audit(db, user.userId, 'attribute_definition', params.id, 'delete');
    });

    route({ method: 'PUT', url: '/api/v1/persons/:id/attributes', tag: 'people', summary: 'Set custom attribute values (null removes)', body: z.record(z.unknown()) }, async ({ user, params, body }) => {
      await loadPerson(params.id);
      const defs = await db.select().from(attributeDefinitions);
      const errors: { path: string; message: string }[] = [];
      for (const [key, value] of Object.entries(body)) {
        const d = defs.find((x) => x.key === key);
        if (!d) errors.push({ path: key, message: 'Unknown attribute' });
        else if (value !== null && !validAttribute(d.type, d.options, value)) errors.push({ path: key, message: `Invalid value for ${d.type}` });
      }
      if (errors.length) throw unprocessable('Invalid attributes', errors);
      // Each attribute needs `edit` on its data category.
      await assertEdit(user, params.id, [...new Set(Object.keys(body).map((k) => defs.find((x) => x.key === k)!.category as DataCategory))]);
      await db.transaction(async (tx) => {
        for (const [key, value] of Object.entries(body)) {
          const d = defs.find((x) => x.key === key)!;
          if (value === null) {
            await tx.delete(attributeValues).where(and(eq(attributeValues.personId, params.id), eq(attributeValues.definitionId, d.id)));
            continue;
          }
          const stored = d.sensitive ? { enc: cipher.encrypt(value) } : value;
          await tx
            .insert(attributeValues)
            .values({ personId: params.id, definitionId: d.id, value: stored })
            .onConflictDoUpdate({ target: [attributeValues.personId, attributeValues.definitionId], set: { value: stored, updatedAt: new Date() } });
        }
        const logged = Object.fromEntries(Object.keys(body).map((k) => [k, defs.find((x) => x.key === k)!.sensitive ? '***' : body[k]]));
        await audit(tx, user.userId, 'person', params.id, 'attributes', logged);
      });
      return attributesOf(user, params.id);
    });
  },
};

function validAttribute(type: string, options: string[] | null, value: unknown): boolean {
  switch (type) {
    case 'text':
      return typeof value === 'string' && value.length <= 2000;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'date':
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
    case 'select':
      return typeof value === 'string' && !!options?.includes(value);
    default:
      return false;
  }
}
