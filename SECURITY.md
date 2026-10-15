# Security policy

OpenPers stores some of the most sensitive data a company has: salaries, bank details, health-related
absences, performance reviews. We take reports seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Please do not open a public issue.** Use GitHub's private reporting instead:
*Security* tab → *Report a vulnerability*. Include the affected version, steps to reproduce and the
impact you expect. Do not include real personal data.

You will get a first answer within 7 days. Once a fix is released we publish a security advisory and
credit you, unless you prefer to stay anonymous.

## Supported versions

Only the latest minor release receives security fixes. Updating is a pull + restart; database
migrations run automatically.

## Hardening checklist for operators

- Serve OpenPers only over HTTPS (reverse proxy) and set `APP_URL=https://…` so cookies are `Secure`.
- Generate `SECRET_KEY` with `openssl rand -hex 32`, keep it out of version control and back it up:
  without it, encrypted fields (salary, bank account, tax ID) cannot be decrypted.
- Back up the database **and** the `DATA_DIR/files` folder (documents, photos, logos).
- Give people the smallest role that works; review *Settings → Roles → access to sensitive data*.
- Keep the server and the Docker base image updated (Dependabot is configured for this repository).

## Built-in protections (overview)

- Passwords hashed with Argon2id, login rate limiting, session cookies `HttpOnly` + `SameSite=Lax`,
  CSRF header check on all state-changing requests.
- Field-level access per data category and role; confidential fields encrypted with AES-256-GCM.
- Uploads are type-checked by file signature, stored content-addressed outside the web root and
  served with `nosniff`; SVG logos are served with a sandboxing Content-Security-Policy.
- Anonymous surveys store answers without user or timestamp; results need at least 3 answers.
- Audit log for changes to personal data; GDPR export and anonymization.
