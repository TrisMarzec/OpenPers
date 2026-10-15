# Contributing to OpenPers

Thanks for helping! Bug reports, translations, docs and code are all welcome.

## Ground rules

- **No real personal data** anywhere: code, tests, fixtures, screenshots, issues. Use made-up names.
- **Clean room:** do not copy code, texts or designs from commercial HR products. Public documentation
  may inform *what* a feature does, never *how* it is implemented or worded.
- By contributing you agree that your contribution is licensed under the AGPL-3.0-only (see `LICENSE`).
  Sign off your commits (`git commit -s`) to confirm the [Developer Certificate of Origin](https://developercertificate.org/).

## Setup

Requires Node.js 22+. No database or Docker needed for development: an embedded PostgreSQL (PGlite)
is used when `DATABASE_URL` is empty.

```bash
npm ci
cp .env.example .env      # set SECRET_KEY, e.g. openssl rand -hex 32
npm run dev:server        # API on :3000, restarts on change
npm run dev:web           # UI on :5173, proxies /api to :3000
```

Optional demo data on a fresh installation: `DEMO_PASSWORD=choose-one npm run seed:demo`.

## Before you open a pull request

```bash
npm run typecheck
npm test
npm run build
```

- Every new API route gets a test, including the permission cases (who must get 403).
- Schema changes: edit `apps/server/src/modules/<module>/schema.ts`, then
  `npm run db:generate -w @openpers/server` and commit the generated migration. Never edit a
  migration that is already released.
- UI texts go into **both** `apps/web/src/locales/de.ts` and `en.ts` (the type check enforces it).
- Keep pull requests focused; describe the HR process the change supports.

## Project layout

```
packages/shared   domain logic without I/O (holidays, absences, ArbZG, permissions, analytics)
apps/server       Fastify API; one folder per module in src/modules/*, Drizzle ORM + migrations
apps/web          React UI (Vite, React Router, TanStack Query, Tailwind, i18next)
docs/             operator and maintainer documentation
```

A module implements `OpenPersModule` (`apps/server/src/lib/context.ts`): routes, permissions, seed
data, GDPR export and anonymization hooks. New modules are registered in `modules/index.ts`.

## Releases (maintainers)

1. `npm version minor` (or `patch`) on `main` – updates `package.json` and creates the tag.
2. `git push --follow-tags` – the *Release* workflow tests, builds a multi-arch image to
   `ghcr.io/<owner>/openpers` and creates a GitHub release with generated notes.
