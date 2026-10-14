/**
 * Fills an empty OpenPers installation with a small demo company.
 * Usage: SECRET_KEY=… DEMO_PASSWORD=… npm run seed:demo
 * All demo accounts share DEMO_PASSWORD (min. 10 characters).
 */
import { buildApp } from './app';

const password = process.env.DEMO_PASSWORD;
if (!password || password.length < 10) {
  console.error('Set DEMO_PASSWORD (at least 10 characters) for the demo accounts.');
  process.exit(1);
}

const app = await buildApp({ startWorker: false, logger: false });
let cookie = '';

async function call<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await app.inject({ method: method as any, url: `/api/v1${url}`, headers: { 'x-requested-with': 'openpers', cookie }, ...(body !== undefined ? { payload: body as any } : {}) });
  if (res.statusCode >= 400) throw new Error(`${method} ${url} → ${res.statusCode} ${res.body}`);
  const setCookie = res.headers['set-cookie'];
  if (setCookie) cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
  return res.body ? JSON.parse(res.body) : (undefined as T);
}

const status = await call<{ needsSetup: boolean }>('GET', '/setup/status');
if (!status.needsSetup) {
  console.error('This installation is already set up – the demo seed only runs on an empty database.');
  await app.close();
  process.exit(1);
}

const year = new Date().getFullYear();
await call('POST', '/setup', { companyName: 'Musterwerk GmbH', region: 'DE-BY', locale: 'de', admin: { email: 'admin@musterwerk.example', password, firstName: 'Ada', lastName: 'Admin' } });
await call('POST', '/auth/login', { email: 'admin@musterwerk.example', password });

const munich = await call('POST', '/workplaces', { name: 'München', region: 'DE-BY', address: 'Musterstraße 1, 80331 München' });
const berlin = await call('POST', '/workplaces', { name: 'Berlin', region: 'DE-BE', address: 'Beispielweg 5, 10115 Berlin' });
const eng = await call('POST', '/org-units', { name: 'Engineering', type: 'department' });
const platform = await call('POST', '/org-units', { name: 'Platform', type: 'team', parentId: eng.id });
const people = await call('POST', '/org-units', { name: 'People & Culture', type: 'department' });

async function person(firstName: string, lastName: string, opts: { role: string; position: string; workplaceId: string; orgUnitIds: string[]; supervisorPersonId?: string; weeklyHours?: number[]; startDate?: string }) {
  const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}@musterwerk.example`;
  const p = await call('POST', '/persons', {
    firstName,
    lastName,
    email,
    employment: { startDate: opts.startDate ?? `${year - 2}-04-01`, positionTitle: opts.position, workplaceId: opts.workplaceId, orgUnitIds: opts.orgUnitIds, supervisorPersonId: opts.supervisorPersonId ?? null, weeklyHours: opts.weeklyHours ?? [8, 8, 8, 8, 8, 0, 0] },
  });
  await call('POST', '/users', { email, password, roles: [opts.role], personId: p.id });
  return p;
}

const hr = await person('Hanna', 'Hofmann', { role: 'hr', position: 'HR Business Partner', workplaceId: munich.id, orgUnitIds: [people.id] });
const lead = await person('Lars', 'Lehmann', { role: 'manager', position: 'Head of Engineering', workplaceId: munich.id, orgUnitIds: [eng.id] });
const dev1 = await person('Mia', 'Meier', { role: 'employee', position: 'Softwareentwicklerin', workplaceId: berlin.id, orgUnitIds: [platform.id], supervisorPersonId: lead.id });
const dev2 = await person('Jonas', 'Schulz', { role: 'employee', position: 'Werkstudent Frontend', workplaceId: munich.id, orgUnitIds: [platform.id], supervisorPersonId: lead.id, weeklyHours: [4, 4, 4, 4, 4, 0, 0], startDate: `${year}-02-01` });
void hr;

const types = (await call('GET', '/absence-types')).items as { id: string; category: string }[];
const vacation = types.find((t) => t.category === 'vacation')!.id;
const sick = types.find((t) => t.category === 'sick')!.id;
await call('POST', '/absence-periods', { personId: dev1.id, typeId: vacation, startDate: `${year}-08-10`, endDate: `${year}-08-21` });
await call('POST', '/absence-periods', { personId: dev2.id, typeId: sick, startDate: `${year}-03-02`, endDate: `${year}-03-04` });

await call('POST', '/projects', { name: 'Kundenportal', code: 'KP' });
const job = await call('POST', '/jobs', {
  title: 'Senior Backend Engineer (m/w/d)',
  departmentOrgUnitId: eng.id,
  workplaceId: munich.id,
  description: '## Deine Aufgaben\n- APIs entwerfen und bauen\n- Verantwortung für unsere Datenbank\n\n## Das bringst du mit\n- Erfahrung mit **TypeScript** und PostgreSQL',
  status: 'published',
});
await call('POST', '/applications', { jobId: job.id, firstName: 'Bea', lastName: 'Werber', email: 'bea.werber@example.org', channel: 'referral' });

console.log('Demo data created. Accounts (password = DEMO_PASSWORD):');
for (const e of ['admin', 'hanna.hofmann', 'lars.lehmann', 'mia.meier', 'jonas.schulz']) console.log(`  ${e}@musterwerk.example`);
await app.close();
