import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { outbox } from '../src/db/schema';
import { createEmployee, createTestApp, setupCompany, type Client } from './helpers';

describe('absence', () => {
  let app: FastifyInstance;
  let admin: Client;
  let vacationId: string;
  let sickId: string;
  let mgr: Awaited<ReturnType<typeof createEmployee>>;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await setupCompany(app, 'DE-BE');
    const types = await admin.get('/api/v1/absence-types');
    vacationId = types.body.items.find((t: any) => t.category === 'vacation').id;
    sickId = types.body.items.find((t: any) => t.category === 'sick').id;
    mgr = await createEmployee(app, admin, { firstName: 'Manni', role: 'manager' });
  });
  afterAll(() => app.close());

  const newEmployee = (name: string, startDate = '2026-01-01') => createEmployee(app, admin, { firstName: name, supervisorPersonId: mgr.personId, startDate });

  it('seeds default absence types and a default vacation policy', async () => {
    const types = await admin.get('/api/v1/absence-types');
    expect(types.body.items.map((t: any) => t.name)).toEqual(expect.arrayContaining(['Urlaub', 'Krankheit']));
    const policies = await admin.get('/api/v1/absence-policies');
    expect(policies.body.items[0]).toMatchObject({ annualEntitlement: 30, isDefault: true });
  });

  it('lists public holidays incl. custom ones', async () => {
    const by = await admin.get('/api/v1/holidays?year=2026&region=DE-BY');
    expect(by.body.items.map((h: any) => h.name)).toContain('Fronleichnam');
    await admin.post('/api/v1/custom-holidays', { date: '2026-12-24', name: 'Heiligabend (Betrieb)' });
    const be = await admin.get('/api/v1/holidays?year=2026&region=DE-BE');
    expect(be.body.items.map((h: any) => h.date)).toContain('2026-12-24');
  });

  it('previews the effective days of a request', async () => {
    const emp = await newEmployee('Paula');
    const res = await emp.client.post('/api/v1/absence-periods/preview', { typeId: vacationId, startDate: '2026-03-30', endDate: '2026-04-10' });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(8);
    expect(res.body.days).toHaveLength(12);
  });

  it('runs the request → approval flow and emits events', async () => {
    const emp = await newEmployee('Anna');
    const req = await emp.client.post('/api/v1/absence-periods', { typeId: vacationId, startDate: '2026-08-03', endDate: '2026-08-07', comment: 'Sommer' });
    expect(req.status).toBe(201);
    expect(req.body.status).toBe('pending');
    expect(req.body.days).toBe(5);

    const queue = await mgr.client.get('/api/v1/absence-approvals');
    expect(queue.body.items.map((a: any) => a.id)).toContain(req.body.id);
    expect((await emp.client.post(`/api/v1/absence-periods/${req.body.id}/approve`)).status).toBe(403);

    const other = await createEmployee(app, admin, { firstName: 'Fremd', role: 'manager' });
    expect((await other.client.post(`/api/v1/absence-periods/${req.body.id}/approve`)).status).toBe(403);

    const ok = await mgr.client.post(`/api/v1/absence-periods/${req.body.id}/approve`, { comment: 'Viel Spaß' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('approved');
    const events = await app.ctx.db.select().from(outbox).where(eq(outbox.event, 'absence.approved'));
    expect(events.some((e) => (e.payload as any).absenceId === req.body.id)).toBe(true);
  });

  it('rejects overlapping requests with 409 but allows complementary half days', async () => {
    const emp = await newEmployee('Olaf');
    const first = await emp.client.post('/api/v1/absence-periods', { typeId: vacationId, startDate: '2026-09-07', endDate: '2026-09-09', endHalf: true });
    expect(first.status).toBe(201);
    const overlap = await emp.client.post('/api/v1/absence-periods', { typeId: vacationId, startDate: '2026-09-08', endDate: '2026-09-10' });
    expect(overlap.status).toBe(409);
    const afternoon = await emp.client.post('/api/v1/absence-periods', { typeId: vacationId, startDate: '2026-09-09', endDate: '2026-09-09', startHalf: true });
    expect(afternoon.status).toBe(201);
  });

  it('computes balances with pending requests and splits across year boundaries', async () => {
    const emp = await newEmployee('Berta');
    const a = await emp.client.post('/api/v1/absence-periods', { typeId: vacationId, startDate: '2026-03-30', endDate: '2026-04-10' });
    await mgr.client.post(`/api/v1/absence-periods/${a.body.id}/approve`);
    await emp.client.post('/api/v1/absence-periods', { typeId: vacationId, startDate: '2026-06-01', endDate: '2026-06-02' });
    // Mon 2026-12-28 .. Fri 2027-01-08: 4 days in 2026, Neujahr, 5 days in 2027
    const x = await emp.client.post('/api/v1/absence-periods', { typeId: vacationId, startDate: '2026-12-28', endDate: '2027-01-08' });
    expect(x.body.days).toBe(9);
    await mgr.client.post(`/api/v1/absence-periods/${x.body.id}/approve`);

    const b2026 = await emp.client.get(`/api/v1/persons/${emp.personId}/balances?year=2026`);
    const vac = b2026.body.items.find((b: any) => b.typeId === vacationId);
    expect(vac).toMatchObject({ entitlement: 30, taken: 12, pending: 2, remaining: 18, available: 16 });
    const b2027 = await emp.client.get(`/api/v1/persons/${emp.personId}/balances?year=2027`);
    expect(b2027.body.items.find((b: any) => b.typeId === vacationId).taken).toBe(5);
  });

  it('rejects requests exceeding the available balance', async () => {
    const emp = await newEmployee('Gier');
    const res = await emp.client.post('/api/v1/absence-periods', { typeId: vacationId, startDate: '2026-07-01', endDate: '2026-08-31' });
    expect(res.status).toBe(422);
  });

  it('lets HR record open-ended sick leave without approval and close it later', async () => {
    const emp = await newEmployee('Siggi');
    const sick = await admin.post('/api/v1/absence-periods', { personId: emp.personId, typeId: sickId, startDate: '2026-02-02', endDate: null });
    expect(sick.status).toBe(201);
    expect(sick.body.status).toBe('approved');
    const closed = await admin.patch(`/api/v1/absence-periods/${sick.body.id}`, { endDate: '2026-02-06' });
    expect(closed.body.endDate).toBe('2026-02-06');
    expect(closed.body.days).toBe(5);
  });

  it('does not let employees file absences for others', async () => {
    const emp = await newEmployee('Erna');
    const other = await newEmployee('Fred');
    const res = await emp.client.post('/api/v1/absence-periods', { personId: other.personId, typeId: vacationId, startDate: '2026-05-04', endDate: '2026-05-04' });
    expect(res.status).toBe(403);
    expect((await emp.client.get(`/api/v1/absence-periods?personId=${other.personId}`)).status).toBe(403);
  });

  it('shows the team calendar with generalized labels for non-visible persons', async () => {
    const emp = await newEmployee('Clara');
    const colleague = await newEmployee('Chris');
    const s = await admin.post('/api/v1/absence-periods', { personId: colleague.personId, typeId: sickId, startDate: '2026-11-02', endDate: '2026-11-03' });
    expect(s.status).toBe(201);
    const cal = await emp.client.get('/api/v1/absence-calendar?from=2026-11-01&to=2026-11-30');
    const entry = cal.body.items.find((i: any) => i.personId === colleague.personId);
    expect(entry).toBeTruthy();
    expect(entry.typeName).toBe('Abwesend');
    const mgrCal = await mgr.client.get('/api/v1/absence-calendar?from=2026-11-01&to=2026-11-30');
    expect(mgrCal.body.items.find((i: any) => i.personId === colleague.personId).typeName).toBe('Krankheit');
  });

  it('lets employees cancel their own requests, restoring the balance', async () => {
    const emp = await newEmployee('Karl');
    const r = await emp.client.post('/api/v1/absence-periods', { typeId: vacationId, startDate: '2026-10-05', endDate: '2026-10-09' });
    const c = await emp.client.post(`/api/v1/absence-periods/${r.body.id}/cancel`);
    expect(c.body.status).toBe('cancelled');
    const b = await emp.client.get(`/api/v1/persons/${emp.personId}/balances?year=2026`);
    expect(b.body.items.find((x: any) => x.typeId === vacationId).pending).toBe(0);
  });

  it('includes absences in the DSGVO export', async () => {
    const emp = await newEmployee('Dana');
    await emp.client.post('/api/v1/absence-periods', { typeId: vacationId, startDate: '2026-05-04', endDate: '2026-05-05' });
    const exp = await emp.client.get(`/api/v1/persons/${emp.personId}/export`);
    expect(exp.body.absences.periods).toHaveLength(1);
  });
});
