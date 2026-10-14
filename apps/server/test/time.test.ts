import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createEmployee, createTestApp, setupCompany, type Client } from './helpers';

describe('time tracking', () => {
  let app: FastifyInstance;
  let admin: Client;
  let mgr: Awaited<ReturnType<typeof createEmployee>>;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await setupCompany(app, 'DE-BE');
    mgr = await createEmployee(app, admin, { firstName: 'Manni', role: 'manager' });
  });
  afterAll(() => app.close());

  const newEmployee = (name: string, startDate = '2026-01-01') => createEmployee(app, admin, { firstName: name, supervisorPersonId: mgr.personId, startDate });
  const entry = (date: string, from: string, to: string, extra: Record<string, unknown> = {}) => ({ type: 'WORK', startAt: `${date}T${from}:00`, endAt: `${date}T${to}:00`, ...extra });

  it('records work periods and rejects overlaps', async () => {
    const emp = await newEmployee('Tina');
    const a = await emp.client.post('/api/v1/attendance', entry('2026-06-08', '08:00', '12:00'));
    expect(a.status).toBe(201);
    expect(a.body.status).toBe('approved');
    expect((await emp.client.post('/api/v1/attendance', entry('2026-06-08', '12:30', '16:30'))).status).toBe(201);
    expect((await emp.client.post('/api/v1/attendance', entry('2026-06-08', '11:00', '13:00'))).status).toBe(409);
    const list = await emp.client.get(`/api/v1/attendance?personId=${emp.personId}&from=2026-06-08&to=2026-06-08`);
    expect(list.body.days[0]).toMatchObject({ date: '2026-06-08', workedMinutes: 480, breakMinutes: 30, warnings: [] });
  });

  it('returns ArbZG warnings for long days without breaks', async () => {
    const emp = await newEmployee('Willi');
    const res = await emp.client.post('/api/v1/attendance', entry('2026-06-09', '08:00', '15:00'));
    expect(res.status).toBe(201);
    expect(res.body.warnings.map((w: any) => w.code)).toEqual(['BREAK_6H']);
  });

  it('validates end after start and project rules', async () => {
    const emp = await newEmployee('Vera');
    expect((await emp.client.post('/api/v1/attendance', entry('2026-06-10', '12:00', '11:00'))).status).toBe(422);
    const proj = await admin.post('/api/v1/projects', { name: 'Website Relaunch', code: 'WEB' });
    expect(proj.status).toBe(201);
    const withProject = await emp.client.post('/api/v1/attendance', entry('2026-06-10', '08:00', '10:00', { projectId: proj.body.id }));
    expect(withProject.status).toBe(201);
    const breakWithProject = await emp.client.post('/api/v1/attendance', { ...entry('2026-06-10', '10:00', '10:30', { projectId: proj.body.id }), type: 'BREAK' });
    expect(breakWithProject.status).toBe(422);
  });

  it('supports clock-in/clock-out with conflict detection', async () => {
    const emp = await newEmployee('Ulla');
    const inRes = await emp.client.post('/api/v1/attendance/clock-in');
    expect(inRes.status).toBe(201);
    expect(inRes.body.endAt).toBeNull();
    expect((await emp.client.post('/api/v1/attendance/clock-in')).status).toBe(409);
    const status = await emp.client.get('/api/v1/attendance/status');
    expect(status.body.open.id).toBe(inRes.body.id);
    const out = await emp.client.post('/api/v1/attendance/clock-out');
    expect(out.status).toBe(200);
    expect(out.body.endAt).toBeTruthy();
    expect((await emp.client.post('/api/v1/attendance/clock-out')).status).toBe(409);
  });

  it('computes the overtime balance against the schedule', async () => {
    const emp = await newEmployee('Hans', '2026-05-11');
    await emp.client.post('/api/v1/attendance', entry('2026-05-11', '08:00', '17:30', { comment: '9h + 30min' }));
    await emp.client.post('/api/v1/attendance', { type: 'BREAK', startAt: '2026-05-11T12:00:00', endAt: '2026-05-11T12:30:00' });
    // 9.5h span incl. 30min break period overlapping work is rejected – use split entries instead
    const list = await emp.client.get(`/api/v1/attendance?personId=${emp.personId}&from=2026-05-11&to=2026-05-11`);
    expect(list.body.items).toHaveLength(1);
    await emp.client.post('/api/v1/attendance', entry('2026-05-12', '08:00', '16:00'));
    const bal = await emp.client.get(`/api/v1/persons/${emp.personId}/time-balance?from=2026-05-11&to=2026-05-12`);
    expect(bal.body).toMatchObject({ targetMinutes: 960, workedMinutes: 1050, balanceMinutes: 90 });
  });

  it('requires approval when configured and lets managers approve', async () => {
    expect((await admin.patch('/api/v1/time-settings', { approvalRequired: true })).status).toBe(200);
    const emp = await newEmployee('Paul');
    const e = await emp.client.post('/api/v1/attendance', entry('2026-06-11', '08:00', '12:00'));
    expect(e.body.status).toBe('pending');
    expect((await emp.client.post(`/api/v1/attendance/${e.body.id}/approve`)).status).toBe(403);
    const ok = await mgr.client.post(`/api/v1/attendance/${e.body.id}/approve`);
    expect(ok.body.status).toBe('approved');
    await admin.patch('/api/v1/time-settings', { approvalRequired: false });
  });

  it('enforces person scopes', async () => {
    const emp = await newEmployee('Rolf');
    const other = await newEmployee('Susi');
    await other.client.post('/api/v1/attendance', entry('2026-06-12', '08:00', '12:00'));
    expect((await emp.client.post('/api/v1/attendance', { ...entry('2026-06-12', '08:00', '12:00'), personId: other.personId })).status).toBe(403);
    expect((await emp.client.get(`/api/v1/attendance?personId=${other.personId}&from=2026-06-12&to=2026-06-12`)).status).toBe(403);
    expect((await mgr.client.get(`/api/v1/attendance?personId=${other.personId}&from=2026-06-12&to=2026-06-12`)).body.items).toHaveLength(1);
  });

  it('lets employees edit and delete their own unapproved-or-recent entries', async () => {
    const emp = await newEmployee('Edda');
    const e = await emp.client.post('/api/v1/attendance', entry('2026-06-15', '08:00', '12:00'));
    const upd = await emp.client.patch(`/api/v1/attendance/${e.body.id}`, { endAt: '2026-06-15T13:00:00' });
    expect(upd.status).toBe(200);
    expect(upd.body.endAt).toBe('2026-06-15T13:00:00');
    expect((await emp.client.delete(`/api/v1/attendance/${e.body.id}`)).status).toBe(204);
  });
});
