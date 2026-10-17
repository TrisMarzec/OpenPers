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

const ascii = (s: string) => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
const emailOf = (firstName: string, lastName: string) => `${ascii(firstName)}.${ascii(lastName)}@musterwerk.example`;

async function person(firstName: string, lastName: string, opts: { role: string; position: string; workplaceId: string; orgUnitIds: string[]; supervisorPersonId?: string; weeklyHours?: number[]; startDate?: string }) {
  const email = emailOf(firstName, lastName);
  const p = await call('POST', '/persons', {
    firstName,
    lastName,
    email,
    employment: { startDate: opts.startDate ?? `${year - 2}-04-01`, positionTitle: opts.position, workplaceId: opts.workplaceId, orgUnitIds: opts.orgUnitIds, supervisorPersonId: opts.supervisorPersonId ?? null, weeklyHours: opts.weeklyHours ?? [8, 8, 8, 8, 8, 0, 0] },
  });
  await call('POST', '/users', { email, password, roles: [opts.role], personId: p.id });
  return p;
}

// Managing director at the top so the org chart has one root.
const ceo = await person('Clara', 'Vogel', { role: 'manager', position: 'Geschäftsführerin', workplaceId: munich.id, orgUnitIds: [] });
const hr = await person('Hanna', 'Hofmann', { role: 'hr', position: 'Head of People & Culture', workplaceId: munich.id, orgUnitIds: [people.id], supervisorPersonId: ceo.id });
const lead = await person('Lars', 'Lehmann', { role: 'manager', position: 'Head of Engineering', workplaceId: munich.id, orgUnitIds: [eng.id], supervisorPersonId: ceo.id });
const dev1 = await person('Mia', 'Meier', { role: 'employee', position: 'Softwareentwicklerin', workplaceId: berlin.id, orgUnitIds: [platform.id], supervisorPersonId: lead.id });
const dev2 = await person('Jonas', 'Schulz', { role: 'employee', position: 'Werkstudent Frontend', workplaceId: munich.id, orgUnitIds: [platform.id], supervisorPersonId: lead.id, weeklyHours: [4, 4, 4, 4, 4, 0, 0], startDate: `${year}-02-01` });
void hr;

{
  const me = await call('GET', '/auth/me');
  const ada = await call('GET', `/persons/${me.personId}`);
  await call('PATCH', `/persons/${me.personId}/employments/${ada.currentEmployment.id}`, { positionTitle: 'IT-Administratorin', supervisorPersonId: hr.id, orgUnitIds: [people.id] });
}

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

// ---------- A fuller company for trying things out ----------
const sales = await call('POST', '/org-units', { name: 'Sales', type: 'department' });
const sophie = await person('Sophie', 'Wagner', { role: 'employee', position: 'Softwareentwicklerin', workplaceId: berlin.id, orgUnitIds: [platform.id], supervisorPersonId: lead.id });
const tim = await person('Tim', 'Becker', { role: 'employee', position: 'DevOps Engineer', workplaceId: munich.id, orgUnitIds: [platform.id], supervisorPersonId: lead.id });
const elif = await person('Elif', 'Yilmaz', { role: 'employee', position: 'Product Designerin', workplaceId: berlin.id, orgUnitIds: [eng.id], supervisorPersonId: lead.id, weeklyHours: [8, 8, 8, 8, 0, 0, 0] });
const nora = await person('Nora', 'Krüger', { role: 'manager', position: 'Head of Sales', workplaceId: munich.id, orgUnitIds: [sales.id], supervisorPersonId: ceo.id });
const felix = await person('Felix', 'Braun', { role: 'employee', position: 'Account Executive', workplaceId: munich.id, orgUnitIds: [sales.id], supervisorPersonId: nora.id });
const paul = await person('Paul', 'Neumann', { role: 'employee', position: 'Sales Development', workplaceId: berlin.id, orgUnitIds: [sales.id], supervisorPersonId: nora.id });
// Starts next month: the default onboarding checklist is created automatically.
const nextMonth = new Date(Date.UTC(year, new Date().getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
await person('Lea', 'Fischer', { role: 'employee', position: 'Softwareentwicklerin', workplaceId: berlin.id, orgUnitIds: [platform.id], supervisorPersonId: lead.id, startDate: nextMonth });

// Two weeks of time entries (lunch break between the two periods).
const iso = (d: Date) => d.toISOString().slice(0, 10);
for (let back = 14; back >= 1; back--) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - back);
  if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
  for (const [i, p] of [dev1, sophie, tim].entries()) {
    const start = ['08:30', '09:00', '07:45'][i];
    const end = back % 3 === i ? '18:15' : ['17:00', '17:30', '16:30'][i];
    await call('POST', '/attendance', { personId: p.id, startAt: `${iso(d)}T${start}:00`, endAt: `${iso(d)}T12:30:00` });
    await call('POST', '/attendance', { personId: p.id, startAt: `${iso(d)}T13:00:00`, endAt: `${iso(d)}T${end}:00` });
  }
}
await call('POST', '/absence-periods', { personId: elif.id, typeId: vacation, startDate: iso(new Date(Date.now() + 9 * 864e5)), endDate: iso(new Date(Date.now() + 16 * 864e5)) });

// Company logo (inline SVG).
{
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 48"><rect y="6" width="36" height="36" rx="9" fill="#2340c8"/><path d="M10 31 18 16l8 15Z" fill="#fff"/><text x="46" y="33" font-family="Arial,sans-serif" font-size="24" font-weight="700" fill="#8a94a6">Musterwerk</text></svg>';
  const boundary = 'openpersdemo';
  const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="logo.svg"\r\nContent-Type: image/svg+xml\r\n\r\n${svg}\r\n--${boundary}--\r\n`;
  await app.inject({ method: 'PUT', url: '/api/v1/company/logo', payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-requested-with': 'openpers', cookie } });
}

// Review cycle for the platform team with self, manager and peer reviews.
const cycle = await call('POST', '/review-cycles', {
  name: `Mitarbeitergespräche ${year}`,
  periodStart: `${year}-01-01`,
  periodEnd: `${year}-12-31`,
  selfReview: true,
  managerReview: true,
  peerReview: true,
  participantPersonIds: [dev1.id, sophie.id, tim.id],
  questions: [
    { id: 'q1', type: 'rating', text: 'Wie gut wurden die Ziele im Zeitraum erreicht?', required: true },
    { id: 'q2', type: 'text', text: 'Was lief besonders gut?', required: true },
    { id: 'q3', type: 'text', text: 'Wo siehst du Entwicklungspotenzial?', required: false },
  ],
});
await call('POST', `/review-cycles/${cycle.id}/start`);
await call('POST', `/review-cycles/${cycle.id}/peers`, { revieweeId: dev1.id, reviewerPersonIds: [sophie.id, tim.id] });

const adminCookie = cookie;
const as = async (first: string, last: string) => call('POST', '/auth/login', { email: emailOf(first, last), password });
const submit = async (revieweeId: string, type: string, answers: Record<string, unknown>) => {
  const r = (await call('GET', '/reviews/mine')).items.find((x: any) => x.revieweeId === revieweeId && x.type === type);
  await call('PUT', `/reviews/${r.id}`, { answers, submit: true });
};
await as('Mia', 'Meier');
await submit(dev1.id, 'self', { q1: 4, q2: 'Kundenportal termingerecht live gebracht.', q3: 'Mehr Verantwortung im Architektur-Review.' });
await call('POST', `/persons/${dev1.id}/goals`, { title: 'AWS Solutions Architect Zertifizierung', dueDate: `${year}-12-31` });
await call('POST', `/persons/${sophie.id}/feedback`, { kind: 'praise', text: 'Danke für die schnelle Hilfe beim Release am Freitag!' });
await as('Sophie', 'Wagner');
await submit(dev1.id, 'peer', { q1: 5, q2: 'Erklärt komplexe Themen verständlich.', q3: 'Öfter Pairing anbieten.' });
await as('Tim', 'Becker');
await submit(dev1.id, 'peer', { q1: 4, q2: 'Sehr zuverlässig bei Bereitschaftsdiensten.' });
await as('Lars', 'Lehmann');
await submit(dev1.id, 'manager', { q1: 4, q2: 'Starkes Jahr, wichtige Stütze im Team.', q3: 'Nächster Schritt: Tech Lead für das Kundenportal.' });
await call('POST', `/review-cycles/${cycle.id}/release`, { personId: dev1.id });

// Anonymous engagement pulse with enough answers for results.
cookie = adminCookie;
const survey = await call('POST', '/surveys', {
  title: 'Engagement-Pulse',
  intro: 'Fünf kurze Fragen dazu, wie es dir gerade bei uns geht.',
  anonymous: true,
  questions: [
    { id: 'q1', type: 'scale', text: 'Ich arbeite gern hier.', required: true },
    { id: 'q2', type: 'scale', text: 'Ich bekomme regelmäßig hilfreiches Feedback.', required: true },
    { id: 'q3', type: 'enps', text: 'Wie wahrscheinlich ist es, dass du uns als Arbeitgeber weiterempfiehlst?', required: true },
    { id: 'q4', type: 'text', text: 'Was sollten wir verbessern?', required: false },
  ],
});
await call('POST', `/surveys/${survey.id}/open`);
const answers: [string, string, Record<string, unknown>][] = [
  ['Mia', 'Meier', { q1: 5, q2: 4, q3: 9, q4: 'Mehr Fokuszeit ohne Meetings.' }],
  ['Sophie', 'Wagner', { q1: 4, q2: 3, q3: 8, q4: 'Klarere Ziele pro Quartal.' }],
  ['Tim', 'Becker', { q1: 4, q2: 4, q3: 10 }],
  ['Elif', 'Yilmaz', { q1: 5, q2: 4, q3: 9, q4: 'Bessere Hardware für Design.' }],
  ['Felix', 'Braun', { q1: 3, q2: 2, q3: 6, q4: 'Mehr Austausch zwischen Sales und Engineering.' }],
  ['Paul', 'Neumann', { q1: 4, q2: 3, q3: 7 }],
  ['Nora', 'Krüger', { q1: 4, q2: 4, q3: 8 }],
];
for (const [first, last, a] of answers) {
  await as(first, last);
  await call('POST', `/surveys/${survey.id}/responses`, { answers: a });
}

console.log('Demo data created. Accounts (password = DEMO_PASSWORD):');
for (const e of ['admin', 'hanna.hofmann', 'lars.lehmann', 'mia.meier', 'jonas.schulz', 'sophie.wagner', 'nora.krueger']) console.log(`  ${e}@musterwerk.example`);
await app.close();
