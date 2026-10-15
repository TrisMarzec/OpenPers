import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { addDays } from '@openpers/shared';
import type { Exec } from '../../db';
import { applications, company, checklists, checklistTasks, checklistTemplates, checklistTemplateTasks, employmentOrgUnits, employments, hiringTeamMembers, notifications, persons, roleAssignments, roles, users } from '../../db/schema';
import { makeRoute } from '../../lib/api';
import { audit, onEvent, type AppContext, type OpenPersModule } from '../../lib/context';
import { forbidden, notFound, unprocessable } from '../../lib/errors';
import { currentEmployment, isoDateSchema } from '../people/service';

type Template = typeof checklistTemplates.$inferSelect;
const today = () => new Date().toISOString().slice(0, 10);
/** New hires older than this are treated as data imports: no automatic onboarding. */
const AUTO_ONBOARDING_MAX_DAYS_AGO = 30;

const DEFAULT_TEMPLATES = [
  {
    name: 'Onboarding Standard',
    kind: 'onboarding',
    tasks: [
      { title: 'Unterschriebenen Arbeitsvertrag ablegen', assignee: 'hr', offsetDays: -14 },
      { title: 'Zugänge und Hardware bestellen', assignee: 'hr', offsetDays: -7 },
      { title: 'Einarbeitungsplan erstellen', assignee: 'manager', offsetDays: -3 },
      { title: 'Willkommensgespräch am ersten Tag', assignee: 'manager', offsetDays: 0 },
      { title: 'Persönliche Daten und Bankverbindung prüfen', assignee: 'employee', offsetDays: 0 },
      { title: 'Datenschutz-Unterweisung bestätigen', assignee: 'employee', offsetDays: 7 },
      { title: 'Feedbackgespräch nach 30 Tagen', assignee: 'manager', offsetDays: 30 },
      { title: 'Gespräch vor Ende der Probezeit', assignee: 'manager', offsetDays: 150 },
    ],
  },
  {
    name: 'Offboarding Standard',
    kind: 'offboarding',
    tasks: [
      { title: 'Resturlaub abstimmen', assignee: 'employee', offsetDays: -21 },
      { title: 'Übergabe der Aufgaben planen', assignee: 'manager', offsetDays: -14 },
      { title: 'Arbeitszeugnis erstellen', assignee: 'hr', offsetDays: -14 },
      { title: 'Abschlussgespräch führen', assignee: 'manager', offsetDays: -2 },
      { title: 'Zugänge sperren', assignee: 'hr', offsetDays: 0 },
      { title: 'Hardware zurücknehmen', assignee: 'hr', offsetDays: 0 },
    ],
  },
] as const;

const taskInput = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
  assignee: z.enum(['hr', 'manager', 'employee', 'person']),
  assigneePersonId: z.string().uuid().nullish(),
  offsetDays: z.number().int().min(-365).max(730).default(0),
});
const templateBody = z.object({
  name: z.string().min(1).max(200),
  kind: z.enum(['onboarding', 'offboarding']),
  orgUnitId: z.string().uuid().nullish(),
  workplaceId: z.string().uuid().nullish(),
  autoStart: z.boolean().default(false),
  active: z.boolean().default(true),
  tasks: z.array(taskInput).max(100).default([]),
});

// ---------- helpers usable inside transactions ----------

async function userOfPerson(tx: Exec, personId: string | null | undefined): Promise<string | null> {
  if (!personId) return null;
  const [u] = await tx.select({ id: users.id }).from(users).where(and(eq(users.personId, personId), eq(users.active, true)));
  return u?.id ?? null;
}

async function personName(tx: Exec, personId: string): Promise<string> {
  const [p] = await tx.select({ firstName: persons.firstName, lastName: persons.lastName, preferredName: persons.preferredName }).from(persons).where(eq(persons.id, personId));
  return p ? `${p.preferredName || p.firstName} ${p.lastName}` : '';
}

/** Active users holding a permission with company-wide scope (HR, admins). */
async function usersWithGlobal(tx: Exec, permission: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ id: users.id })
    .from(users)
    .innerJoin(roleAssignments, eq(roleAssignments.userId, users.id))
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(and(eq(users.active, true), eq(roleAssignments.scope, 'all'), sql`${roles.permissions} @> ${JSON.stringify([permission])}::jsonb`));
  return rows.map((r) => r.id);
}

async function userHasPermission(tx: Exec, userId: string, permission: string): Promise<boolean> {
  const rows = await tx
    .select({ id: roles.id })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(and(eq(roleAssignments.userId, userId), sql`${roles.permissions} @> ${JSON.stringify([permission])}::jsonb`));
  return rows.length > 0;
}

export async function notify(tx: Exec, userIds: (string | null | undefined)[], kind: string, params: Record<string, unknown>, link: string | null = null) {
  const unique = [...new Set(userIds.filter(Boolean) as string[])];
  if (unique.length) await tx.insert(notifications).values(unique.map((userId) => ({ userId, kind, params, link })));
}

/** Copies a template into a checklist for one person, resolving assignees and due dates. */
export async function startChecklist(tx: Exec, input: { personId: string; template: Template; referenceDate: string; actorUserId: string | null }) {
  const tasks = await tx.select().from(checklistTemplateTasks).where(eq(checklistTemplateTasks.templateId, input.template.id)).orderBy(asc(checklistTemplateTasks.position));
  const emp = await currentEmployment(tx, input.personId, input.referenceDate);
  const managerUser = await userOfPerson(tx, emp?.supervisorPersonId);
  const employeeUser = await userOfPerson(tx, input.personId);
  const [cl] = await tx
    .insert(checklists)
    .values({ personId: input.personId, templateId: input.template.id, kind: input.template.kind, name: input.template.name, referenceDate: input.referenceDate, createdByUserId: input.actorUserId })
    .returning();
  const rows = [];
  for (const [i, t] of tasks.entries()) {
    const assigneeUserId = t.assignee === 'manager' ? managerUser : t.assignee === 'employee' ? employeeUser : t.assignee === 'person' ? await userOfPerson(tx, t.assigneePersonId) : null;
    rows.push({ checklistId: cl.id, title: t.title, description: t.description, assigneeRole: t.assignee, assigneeUserId, dueDate: addDays(input.referenceDate, t.offsetDays), position: i });
  }
  if (rows.length) await tx.insert(checklistTasks).values(rows);
  // One notification per assignee instead of one per task.
  const name = await personName(tx, input.personId);
  const counts = new Map<string, number>();
  for (const r of rows) if (r.assigneeUserId) counts.set(r.assigneeUserId, (counts.get(r.assigneeUserId) ?? 0) + 1);
  for (const [userId, count] of counts) await notify(tx, [userId], 'task_assigned', { count, personName: name, checklistName: cl.name, kind: cl.kind }, `/tasks?person=${input.personId}`);
  if (rows.some((r) => !r.assigneeUserId)) await notify(tx, await usersWithGlobal(tx, 'checklists.manage'), 'checklist_started', { personName: name, checklistName: cl.name, kind: cl.kind }, `/tasks?person=${input.personId}`);
  await audit(tx, input.actorUserId, 'person', input.personId, 'checklist_start', { checklistId: cl.id, name: cl.name });
  return cl;
}

/** The most specific active auto-start template for an employment (unit > workplace > everyone). */
async function autoTemplateFor(tx: Exec, kind: string, employmentId: string): Promise<Template | null> {
  const [emp] = await tx.select().from(employments).where(eq(employments.id, employmentId));
  if (!emp) return null;
  const units = (await tx.select().from(employmentOrgUnits).where(eq(employmentOrgUnits.employmentId, emp.id))).map((u) => u.orgUnitId);
  const candidates = (await tx.select().from(checklistTemplates).where(and(eq(checklistTemplates.kind, kind), eq(checklistTemplates.autoStart, true), eq(checklistTemplates.active, true)))).filter(
    (t) => (!t.orgUnitId || units.includes(t.orgUnitId)) && (!t.workplaceId || t.workplaceId === emp.workplaceId),
  );
  const score = (t: Template) => (t.orgUnitId ? 2 : 0) + (t.workplaceId ? 1 : 0);
  return candidates.sort((a, b) => score(b) - score(a))[0] ?? null;
}

export const workflowModule: OpenPersModule = {
  name: 'workflow',

  async seed(tx) {
    for (const t of DEFAULT_TEMPLATES) {
      const [tpl] = await tx.insert(checklistTemplates).values({ name: t.name, kind: t.kind, autoStart: true }).returning();
      await tx.insert(checklistTemplateTasks).values(t.tasks.map((task, i) => ({ templateId: tpl.id, title: task.title, assignee: task.assignee, offsetDays: task.offsetDays, position: i })));
    }
  },

  async upgrade(ctx) {
    const [c] = await ctx.db.select({ id: company.id }).from(company).limit(1);
    const [t] = await ctx.db.select({ id: checklistTemplates.id }).from(checklistTemplates).limit(1);
    if (c && !t) await ctx.db.transaction((tx) => this.seed!(tx, ctx, { region: '', adminUserId: '', adminPersonId: '' }));
  },

  register(app, ctx: AppContext) {
    const { db, authz } = ctx;
    const route = makeRoute(app, ctx.registry);

    // ---------- automation via domain events ----------
    onEvent('person.created', async (tx, p) => {
      const emp = (await tx.select().from(employments).where(eq(employments.id, p.employmentId as string)))[0];
      if (!emp || emp.startDate < addDays(today(), -AUTO_ONBOARDING_MAX_DAYS_AGO)) return;
      const tpl = await autoTemplateFor(tx, 'onboarding', emp.id);
      if (tpl) await startChecklist(tx, { personId: emp.personId, template: tpl, referenceDate: emp.startDate, actorUserId: null });
    });

    onEvent('employment.updated', async (tx, p) => {
      const endDate = (p.changes as Record<string, unknown> | undefined)?.endDate as string | null | undefined;
      if (!endDate) return;
      const [emp] = await tx.select().from(employments).where(eq(employments.id, p.employmentId as string));
      if (!emp || endDate < today()) return;
      const [existing] = await tx.select({ id: checklists.id }).from(checklists).where(and(eq(checklists.personId, emp.personId), eq(checklists.kind, 'offboarding'), eq(checklists.status, 'open')));
      if (existing) return;
      const tpl = await autoTemplateFor(tx, 'offboarding', emp.id);
      if (tpl) await startChecklist(tx, { personId: emp.personId, template: tpl, referenceDate: endDate, actorUserId: null });
    });

    onEvent('absence.requested', async (tx, p) => {
      const personId = p.personId as string;
      const emp = await currentEmployment(tx, personId, (p.startDate as string) ?? today());
      const supUser = await userOfPerson(tx, emp?.supervisorPersonId);
      const approvers = supUser && (await userHasPermission(tx, supUser, 'absence.approve')) ? [supUser] : await usersWithGlobal(tx, 'absence.approve');
      const requester = await userOfPerson(tx, personId);
      await notify(tx, approvers.filter((u) => u !== requester), 'absence_requested', { personName: await personName(tx, personId), startDate: p.startDate, endDate: p.endDate }, '/absences');
    });

    for (const decision of ['approved', 'rejected'] as const) {
      onEvent(`absence.${decision}`, async (tx, p) => {
        await notify(tx, [await userOfPerson(tx, p.personId as string)], `absence_${decision}`, { startDate: p.startDate, endDate: p.endDate }, '/absences');
      });
    }

    onEvent('application.created', async (tx, p) => {
      const team = await tx.select({ userId: hiringTeamMembers.userId }).from(hiringTeamMembers).where(eq(hiringTeamMembers.jobId, p.jobId as string));
      const [a] = await tx.select({ jobId: applications.jobId }).from(applications).where(eq(applications.id, p.applicationId as string));
      await notify(tx, team.map((t) => t.userId), 'application_received', {}, a ? `/recruiting/jobs/${a.jobId}` : '/recruiting');
    });

    // ---------- daily reminder for overdue tasks (once per task) ----------
    ctx.maintenance.push(async (c) => {
      const due = await c.db.select().from(checklistTasks).where(and(isNull(checklistTasks.doneAt), isNull(checklistTasks.remindedAt), lt(checklistTasks.dueDate, today())));
      for (const t of due) {
        if (!t.assigneeUserId) continue;
        await c.db.transaction(async (tx) => {
          const [cl] = await tx.select().from(checklists).where(eq(checklists.id, t.checklistId));
          await notify(tx, [t.assigneeUserId], 'task_overdue', { taskTitle: t.title, dueDate: t.dueDate, personName: cl ? await personName(tx, cl.personId) : '' }, '/tasks');
          await tx.update(checklistTasks).set({ remindedAt: new Date() }).where(eq(checklistTasks.id, t.id));
        });
      }
    });

    // ---------- templates ----------
    async function templateView(t: Template) {
      const tasks = await db.select().from(checklistTemplateTasks).where(eq(checklistTemplateTasks.templateId, t.id)).orderBy(asc(checklistTemplateTasks.position));
      return { ...t, tasks };
    }
    async function replaceTasks(tx: Exec, templateId: string, tasks: z.infer<typeof taskInput>[]) {
      await tx.delete(checklistTemplateTasks).where(eq(checklistTemplateTasks.templateId, templateId));
      for (const t of tasks) if (t.assignee === 'person' && !t.assigneePersonId) throw unprocessable('Assignee missing', [{ path: 'tasks', message: 'Pick a person for tasks assigned to a specific person' }]);
      if (tasks.length) await tx.insert(checklistTemplateTasks).values(tasks.map((t, i) => ({ templateId, title: t.title, description: t.description ?? null, assignee: t.assignee, assigneePersonId: t.assigneePersonId ?? null, offsetDays: t.offsetDays, position: i })));
    }

    route({ method: 'GET', url: '/api/v1/checklist-templates', perm: 'checklists.manage', tag: 'workflow', summary: 'On-/offboarding templates with tasks' }, async () => {
      const list = await db.select().from(checklistTemplates).orderBy(asc(checklistTemplates.kind), asc(checklistTemplates.name));
      return { items: await Promise.all(list.map(templateView)) };
    });
    route({ method: 'POST', url: '/api/v1/checklist-templates', perm: 'checklists.manage', tag: 'workflow', summary: 'Create a template', body: templateBody }, async ({ user, body }, reply) => {
      const { tasks, ...data } = body;
      const tpl = await db.transaction(async (tx) => {
        const [t] = await tx.insert(checklistTemplates).values({ ...data, orgUnitId: data.orgUnitId ?? null, workplaceId: data.workplaceId ?? null }).returning();
        await replaceTasks(tx, t.id, tasks);
        await audit(tx, user.userId, 'checklist_template', t.id, 'create', { name: t.name });
        return t;
      });
      reply.code(201);
      return templateView(tpl);
    });
    route({ method: 'PATCH', url: '/api/v1/checklist-templates/:id', perm: 'checklists.manage', tag: 'workflow', summary: 'Update a template (tasks are replaced when given)', body: templateBody.partial() }, async ({ user, body, params }) => {
      const { tasks, ...data } = body;
      const tpl = await db.transaction(async (tx) => {
        const [t] = Object.keys(data).length ? await tx.update(checklistTemplates).set(data).where(eq(checklistTemplates.id, params.id)).returning() : await tx.select().from(checklistTemplates).where(eq(checklistTemplates.id, params.id));
        if (!t) throw notFound();
        if (tasks) await replaceTasks(tx, t.id, tasks);
        await audit(tx, user.userId, 'checklist_template', t.id, 'update', { name: t.name });
        return t;
      });
      return templateView(tpl);
    });
    route({ method: 'DELETE', url: '/api/v1/checklist-templates/:id', perm: 'checklists.manage', tag: 'workflow', summary: 'Delete a template (running checklists stay)' }, async ({ user, params }) => {
      const res = await db.delete(checklistTemplates).where(eq(checklistTemplates.id, params.id)).returning();
      if (!res.length) throw notFound();
      await audit(db, user.userId, 'checklist_template', params.id, 'delete');
    });

    // ---------- checklists ----------
    async function checklistView(cl: typeof checklists.$inferSelect) {
      const tasks = await db.select().from(checklistTasks).where(eq(checklistTasks.checklistId, cl.id)).orderBy(asc(checklistTasks.position));
      return { ...cl, tasks, progress: { done: tasks.filter((t) => t.doneAt).length, total: tasks.length } };
    }

    route({ method: 'GET', url: '/api/v1/persons/:id/checklists', tag: 'workflow', summary: 'On-/offboarding checklists of a person' }, async ({ user, params }) => {
      const allowed = authz.has(user, 'checklists.manage') || user.personId === params.id || (await authz.can(user, 'people.read', params.id));
      if (!allowed) throw forbidden();
      const list = await db.select().from(checklists).where(eq(checklists.personId, params.id)).orderBy(desc(checklists.createdAt));
      return { items: await Promise.all(list.map(checklistView)) };
    });

    route(
      { method: 'POST', url: '/api/v1/persons/:id/checklists', perm: 'checklists.manage', tag: 'workflow', summary: 'Start a checklist from a template', body: z.object({ templateId: z.string().uuid(), referenceDate: isoDateSchema.optional() }) },
      async ({ user, params, body }, reply) => {
        const [tpl] = await db.select().from(checklistTemplates).where(eq(checklistTemplates.id, body.templateId));
        if (!tpl) throw notFound('Template not found');
        const emp = await currentEmployment(db, params.id, today());
        if (!emp) throw notFound('Person has no employment');
        const referenceDate = body.referenceDate ?? (tpl.kind === 'onboarding' ? emp.startDate : (emp.endDate ?? today()));
        const cl = await db.transaction((tx) => startChecklist(tx, { personId: params.id, template: tpl, referenceDate, actorUserId: user.userId }));
        reply.code(201);
        return checklistView(cl);
      },
    );

    route({ method: 'DELETE', url: '/api/v1/checklists/:id', perm: 'checklists.manage', tag: 'workflow', summary: 'Cancel a checklist' }, async ({ user, params }) => {
      const res = await db.delete(checklists).where(eq(checklists.id, params.id)).returning();
      if (!res.length) throw notFound();
      await audit(db, user.userId, 'person', res[0].personId, 'checklist_delete', { checklistId: params.id });
    });

    route({ method: 'GET', url: '/api/v1/checklists', perm: 'checklists.manage', tag: 'workflow', summary: 'All checklists with progress', query: z.object({ status: z.enum(['open', 'done']).optional(), kind: z.enum(['onboarding', 'offboarding']).optional() }) }, async ({ query }) => {
      const conds = [query.status ? eq(checklists.status, query.status) : undefined, query.kind ? eq(checklists.kind, query.kind) : undefined].filter(Boolean) as any[];
      const list = await db.select().from(checklists).where(conds.length ? and(...conds) : undefined).orderBy(asc(checklists.referenceDate));
      const items = [];
      for (const cl of list) {
        const v = await checklistView(cl);
        items.push({ ...v, personName: await personName(db, cl.personId), overdue: v.tasks.filter((t) => !t.doneAt && t.dueDate < today()).length });
      }
      return { items };
    });

    route({ method: 'PATCH', url: '/api/v1/checklist-tasks/:id', tag: 'workflow', summary: 'Mark a task done or open again', body: z.object({ done: z.boolean() }) }, async ({ user, params, body }) => {
      const [t] = await db.select().from(checklistTasks).where(eq(checklistTasks.id, params.id));
      if (!t) throw notFound();
      if (t.assigneeUserId !== user.userId && !authz.has(user, 'checklists.manage')) throw forbidden('Only the assignee or HR can change this task');
      const row = await db.transaction(async (tx) => {
        const [r] = await tx.update(checklistTasks).set(body.done ? { doneAt: new Date(), doneByUserId: user.userId } : { doneAt: null, doneByUserId: null }).where(eq(checklistTasks.id, t.id)).returning();
        const open = await tx.select({ id: checklistTasks.id }).from(checklistTasks).where(and(eq(checklistTasks.checklistId, t.checklistId), isNull(checklistTasks.doneAt)));
        await tx.update(checklists).set(open.length ? { status: 'open', completedAt: null } : { status: 'done', completedAt: new Date() }).where(eq(checklists.id, t.checklistId));
        return r;
      });
      return row;
    });

    route({ method: 'GET', url: '/api/v1/tasks/mine', tag: 'workflow', summary: 'Open tasks of the caller (incl. unassigned HR tasks for HR)' }, async ({ user }) => {
      const hr = authz.has(user, 'checklists.manage');
      const rows = await db
        .select({ t: checklistTasks, cl: checklists })
        .from(checklistTasks)
        .innerJoin(checklists, eq(checklists.id, checklistTasks.checklistId))
        .where(and(isNull(checklistTasks.doneAt), hr ? or(eq(checklistTasks.assigneeUserId, user.userId), isNull(checklistTasks.assigneeUserId)) : eq(checklistTasks.assigneeUserId, user.userId)))
        .orderBy(asc(checklistTasks.dueDate));
      const names = new Map<string, string>();
      const items = [];
      for (const { t, cl } of rows) {
        if (!names.has(cl.personId)) names.set(cl.personId, await personName(db, cl.personId));
        items.push({ ...t, checklistName: cl.name, kind: cl.kind, personId: cl.personId, personName: names.get(cl.personId) });
      }
      return { items };
    });

    // ---------- notifications ----------
    route({ method: 'GET', url: '/api/v1/notifications', tag: 'workflow', summary: 'Latest notifications of the caller', query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) }, async ({ user, query }) => ({
      items: await db.select().from(notifications).where(eq(notifications.userId, user.userId)).orderBy(desc(notifications.createdAt)).limit(query.limit),
    }));
    route({ method: 'GET', url: '/api/v1/notifications/count', tag: 'workflow', summary: 'Number of unread notifications' }, async ({ user }) => {
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(notifications).where(and(eq(notifications.userId, user.userId), isNull(notifications.readAt)));
      return { unread: n };
    });
    route({ method: 'POST', url: '/api/v1/notifications/read', tag: 'workflow', summary: 'Mark notifications as read', body: z.object({ ids: z.array(z.string().uuid()).optional(), all: z.boolean().optional() }) }, async ({ user, body }, reply) => {
      const scope = body.all ? undefined : inArray(notifications.id, body.ids?.length ? body.ids : ['00000000-0000-0000-0000-000000000000']);
      await db.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.userId, user.userId), isNull(notifications.readAt), scope));
      reply.code(204);
    });
  },
};

