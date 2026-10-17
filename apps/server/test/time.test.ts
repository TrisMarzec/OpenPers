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

  it('does not count the unfinished current day in the default balance', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const emp = await newEmployee('Neu', today);
    const bal = await emp.client.get(`/api/v1/persons/${emp.personId}/time-balance`);
    expect(bal.status).toBe(200);
    expect(bal.body.balanceMinutes).toBe(0);
  });

  it('starts the default balance with the first tracked day, not the hire date', async () => {
    const emp = await newEmployee('Lena', '2025-01-01');
    const none = await emp.client.get(`/api/v1/persons/${emp.personId}/time-balance`);
    expect(none.body).toMatchObject({ balanceMinutes: 0, trackingSince: null });
    // Mon 2026-06-15, 8h scheduled: the months before tracking started must not count as missing time.
    await emp.client.post('/api/v1/attendance', entry('2026-06-15', '08:00', '16:30'));
    const bal = await emp.client.get(`/api/v1/persons/${emp.personId}/time-balance?to=2026-06-15`);
    expect(bal.body).toMatchObject({ from: '2026-06-15', trackingSince: '2026-06-15', targetMinutes: 480, workedMinutes: 510, balanceMinutes: 30 });
  });

  it('does not count days before the first tracked day as missing in the month view', async () => {
    const emp = await newEmployee('Mona', '2025-01-01');
    await emp.client.post('/api/v1/attendance', entry('2026-06-17', '08:00', '16:00'));
    const month = (await emp.client.get('/api/v1/attendance/month?month=2026-06')).body;
    expect(month.trackingSince).toBe('2026-06-17');
    const before = month.days.find((d: any) => d.date === '2026-06-16');
    expect(before).toMatchObject({ targetMinutes: 480, tracked: false, diffMinutes: 0 });
    expect(month.days.find((d: any) => d.date === '2026-06-17')).toMatchObject({ tracked: true, workedMinutes: 480, diffMinutes: 0 });
    expect(month.days.find((d: any) => d.date === '2026-06-18')).toMatchObject({ tracked: true, diffMinutes: -480 });
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

  describe('monthly attendance list', () => {
    it('saves a day inline and returns it in the month view with target, break and difference', async () => {
      const emp = await newEmployee('Lisa');
      const put = await emp.client.put('/api/v1/attendance/day', { date: '2026-06-08', start: '08:00', end: '17:00', breakMinutes: 30, location: 'remote' });
      expect(put.status).toBe(200);
      const month = await emp.client.get(`/api/v1/attendance/month?personId=${emp.personId}&month=2026-06`);
      expect(month.status).toBe(200);
      expect(month.body.days).toHaveLength(30);
      expect(month.body.days.find((d: any) => d.date === '2026-06-08')).toMatchObject({
        start: '08:00',
        end: '17:00',
        breakMinutes: 30,
        workedMinutes: 510,
        targetMinutes: 480,
        diffMinutes: 30,
        location: 'remote',
        periodCount: 1,
        warnings: [],
      });
      expect(month.body.totals.workedMinutes).toBe(510);
    });

    it('replaces clocked periods of the day with a single entry', async () => {
      const emp = await newEmployee('Rudi');
      await emp.client.post('/api/v1/attendance', entry('2026-06-09', '08:00', '12:00'));
      await emp.client.post('/api/v1/attendance', entry('2026-06-09', '12:30', '16:30'));
      let day = (await emp.client.get(`/api/v1/attendance/month?personId=${emp.personId}&month=2026-06`)).body.days.find((d: any) => d.date === '2026-06-09');
      expect(day).toMatchObject({ start: '08:00', end: '16:30', breakMinutes: 30, workedMinutes: 480, periodCount: 2 });
      await emp.client.put('/api/v1/attendance/day', { date: '2026-06-09', start: '09:00', end: '17:00', breakMinutes: 30 });
      day = (await emp.client.get(`/api/v1/attendance/month?personId=${emp.personId}&month=2026-06`)).body.days.find((d: any) => d.date === '2026-06-09');
      expect(day).toMatchObject({ start: '09:00', end: '17:00', workedMinutes: 450, periodCount: 1 });
    });

    it('marks holidays, weekends and absences with reduced targets', async () => {
      const emp = await newEmployee('Hilde');
      const types = await admin.get('/api/v1/absence-types');
      const vac = types.body.items.find((x: any) => x.category === 'vacation').id;
      await admin.post('/api/v1/absence-periods', { personId: emp.personId, typeId: vac, startDate: '2026-05-11', endDate: '2026-05-11', endHalf: false, startHalf: true });
      const days = (await emp.client.get(`/api/v1/attendance/month?personId=${emp.personId}&month=2026-05`)).body.days;
      expect(days.find((d: any) => d.date === '2026-05-14')).toMatchObject({ holiday: 'Christi Himmelfahrt', targetMinutes: 0 });
      expect(days.find((d: any) => d.date === '2026-05-16')).toMatchObject({ weekend: true, targetMinutes: 0 });
      expect(days.find((d: any) => d.date === '2026-05-11')).toMatchObject({ targetMinutes: 240, absence: { typeName: 'Urlaub', fraction: 0.5 } });
    });

    it('does not count future days as missing hours in the month difference', async () => {
      const emp = await newEmployee('Zukunft');
      const res = await emp.client.get(`/api/v1/attendance/month?personId=${emp.personId}&month=2099-03`);
      expect(res.body.totals.targetMinutes).toBeGreaterThan(0);
      expect(res.body.totals.diffMinutes).toBe(0);
    });

    it('auto-deducts the statutory break when configured', async () => {
      await admin.patch('/api/v1/time-settings', { autoDeductBreaks: true });
      const emp = await newEmployee('Auto');
      const put = await emp.client.put('/api/v1/attendance/day', { date: '2026-06-10', start: '08:00', end: '17:00', breakMinutes: 0 });
      expect(put.body).toMatchObject({ breakAdjusted: true, breakMinutes: 30 });
      await admin.patch('/api/v1/time-settings', { autoDeductBreaks: false });
    });

    it('supports overnight shifts, clearing a day and rejects invalid input', async () => {
      const emp = await newEmployee('Nacht');
      const night = await emp.client.put('/api/v1/attendance/day', { date: '2026-06-11', start: '22:00', end: '06:00', breakMinutes: 30 });
      expect(night.status).toBe(200);
      expect(night.body.workedMinutes).toBe(450);
      expect((await emp.client.put('/api/v1/attendance/day', { date: '2026-06-12', start: '25:00', end: '06:00', breakMinutes: 0 })).status).toBe(422);
      expect((await emp.client.put('/api/v1/attendance/day', { date: '2026-06-12', start: '08:00', end: '09:00', breakMinutes: 90 })).status).toBe(422);
      expect((await emp.client.delete(`/api/v1/attendance/day?date=2026-06-11`)).status).toBe(204);
      const day = (await emp.client.get(`/api/v1/attendance/month?personId=${emp.personId}&month=2026-06`)).body.days.find((d: any) => d.date === '2026-06-11');
      expect(day).toMatchObject({ start: null, workedMinutes: 0, periodCount: 0 });
    });

    it('enforces scopes on the day endpoint', async () => {
      const emp = await newEmployee('Ernst');
      const other = await newEmployee('Olga');
      expect((await emp.client.put('/api/v1/attendance/day', { personId: other.personId, date: '2026-06-08', start: '08:00', end: '12:00', breakMinutes: 0 })).status).toBe(403);
      expect((await emp.client.get(`/api/v1/attendance/month?personId=${other.personId}&month=2026-06`)).status).toBe(403);
    });

    it('subtracts recorded breaks in the overtime balance', async () => {
      const emp = await newEmployee('Bilanz', '2026-06-15');
      await emp.client.put('/api/v1/attendance/day', { date: '2026-06-15', start: '08:00', end: '17:00', breakMinutes: 60 });
      const bal = await emp.client.get(`/api/v1/persons/${emp.personId}/time-balance?from=2026-06-15&to=2026-06-15`);
      expect(bal.body).toMatchObject({ workedMinutes: 480, balanceMinutes: 0 });
    });
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
