import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createEmployee, createTestApp, setupCompany, type Client } from './helpers';

describe('people analytics', () => {
  let app: FastifyInstance;
  let admin: Client;
  let unitA: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await setupCompany(app);
    unitA = (await admin.post('/api/v1/org-units', { name: 'Technik' })).body.id;
    for (const name of ['Ana', 'Ben', 'Cem']) await createEmployee(app, admin, { firstName: name, startDate: '2025-01-01', orgUnitIds: [unitA] });
    await createEmployee(app, admin, { firstName: 'Dirk', startDate: '2026-03-10' });
    const leaver = await createEmployee(app, admin, { firstName: 'Eva', startDate: '2024-05-01' });
    const p = await admin.get(`/api/v1/persons/${leaver.personId}`);
    await admin.patch(`/api/v1/persons/${leaver.personId}/employments/${p.body.employments[0].id}`, { endDate: '2026-04-30' });
    const types = (await admin.get('/api/v1/absence-types')).body.items;
    const sick = types.find((t: any) => t.name === 'Krankheit').id;
    const ana = (await admin.get('/api/v1/persons?search=Ana')).body.items[0].id;
    await admin.post('/api/v1/absence-periods', { personId: ana, typeId: sick, startDate: '2026-02-02', endDate: '2026-02-06' });
  });
  afterAll(() => app.close());

  it('reports headcount, hires, exits and turnover per month', async () => {
    const res = await admin.get('/api/v1/analytics/overview?from=2026-01&to=2026-06');
    expect(res.status).toBe(200);
    expect(res.body.months).toHaveLength(6);
    const jan = res.body.months[0];
    const mar = res.body.months.find((m: any) => m.month === '2026-03');
    const apr = res.body.months.find((m: any) => m.month === '2026-04');
    expect(mar.hires).toBe(1);
    expect(apr.exits).toBe(1);
    // Leaving on 30 April still counts at the end of April; the drop shows in May.
    const may = res.body.months.find((m: any) => m.month === '2026-05');
    expect(apr.headcount).toBe(mar.headcount);
    expect(may.headcount).toBe(apr.headcount - 1);
    expect(jan.fte).toBeGreaterThan(0);
    expect(res.body.totals.exits).toBe(1);
    expect(res.body.totals.turnoverRate).toBeGreaterThan(0);
  });

  it('reports absence days by category and the sickness rate', async () => {
    const res = await admin.get('/api/v1/analytics/overview?from=2026-02&to=2026-02');
    const sick = res.body.absence.byCategory.find((c: any) => c.category === 'sick');
    expect(sick.days).toBe(5);
    expect(res.body.absence.targetDays).toBeGreaterThan(0);
    expect(res.body.absence.rates.sick).toBeGreaterThan(0);
  });

  it('breaks down the current workforce by unit, contract type and tenure', async () => {
    const res = await admin.get('/api/v1/analytics/overview?from=2026-01&to=2026-06');
    expect(res.body.distribution.byUnit.find((g: any) => g.key === 'Technik').count).toBe(3);
    expect(res.body.distribution.byContractType.find((g: any) => g.key === 'PERMANENT').count).toBeGreaterThanOrEqual(4);
    expect(res.body.distribution.byTenure.map((g: any) => g.key)).toEqual(expect.arrayContaining(['lt1', '1to3']));
  });

  it('filters by org unit and restricts access to analytics readers', async () => {
    const res = await admin.get(`/api/v1/analytics/overview?from=2026-01&to=2026-01&orgUnitId=${unitA}`);
    expect(res.body.months[0].headcount).toBe(3);
    const mgr = await createEmployee(app, admin, { firstName: 'Mia', role: 'manager' });
    expect((await mgr.client.get('/api/v1/analytics/overview?from=2026-01&to=2026-01')).status).toBe(403);
  });
});
