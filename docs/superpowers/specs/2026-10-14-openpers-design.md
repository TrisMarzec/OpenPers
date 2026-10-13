# OpenPers – Design Spec

Datum: 2026-10-14 · Status: freigegeben (autonomer Modus, Entscheidungen dokumentiert)

## 1. Ziel & Rahmen

OpenPers ist ein quelloffenes, selbst hostbares HR-Tool für kleine und mittlere Unternehmen
im DACH-Raum – funktional angelehnt an Personio, aber eigenständig entworfen (Clean-Room:
kein Code, kein Branding, kein UI-Design von Personio).

**Erfolgskriterium v1:** Eine Firma mit ~30 Mitarbeitenden kann Mitarbeiterakte, Urlaub/Abwesenheiten,
Zeiterfassung, Dokumente und Recruiting vollständig in OpenPers abbilden; Installation mit
`docker compose up` in unter 5 Minuten.

**Nicht in v1:** Lohnabrechnung (nur später Export), Performance/Feedback, Onboarding-Checklisten,
Multi-Tenant-SaaS, E-Signatur, Mobile Apps.

### Feature-Referenz (REA)

Personio ist ein SaaS ohne lokales Artefakt und es stand kein Account zur Verfügung. Als Referenz
wurde die **öffentliche** API-Dokumentation (developer.personio.de) mit REA (`inspect_web_page`,
passiv, isolierter Headless-Chrome) erfasst. Nur Fachkonzepte wurden übernommen, keine Implementierung.

| Evidence | Seite | Übernommenes Konzept |
|---|---|---|
| ev_613a9925… | API-Übersicht | Modulschnitt: Persons, Employments, Org Units, Legal Entities, Workplaces, Cost Centers, Absence Periods/Types/Breakdowns, Attendances, Projects, Documents, Recruiting, Webhooks |
| ev_2803ebc0… | POST persons | Person + Employment getrennt; Employment hat Supervisor, Office, Org-Units (team/department), Legal Entity, Position, Status (ACTIVE/INACTIVE/ONBOARDING/LEAVE), Typ (INTERNAL/EXTERNAL), Start/Vertragsende, Probezeit, Wochenstunden, Vollzeitstunden, Kostenstellen mit Gewichtung; Custom Attributes |
| ev_04465fb4… | POST absence-periods | Abwesenheit: Person, Typ, Beginn, Ende (offen möglich, z. B. Langzeitkrank), Kommentar, Vertretung (falls Policy erlaubt), `skip_approval` |
| ev_1a96d919… | absence-types | Typ mit Kategorie und Einheit DAY (Tage/halbe Tage) oder HOUR |
| ev_db6c13c7… | breakdowns | Tagesgenaue Aufschlüsselung: verbrauchtes Kontingent je Tag, berücksichtigt Arbeitstage und Feiertage (0 am Wochenende) |
| ev_108867a0… | POST attendance-periods | Zeitraum WORK/BREAK, Start/Ende, Dauer, Projekt (nur bei WORK), Kommentar, Genehmigung, automatisch generierte Pausen nach Regeln |
| ev_02e80d07… | documents | Dokument-Metadaten je Besitzer, Kategorie, Datumsfeld, Virenscan-Status |
| ev_3b9c7518…, ev_858579bb…, ev_dbf2b27a… | recruiting | Job (Abteilung, Kategorie, Hiring-Team), Kandidat, Bewerbung (Stage, Kanal, Datum, anonymisiert), Stage-Transitions-Historie |
| ev_1e069854… | POST webhooks | Webhook mit URL, Status, Events-Liste, Auth (NONE/TOKEN/CUSTOM-Header), Signing-Secret einmalig angezeigt |

## 2. Architektur

TypeScript-Monorepo (npm workspaces), modularer Monolith, ein Docker-Image.

```
apps/server     Fastify 5 API (/api/v1), Drizzle ORM, Module unter src/modules/*
apps/web        React 19 + Vite + React Router + TanStack Query + Tailwind 4 + i18next (de/en)
packages/shared Zod-Schemas, Typen, Rechte-Konstanten, Datums-/Feiertagslogik (von API und UI genutzt)
```

**Abweichung zum Chat-Entwurf:** Module liegen als Ordner `apps/server/src/modules/<name>` statt
als eigene npm-Pakete – gleiche Isolation (Modul-Registrierungs-Interface, keine Querimporte
außer über `services`/Events), aber deutlich einfacheres Tooling für Beitragende.

### Modul-Vertrag

```ts
interface OpenPersModule {
  name: string;
  permissions: string[];            // z. B. 'absence.approve'
  routes(app: FastifyInstance, ctx: ModuleContext): Promise<void>;
}
```
`ModuleContext` liefert `db`, `events` (In-Process-Eventbus + Outbox), `audit`, `authz`.
Module: `core`, `org`, `people`, `absence`, `time`, `documents`, `recruiting`.

### Datenbank

- Produktion: PostgreSQL 16 via `DATABASE_URL`.
- Ohne `DATABASE_URL`: eingebettetes **PGlite** (Postgres in WASM) mit Datenverzeichnis `./data/db` –
  Zero-Config-Testbetrieb. Tests laufen ebenfalls auf PGlite (in-memory), kein Docker nötig.
- Migrationen: drizzle-kit generiert SQL, Server migriert beim Start.

### Hintergrundaufgaben

Kein Redis. `outbox`-Tabelle für Events → Webhook-Worker (Intervall-Loop im Server-Prozess,
Retry mit exponentiellem Backoff, max. 8 Versuche). Jahreswechsel-Jobs (Urlaubsübertrag) werden
lazy beim Lesen eines Kontos berechnet statt per Cron – robust für Self-Hoster.

## 3. Auth, Rollen & Rechte

- Login E-Mail + Passwort (argon2id), Session-Cookie (HTTP-only, SameSite=Lax, 30 Tage, DB-Tabelle `session`).
- Optional OIDC (Authorization Code + PKCE) via `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`;
  Zuordnung über E-Mail. (v1: Grundgerüst, Konfiguration per ENV.)
- API-Tokens (`opk_…`, gehasht gespeichert) für REST-Integrationen, mit Rechte-Subset.
- Rollen: **admin**, **hr**, **manager**, **employee** (+ eigene Rollen). Rechte als Strings.
  Scope je Rollen-Zuweisung: `all` | `org_unit` (inkl. Unter-Einheiten) | `reports` (direkte + indirekte Berichte) | `self`.
- Autorisierung zentral: `authz.can(user, permission, targetPersonId?)`.
- CSRF: Cookie-Sessions + Pflicht-Header `X-Requested-With: openpers` für schreibende Requests.

## 4. Datenmodell

### Core
`company` (genau 1 Zeile: name, default_locale, default_state, timezone),
`user` (email, password_hash, oidc_sub, locale, person_id?, active),
`role` (key, name, permissions jsonb, builtin), `role_assignment` (user_id, role_id, scope),
`session`, `api_token`, `audit_log` (actor, entity, entity_id, action, changes jsonb, at),
`webhook` (url, description, status, events[], auth_type, token, custom_headers, secret),
`webhook_delivery`, `outbox`.

### Organisation
`legal_entity` (name, country, state), `org_unit` (name, type team|department, parent_id, head_person_id),
`workplace` (name, country, state, address), `cost_center` (code, name).

### Personen
`person` (first_name, last_name, preferred_name, email unique, gender MALE|FEMALE|DIVERSE|UNKNOWN,
birth_date, phone, private_address, emergency_contact, language, photo_document_id),
`employment` (person_id, employee_number, status ACTIVE|INACTIVE|ONBOARDING|LEAVE, type INTERNAL|EXTERNAL,
contract_type PERMANENT|FIXED_TERM|WORKING_STUDENT|MINI_JOB|INTERN|TRAINEE, start_date, end_date,
probation_end_date, position_title, legal_entity_id, workplace_id, supervisor_person_id),
`employment_org_unit` (employment_id, org_unit_id), `employment_cost_center` (employment_id, cost_center_id, weight),
`work_schedule` (employment_id, valid_from, hours je Wochentag mo..su, full_time_weekly_hours),
`attribute_definition` (key, label, type text|number|date|select|boolean, options, section, sensitive),
`attribute_value` (person_id, definition_id, value jsonb; sensibel → AES-256-GCM verschlüsselt).

Historisierung: Wechsel von Org-Einheit, Vorgesetztem, Position werden über eine neue `employment_change`
(effective_date, changes jsonb) protokolliert und am Stichtag angewandt (lazy beim Lesen + beim Speichern, falls Stichtag ≤ heute).

### Abwesenheit
`absence_type` (name, category vacation|sick|parental|special|unpaid|other, unit DAY|HOUR, requires_approval,
counts_against_balance, allows_substitute, allows_half_days, color, attachment_required_after_days),
`absence_policy` (absence_type_id, annual_entitlement_days, carryover_max_days, carryover_expires_md "03-31", accrual yearly),
`absence_policy_assignment` (employment_id, policy_id, valid_from, entitlement_override?),
`absence_period` (person_id, type_id, start_date, end_date nullable, start_half PM?, end_half AM?, start_time/end_time (HOUR),
status pending|approved|rejected|cancelled, comment, substitute_person_id, approver_user_id, decided_at),
`balance_adjustment` (person_id, type_id, days, reason, effective_date),
`public_holiday` – nicht gespeichert, berechnet (siehe unten), + `custom_holiday` (date, name, state?, half_day).

**Breakdown-Berechnung** (`packages/shared/absence`): Für jeden Kalendertag im Zeitraum:
Soll-Stunden laut gültigem `work_schedule`; 0, wenn nicht Arbeitstag oder Feiertag am Arbeitsort-Bundesland;
halbe Tage am Rand; Tagesverbrauch = 1 (bzw. 0,5) bei DAY-Einheit, Stunden bei HOUR.
**Kontostand** = Anspruch (anteilig bei Ein-/Austritt im Jahr, BUrlG §5: 1/12 je vollem Monat) + Übertrag
(verfällt zum konfigurierten Stichtag, sofern nicht verbraucht) + Korrekturen − genehmigte/beantragte Abwesenheiten.

**Feiertage:** Eigene Implementierung (Gauß-Osterformel) für alle 16 Bundesländer inkl.
Fronleichnam, Reformationstag, Allerheiligen, Buß- und Bettag, Weltkindertag (TH), Frauentag (BE, MV ab 2023),
Mariä Himmelfahrt (SL, BY als konfigurierbar), Augsburger Friedensfest nicht (stadtspezifisch).
AT/CH: Bundesweite Feiertage in v1, kantonal/landesspezifisch später.

### Zeiterfassung
`attendance_period` (person_id, date (Zuordnungstag), type WORK|BREAK, start_at, end_at nullable (laufende Stempelung),
project_id?, comment, status pending|approved|rejected, auto_generated),
`project` (name, status ACTIVE|ARCHIVED), `project_member`,
`time_settings` (approval_required, lock_after_days, break rules).
**ArbZG-Prüfung** (Warnungen, kein Blocken): > 6 h ohne 30 min Pause, > 9 h ohne 45 min, > 10 h/Tag, < 11 h Ruhezeit.
**Saldo:** Ist (WORK − BREAK) − Soll (work_schedule, abzüglich Feiertage und genehmigter Abwesenheiten) kumuliert ab Startdatum.

### Dokumente
`document_category` (name, employee_visible), `document` (owner_person_id, category_id, name, file_key, mime, size,
sha256, document_date, uploaded_by, employee_visible).
Speicherung: lokales Dateisystem (`STORAGE_DIR`), Pfad = sha256-basiert; S3 als späterer Adapter
über `StorageAdapter`-Interface. Upload-Limit 25 MB, MIME-Whitelist (pdf, png, jpg, docx, xlsx, txt).
Vorlagen: `document_template` (Markdown mit Platzhaltern `{{person.first_name}}`) → generiert PDF-freies HTML/
Markdown-Dokument in v1.

### Recruiting
`job` (title, department_org_unit_id, workplace_id, category, employment_type, description markdown,
status draft|published|closed, slug), `pipeline_stage` (name, position, kind applied|screening|interview|offer|hired|rejected),
`candidate` (first_name, last_name, email, phone), `application` (job_id, candidate_id, stage_id, channel, cover_letter,
applied_at, anonymized, rating), `application_stage_transition` (application_id, from_stage, to_stage, actor, at),
`application_note`, `hiring_team_member` (job_id, user_id).
Öffentliche Karriereseite `/careers` (+ JSON-Endpunkt) und Bewerbungsformular mit Datei-Upload (CV).
„Einstellen“ → legt Person + Employment (ONBOARDING) aus Kandidat an.
DSGVO: Bewerbungen werden X Monate (Standard 6) nach Abschluss anonymisiert.

## 5. API

REST unter `/api/v1`, JSON, Validierung mit Zod (Schemas aus `packages/shared`), Cursor-Pagination
(`?limit&cursor`), Fehler als `application/problem+json`. OpenAPI-Dokument unter `/api/v1/openapi.json`
(aus den Zod-Schemas generiert), Swagger-UI unter `/api/docs`.
Webhook-Events: `person.created|updated`, `employment.updated`, `absence.requested|approved|rejected|cancelled`,
`attendance.created|updated`, `document.created|deleted`, `application.created|stage_changed`, `candidate.hired`.
Webhook-Requests tragen `X-OpenPers-Signature: sha256=<HMAC(body, secret)>`.

## 6. Web-Oberfläche

Navigation: Dashboard · Mitarbeitende · Abwesenheiten · Zeiterfassung · Dokumente · Recruiting · Einstellungen.
- **Dashboard:** eigene Urlaubstage, offene Freigaben, wer ist heute abwesend, Stempeluhr.
- **Mitarbeitende:** Liste mit Filter/Suche, Profil mit Tabs (Persönlich, Anstellung, Abwesenheiten, Zeiten, Dokumente, Historie).
- **Abwesenheiten:** Teamkalender (Monatsansicht), Antrag stellen mit Live-Vorschau der Tage, Freigabeliste, Konten.
- **Zeiterfassung:** Wochenansicht, Ein-/Ausstempeln, manuelle Einträge, ArbZG-Warnungen, Saldo.
- **Dokumente:** pro Person, Kategorien, Upload per Drag&Drop.
- **Recruiting:** Jobs, Kanban-Pipeline je Job, Bewerbungsdetail mit Notizen, Karriereseite.
- **Einstellungen:** Firma, Org-Struktur, Standorte, Abwesenheitstypen & Policies, Rollen, Benutzer, API-Tokens, Webhooks, Custom Fields.
- Setup-Assistent beim ersten Start (Firma, Admin-Konto, Bundesland).
- Sprachen: Deutsch (Standard), Englisch. Responsive (Mobile-Breakpoints).

## 7. Betrieb

- `Dockerfile` (multi-stage, Node 22 alpine), `docker-compose.yml` (openpers + postgres:16, Volumes für DB und Dateien).
- Konfiguration per ENV: `DATABASE_URL`, `APP_URL`, `SECRET_KEY` (Session + Feldverschlüsselung), `STORAGE_DIR`,
  `SMTP_URL` (optional, E-Mails für Freigaben), `OIDC_*`.
- Health-Check `/healthz`. Backups: dokumentiert (pg_dump + Dateiverzeichnis).
- Lizenz: AGPL-3.0 (schützt Self-Host-Charakter, Änderungen an gehosteten Varianten bleiben offen).

## 8. Fehlerbehandlung

Zod-Fehler → 422 mit Feldliste; Rechte → 403; Not found → 404; Konflikt (z. B. überlappende Abwesenheit) → 409.
Alle Schreibvorgänge in einer Transaktion inkl. Audit-Log und Outbox-Event. UI zeigt Toasts und Feldfehler.

## 9. Tests

- `packages/shared`: Unit-Tests für Feiertage, Breakdown, Kontostand, ArbZG-Regeln, Saldo (Vitest).
- `apps/server`: API-Tests je Modul gegen PGlite in-memory via `app.inject` (Auth, Rechte-Scopes, Flows).
- `apps/web`: Build + Typecheck; Smoke-Test der kritischen Flows im Browser.

## 10. Reihenfolge (Teilprojekte)

1. Fundament: Monorepo, DB, Core (Auth/Rollen/Audit/Setup), Org, Personen – inkl. UI.
2. Abwesenheiten (Feiertage, Policies, Breakdown, Konten, Freigaben, Kalender).
3. Zeiterfassung (Stempeluhr, Pausen/ArbZG, Saldo, Projekte, Freigabe).
4. Dokumente (Storage, Kategorien, Rechte, Vorlagen).
5. Recruiting (Jobs, Pipeline, Karriereseite, Einstellen).
6. Webhooks, API-Tokens, OpenAPI, Docker, README.
