import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { addDays } from '@openpers/shared';
import { createEmployee, createTestApp, setupCompany, type Client } from './helpers';
import { runMaintenance } from '../src/lib/worker';

const today = () => new Date().toISOString().slice(0, 10);

describe('onboarding, offboarding, tasks and notifications', () => {
  let app: FastifyInstance;
  let admin: Client;
  let mgr: Awaited<ReturnType<typeof createEmployee>>;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await setupCompany(app);
    mgr = await createEmployee(app, admin, { firstName: 'Mona', role: 'manager' });
  });
  afterAll(() => app.close());

  it('seeds default onboarding and offboarding templates', async () => {
    const res = await admin.get('/api/v1/checklist-templates');
    const kinds = res.body.items.map((t: any) => t.kind);
    expect(kinds).toEqual(expect.arrayContaining(['onboarding', 'offboarding']));
    const onboarding = res.body.items.find((t: any) => t.kind === 'onboarding');
    expect(onboarding.tasks.length).toBeGreaterThanOrEqual(4);
    expect(onboarding.tasks.map((t: any) => t.assignee)).toEqual(expect.arrayContaining(['hr', 'manager', 'employee']));
  });

  it('starts onboarding automatically for new hires and assigns tasks with due dates', async () => {
    const start = addDays(today(), 14);
    const emp = await createEmployee(app, admin, { firstName: 'Neo', supervisorPersonId: mgr.personId, startDate: start });
    const lists = await admin.get(`/api/v1/persons/${emp.personId}/checklists`);
    expect(lists.body.items).toHaveLength(1);
    const cl = lists.body.items[0];
    expect(cl).toMatchObject({ kind: 'onboarding', referenceDate: start, status: 'open' });
    const managerTask = cl.tasks.find((t: any) => t.assigneeRole === 'manager');
    expect(managerTask.assigneeUserId).toBe(mgr.userId);
    expect(managerTask.dueDate).toBeTruthy();

    const notes = await mgr.client.get('/api/v1/notifications');
    expect(notes.body.items.some((n: any) => n.kind === 'task_assigned' && n.link.includes(emp.personId))).toBe(true);

    const mine = await mgr.client.get('/api/v1/tasks/mine');
    expect(mine.body.items.map((t: any) => t.id)).toContain(managerTask.id);
  });

  it('does not start onboarding for people who joined long ago (imports)', async () => {
    const emp = await createEmployee(app, admin, { firstName: 'Alt', startDate: '2020-01-01' });
    expect((await admin.get(`/api/v1/persons/${emp.personId}/checklists`)).body.items).toHaveLength(0);
  });

  it('lets assignees and HR complete tasks and closes the checklist when all are done', async () => {
    const emp = await createEmployee(app, admin, { firstName: 'Tara', supervisorPersonId: mgr.personId, startDate: addDays(today(), 7) });
    const outsider = await createEmployee(app, admin, { firstName: 'Ole' });
    const cl = (await admin.get(`/api/v1/persons/${emp.personId}/checklists`)).body.items[0];
    const managerTask = cl.tasks.find((t: any) => t.assigneeRole === 'manager');
    expect((await outsider.client.patch(`/api/v1/checklist-tasks/${managerTask.id}`, { done: true })).status).toBe(403);
    const done = await mgr.client.patch(`/api/v1/checklist-tasks/${managerTask.id}`, { done: true });
    expect(done.status).toBe(200);
    expect(done.body.doneAt).toBeTruthy();
    for (const t of cl.tasks.filter((x: any) => x.id !== managerTask.id)) {
      expect((await admin.patch(`/api/v1/checklist-tasks/${t.id}`, { done: true })).status).toBe(200);
    }
    const after = (await admin.get(`/api/v1/persons/${emp.personId}/checklists`)).body.items[0];
    expect(after.status).toBe('done');
    const overview = await admin.get('/api/v1/checklists?status=done');
    expect(overview.body.items.find((c: any) => c.id === cl.id)).toMatchObject({ progress: { done: cl.tasks.length, total: cl.tasks.length } });
  });

  it('starts offboarding when an end date is set', async () => {
    const emp = await createEmployee(app, admin, { firstName: 'Gehtbald', supervisorPersonId: mgr.personId, startDate: '2021-01-01' });
    const p = await admin.get(`/api/v1/persons/${emp.personId}`);
    const end = addDays(today(), 30);
    await admin.patch(`/api/v1/persons/${emp.personId}/employments/${p.body.employments[0].id}`, { endDate: end });
    const lists = (await admin.get(`/api/v1/persons/${emp.personId}/checklists`)).body.items;
    expect(lists.map((c: any) => c.kind)).toContain('offboarding');
    expect(lists.find((c: any) => c.kind === 'offboarding').referenceDate).toBe(end);
  });

  it('manages custom templates and starts them manually', async () => {
    const tpl = await admin.post('/api/v1/checklist-templates', {
      name: 'Onboarding Vertrieb',
      kind: 'onboarding',
      tasks: [
        { title: 'CRM-Zugang anlegen', assignee: 'hr', offsetDays: -3 },
        { title: 'Kundentermine mitnehmen', assignee: 'manager', offsetDays: 10 },
      ],
    });
    expect(tpl.status).toBe(201);
    expect(tpl.body.tasks).toHaveLength(2);
    const emp = await createEmployee(app, admin, { firstName: 'Vera', supervisorPersonId: mgr.personId });
    const started = await admin.post(`/api/v1/persons/${emp.personId}/checklists`, { templateId: tpl.body.id, referenceDate: '2026-11-02' });
    expect(started.status).toBe(201);
    expect(started.body.tasks.map((t: any) => t.dueDate)).toEqual(['2026-10-30', '2026-11-12']);
    const emp2 = await createEmployee(app, admin, { firstName: 'Kein' });
    expect((await emp2.client.post('/api/v1/checklist-templates', { name: 'x', kind: 'onboarding', tasks: [] })).status).toBe(403);
    expect((await emp2.client.post(`/api/v1/persons/${emp.personId}/checklists`, { templateId: tpl.body.id })).status).toBe(403);
  });

  it('notifies approvers about absence requests and requesters about decisions', async () => {
    const emp = await createEmployee(app, admin, { firstName: 'Ulf', supervisorPersonId: mgr.personId, startDate: '2026-01-01' });
    const types = (await admin.get('/api/v1/absence-types')).body.items;
    const vac = types.find((x: any) => x.category === 'vacation').id;
    const before = (await mgr.client.get('/api/v1/notifications/count')).body.unread;
    const req = await emp.client.post('/api/v1/absence-periods', { typeId: vac, startDate: '2026-11-16', endDate: '2026-11-17' });
    expect((await mgr.client.get('/api/v1/notifications/count')).body.unread).toBe(before + 1);
    await mgr.client.post(`/api/v1/absence-periods/${req.body.id}/approve`);
    const mine = await emp.client.get('/api/v1/notifications');
    expect(mine.body.items[0]).toMatchObject({ kind: 'absence_approved' });
    expect((await emp.client.post('/api/v1/notifications/read', { all: true })).status).toBe(204);
    expect((await emp.client.get('/api/v1/notifications/count')).body.unread).toBe(0);
  });

  it('reminds assignees once about overdue tasks', async () => {
    const tpl = await admin.post('/api/v1/checklist-templates', { name: 'Kurz', kind: 'onboarding', tasks: [{ title: 'Längst fällig', assignee: 'manager', offsetDays: -10 }] });
    const emp = await createEmployee(app, admin, { firstName: 'Spaet', supervisorPersonId: mgr.personId });
    await admin.post(`/api/v1/persons/${emp.personId}/checklists`, { templateId: tpl.body.id, referenceDate: today() });
    await runMaintenance(app.ctx);
    await runMaintenance(app.ctx);
    const overdue = (await mgr.client.get('/api/v1/notifications')).body.items.filter((n: any) => n.kind === 'task_overdue' && n.params.taskTitle === 'Längst fällig');
    expect(overdue).toHaveLength(1);
  });
});
