# Self-hosting OpenPers

This guide is for the people who run OpenPers for a company. Plan about 30 minutes for a first
installation.

## Requirements

| | Minimum | Recommended |
|---|---|---|
| Server | 1 vCPU, 1 GB RAM | 2 vCPU, 2 GB RAM |
| Software | Docker with Compose v2 | same, plus a reverse proxy with HTTPS |
| Database | bundled PostgreSQL 16 container | managed PostgreSQL 14+ with backups |
| Location | – | EU data centre (GDPR) |

## 1. Install with Docker Compose

```bash
git clone https://github.com/<owner>/openpers.git
cd openpers
cp .env.example .env
```

Edit `.env`:

| Variable | Required | Meaning |
|---|---|---|
| `SECRET_KEY` | yes | ≥ 32 random characters: `openssl rand -hex 32`. Encrypts confidential fields. **Never change it after setup and back it up.** |
| `POSTGRES_PASSWORD` | yes (Compose) | Password of the bundled database. |
| `APP_URL` | yes in production | Public URL, e.g. `https://hr.example.com`. `https://` enables secure cookies. |
| `OPENPERS_IMAGE` | no | Prebuilt image, e.g. `ghcr.io/<owner>/openpers:0.2`. Without it, Compose builds locally. |
| `DATABASE_URL` | no | Own PostgreSQL instead of the bundled one. |
| `DATA_DIR` | no | Where uploads (and the embedded DB without `DATABASE_URL`) live. Default `/data` in Docker. |
| `PORT`, `HOST` | no | Listening port / interface (default `3000`, `0.0.0.0`). |
| `LOG_LEVEL` | no | `info` (default) or `silent`. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE`, `MAIL_FROM` | recommended | Mail server for invitations and password resets, see below. |

Start it:

```bash
docker compose up -d          # uses OPENPERS_IMAGE, or builds from source
docker compose logs -f openpers
```

Open `APP_URL`. The setup wizard creates the company and the first administrator. Then, under
**Settings**: upload the logo, check the federal state for public holidays, create departments,
absence types and roles.

## 2. HTTPS with a reverse proxy

OpenPers itself speaks plain HTTP on port 3000. Put a proxy in front of it. Example with
[Caddy](https://caddyserver.com/) (gets certificates automatically):

```caddyfile
hr.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:3000
}
```

nginx needs `client_max_body_size 25m;` (document uploads are limited to 25 MB) and the usual
`proxy_set_header Host/X-Forwarded-For/X-Forwarded-Proto` lines. Bind the container port to
localhost only (`"127.0.0.1:3000:3000"` in `docker-compose.yml`) when the proxy runs on the host.

## 3. E-mail (invitations, password reset)

OpenPers sends invitations ("choose your password") and password-reset links by e-mail. Any SMTP
server works – your Microsoft 365 / Google Workspace account, your hosting provider, or a service
such as Brevo, Mailjet or Amazon SES (EU regions available).

```ini
SMTP_HOST=smtp.example.com
# 587 = STARTTLS, 465 = TLS from the start
SMTP_PORT=587
SMTP_USER=hr@example.com
SMTP_PASSWORD=…
MAIL_FROM="Musterwerk HR <hr@example.com>"
```

Restart OpenPers, then send a test e-mail under **Settings → E-mail**; the delivery log there shows
failures with the server's error message. Failed mails are retried automatically (5 attempts with
increasing delay). Make sure `APP_URL` is the public address – the links in the mails point there.
For good deliverability, the sender domain needs SPF and DKIM records from your mail provider.

**Without a mail server** OpenPers still works: when you invite someone, the invitation link is
shown to you to pass on (e.g. via chat). It works once and expires after 7 days. "Forgot password"
needs a mail server – without one, admins set a new password in the person's profile.

## 4. Backups

Back up three things, and test a restore at least once:

1. **Database** – `docker compose exec db pg_dump -U openpers openpers > openpers-$(date +%F).sql`
2. **Files** – the `openpers-files` volume (`/data/files`: documents, photos, logos)
3. **`SECRET_KEY`** – in a password manager. Without it, salaries, bank details and tax IDs in the
   backup are unreadable.

Restore: start an empty stack, `psql` the dump into the `db` container, copy the files back into the
volume, use the same `SECRET_KEY`, start `openpers`.

## 5. Updates

```bash
git pull                      # or change OPENPERS_IMAGE to the new version
docker compose pull           # when using a prebuilt image
docker compose up -d --build
```

Migrations run automatically at start-up. Take a backup before updating to a new minor version and
read the release notes.

## 6. Without Docker

Node.js 22+:

```bash
npm ci && npm run build
cp .env.example .env          # SECRET_KEY, optional DATABASE_URL
npm start
```

Without `DATABASE_URL` an embedded PostgreSQL (PGlite) stores data in `DATA_DIR/db` – fine for
trying it out and small teams; use a real PostgreSQL for production. Run it as a service, e.g. with a
systemd unit using `WorkingDirectory=` and `ExecStart=/usr/bin/npm start`.

## 7. Operations

- Health check: `GET /healthz` returns `{ "status": "ok", "version": "…" }`.
- API documentation: `GET /api/v1/openapi.json`; API tokens and webhooks under *Settings → API & Webhooks*.
- Webhooks are signed: `X-OpenPers-Signature: sha256=<HMAC-SHA256(body, secret)>`.
- Background jobs (reminders, overdue tasks, survey closing, applicant data retention) run inside
  the server process; no cron needed. Run a single instance.

## 8. Data protection notes (DACH)

- You are the controller; OpenPers is software, not a service provider. Document the processing in
  your record of processing activities (Art. 30 GDPR) and inform employees.
- In Germany, introducing time tracking and performance reviews usually requires involving the
  works council (§ 87 BetrVG). Review roles and the access matrix with them.
- Retention: applicant data is anonymized automatically after the configured months (Settings →
  Company). Use *Anonymize* on a person for erasure requests and *Export* for access requests.
