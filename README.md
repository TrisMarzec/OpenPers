# OpenPers

**Open-source HR software you host yourself.** For small and mid-sized companies in Germany, Austria and Switzerland:
employee records, absences, time tracking, documents and recruiting, in one application under your own control.

> 🇩🇪 Deutsch weiter unten · German version below

## Features

| Module | What it does |
|---|---|
| **Employee records** | People with employments (several per person over time), org structure (departments/teams, locations, legal entities, cost centers), working-time models per weekday, changes scheduled for a future date, custom fields, encrypted confidential fields (AES‑256‑GCM), company directory |
| **Absences** | Configurable absence types, vacation policies with carry-over and expiry, pro-rata entitlement (BUrlG §5), public holidays for all 16 German states plus AT/CH, company holidays, half days, live preview of working days, approvals by managers, team calendar |
| **Time tracking** | Clock in/out, manual entries, breaks, projects, warnings under the German Working Hours Act (6h/9h breaks, 10h max, 11h rest), overtime balance against the schedule (minus holidays and absences), optional approval and locking |
| **Documents** | Per-person documents with categories and employee visibility, type checking by file signature, templates with placeholders |
| **Recruiting** | Jobs, configurable pipeline, public careers page with application form and CV upload, notes, ratings, "hire" creates the employee record, automatic anonymization after the retention period |
| **Platform** | Roles & scopes (everyone / own department / own team / self), audit log, GDPR export & anonymization, REST API with OpenAPI, API tokens, signed webhooks with retries, German & English UI |

## Quick start with Docker

```bash
cp .env.example .env
# fill in SECRET_KEY (openssl rand -hex 32) and POSTGRES_PASSWORD
docker compose up -d
```

Open http://localhost:3000. The setup wizard creates your company and the first administrator.

## Without Docker (embedded database)

Requires Node.js 22+. Without `DATABASE_URL`, OpenPers uses an embedded PostgreSQL (PGlite) in `DATA_DIR`. That is fine for evaluation and small teams; use a real PostgreSQL in production.

```bash
npm ci
npm run build
cp .env.example .env   # set SECRET_KEY
npm start
```

Demo data for a fresh installation: `DEMO_PASSWORD=choose-a-password npm run seed:demo`.

## Development

```bash
npm ci
cp .env.example .env        # set SECRET_KEY
npm run dev:server          # API on :3000 (auto-reload)
npm run dev:web             # UI on :5173, proxies /api to :3000
npm test                    # domain + API tests (embedded DB, no Docker needed)
```

Structure:

```
packages/shared   domain logic (holidays, absence breakdown, balances, ArbZG checks, permissions)
apps/server       Fastify API, one folder per module in src/modules/*, Drizzle ORM + migrations
apps/web          React UI (Vite, React Router, TanStack Query, Tailwind, i18next)
```

A module registers its routes, permissions, seed data, GDPR export and anonymization hooks via the `OpenPersModule` interface (`apps/server/src/lib/context.ts`). New modules go in `apps/server/src/modules/<name>` and are listed in `modules/index.ts`.

API documentation: `GET /api/v1/openapi.json`. Authentication via session cookie (browser) or `Authorization: Bearer opk_…` (API token). Webhook requests carry `X-OpenPers-Signature: sha256=<HMAC-SHA256(body, secret)>`.

## Operations

- **Backups:** database (`pg_dump`, or the `DATA_DIR/db` folder when using the embedded DB) **and** `DATA_DIR/files` (uploaded documents). Also back up `SECRET_KEY`: without it, encrypted fields cannot be read.
- **Updates:** pull the new version and restart. Migrations run automatically at startup.
- **HTTPS:** run behind a reverse proxy (Caddy, Traefik, nginx) and set `APP_URL=https://…`.

## Legal & origin

OpenPers is an independent project and not affiliated with Personio or any other vendor. The feature scope was derived from public documentation; no third-party code or design was used. Notes on statutory rules (BUrlG, ArbZG, GDPR) are support features, not legal advice.

License: [AGPL-3.0](LICENSE).

---

## 🇩🇪 Deutsch

**Quelloffene Personalsoftware zum Selbst-Hosten** für kleine und mittlere Unternehmen im DACH-Raum: Personalakte, Abwesenheiten, Zeiterfassung, Dokumente und Recruiting.

**Schnellstart:** `.env.example` nach `.env` kopieren, `SECRET_KEY` (z. B. `openssl rand -hex 32`) und `POSTGRES_PASSWORD` setzen, dann `docker compose up -d` und http://localhost:3000 öffnen. Der Einrichtungsassistent legt Firma und erstes Admin-Konto an.

**Ohne Docker:** Node.js 22+, `npm ci && npm run build && npm start`. Ohne `DATABASE_URL` läuft eine eingebettete Datenbank in `DATA_DIR`, ideal zum Ausprobieren.

**Highlights für DACH:** Feiertage aller 16 Bundesländer sowie AT/CH, anteiliger Urlaubsanspruch nach BUrlG §5, Resturlaub mit Verfall, ArbZG-Hinweise (Pausen, Höchstarbeitszeit, Ruhezeit), DSGVO-Datenexport und Anonymisierung, Löschfristen für Bewerbungen, verschlüsselte vertrauliche Felder, Oberfläche auf Deutsch und Englisch.

**Sicherung:** Datenbank **und** `DATA_DIR/files` sichern, ebenso den `SECRET_KEY`.
