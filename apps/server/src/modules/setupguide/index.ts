import { count, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { company, companyDocuments, orgUnits, persons, workplaces } from '../../db/schema';
import { makeRoute } from '../../lib/api';
import { audit, type AppContext, type OpenPersModule } from '../../lib/context';
import { notFound } from '../../lib/errors';

export const SETUP_STEPS = ['company', 'locations', 'departments', 'roles', 'documents', 'people'] as const;
type Step = (typeof SETUP_STEPS)[number];

interface GuideState {
  confirmed: Step[];
  skipped: Step[];
  dismissedAt?: string;
}

/**
 * Guided first-time setup for admins. Steps backed by data count as done once the data exists;
 * `company` and `roles` always have data (defaults), so they need an explicit confirmation.
 */
export const setupGuideModule: OpenPersModule = {
  name: 'setupguide',
  register(app, ctx: AppContext) {
    const { db } = ctx;
    const route = makeRoute(app, ctx.registry);

    async function load() {
      const [c] = await db.select().from(company).limit(1);
      if (!c) throw notFound('Setup not completed');
      const raw = ((c.settings as Record<string, unknown>).setupGuide ?? {}) as Partial<GuideState>;
      return { c, state: { confirmed: raw.confirmed ?? [], skipped: raw.skipped ?? [], dismissedAt: raw.dismissedAt } as GuideState };
    }

    async function save(c: typeof company.$inferSelect, state: GuideState) {
      await db.update(company).set({ settings: { ...(c.settings as Record<string, unknown>), setupGuide: state } }).where(eq(company.id, c.id));
    }

    async function counts(): Promise<Partial<Record<Step, number>>> {
      const n = async (q: Promise<{ n: number }[]>) => Number((await q)[0]?.n ?? 0);
      return {
        locations: await n(db.select({ n: count() }).from(workplaces)),
        departments: await n(db.select({ n: count() }).from(orgUnits)),
        documents: await n(db.select({ n: count() }).from(companyDocuments)),
        people: await n(db.select({ n: count() }).from(persons).where(isNull(persons.anonymizedAt))),
      };
    }

    async function view() {
      const { state } = await load();
      const c = await counts();
      // The admin created during setup is the first person; "people" is done with the second one.
      const hasData = (k: Step) => (k === 'people' ? (c.people ?? 0) > 1 : (c[k] ?? 0) > 0);
      const steps = SETUP_STEPS.map((key) => ({
        key,
        status: state.confirmed.includes(key) || hasData(key) ? 'done' : state.skipped.includes(key) ? 'skipped' : 'open',
        ...(c[key] !== undefined ? { count: c[key] } : {}),
      }));
      return { steps, completed: steps.filter((s) => s.status !== 'open').length, total: steps.length, dismissed: !!state.dismissedAt };
    }

    route({ method: 'GET', url: '/api/v1/setup-guide', perm: 'settings.manage', tag: 'setup', summary: 'Progress of the guided company setup' }, () => view());

    route(
      { method: 'POST', url: '/api/v1/setup-guide/steps/:key', perm: 'settings.manage', tag: 'setup', summary: 'Confirm, skip or reopen a setup step', body: z.object({ status: z.enum(['done', 'skipped', 'open']) }) },
      async ({ user, params, body }) => {
        if (!(SETUP_STEPS as readonly string[]).includes(params.key)) throw notFound('Unknown setup step');
        const key = params.key as Step;
        const { c, state } = await load();
        const confirmed = state.confirmed.filter((k) => k !== key);
        const skipped = state.skipped.filter((k) => k !== key);
        if (body.status === 'done') confirmed.push(key);
        if (body.status === 'skipped') skipped.push(key);
        await save(c, { ...state, confirmed, skipped });
        await audit(db, user.userId, 'company', c.id, 'setup_step', { step: key, status: body.status });
        return view();
      },
    );

    route({ method: 'POST', url: '/api/v1/setup-guide/dismiss', perm: 'settings.manage', tag: 'setup', summary: 'Hide the setup guide from the dashboard' }, async ({ user }) => {
      const { c, state } = await load();
      await save(c, { ...state, dismissedAt: new Date().toISOString() });
      await audit(db, user.userId, 'company', c.id, 'setup_dismissed');
      return view();
    });
  },
};
