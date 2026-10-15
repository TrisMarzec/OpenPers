# OpenPers als Open Source auf GitHub veröffentlichen

Schritt-für-Schritt-Anleitung für die erste Veröffentlichung. Das Repository ist dafür vorbereitet:
Lizenz (AGPL-3.0, vollständiger Text), `NOTICE`, `SECURITY.md`, `CONTRIBUTING.md`,
`CODE_OF_CONDUCT.md`, Issue- und PR-Vorlagen, CI-Workflow, Release-Workflow mit Docker-Image auf
GitHub Container Registry und Dependabot.

Platzhalter: `<owner>` = dein GitHub-Benutzer- oder Organisationsname.

---

## 1. Vor dem ersten Push: Geheimnisse und Daten prüfen

Was einmal öffentlich auf GitHub war, gilt als veröffentlicht – auch wenn du es später löschst.

1. **`.env.example` zurücksetzen.** In deiner lokalen Arbeitskopie steht ein echter `SECRET_KEY`.
   Committet ist nur der Platzhalter, das soll so bleiben:

   ```bash
   git diff .env.example      # zeigt den echten Schlüssel – nicht committen
   git restore .env.example   # setzt die Datei auf den Platzhalter zurück
   ```

   Den Schlüssel deiner eigenen Installation gehört nur in `.env` (ist in `.gitignore`).
   Wenn du ihn schon für eine echte Installation nutzt, bewahre ihn im Passwortmanager auf.

2. **Historie auf Geheimnisse prüfen.** Alle Commits werden mit veröffentlicht:

   ```bash
   git log --all -p | grep -inE "secret_key=.+|password=.+|BEGIN (RSA|OPENSSH) PRIVATE KEY|opk_[a-z0-9]{20,}"
   ```

   Treffer, die nur Platzhalter oder Testwerte aus Tests sind (`correct-horse-battery`,
   `password-123456`), sind unkritisch. Gründlicher geht es mit
   [gitleaks](https://github.com/gitleaks/gitleaks): `gitleaks detect --source . -v`.

3. **Keine echten Personendaten.** `data/`, `.env`, `.env.dev` und `.superpowers/` sind ignoriert.
   Kontrolliere mit `git status --ignored`, dass dort nichts landet, was veröffentlicht würde, und
   dass keine Screenshots mit echten Namen im Repo liegen.

4. **Lokales Tooling.** `.claude/launch.json` ist nur für deine lokale Vorschau gedacht und ist
   jetzt nicht mehr versioniert (`.claude/` steht in `.gitignore`).

5. **Alles grün?**

   ```bash
   npm ci && npm run typecheck && npm test && npm run build
   docker compose build      # optional: prüft das Docker-Image lokal
   ```

## 2. Branch aufräumen

Die Entwicklung liegt auf `feat/v1`. Für die Veröffentlichung soll `main` den Stand enthalten:

```bash
git switch main
git merge --ff-only feat/v1    # klappt, wenn main seitdem nicht verändert wurde
git log --oneline -5
```

Optional: Wenn du die vielen Arbeits-Commits nicht öffentlich zeigen willst, starte mit einem
einzigen Commit (`git checkout --orphan release && git add -A && git commit -m "OpenPers 0.1.0"`,
danach `release` in `main` umbenennen). Das ist Geschmackssache – eine ehrliche Historie ist für
Open Source normal.

## 3. Repository auf GitHub anlegen

**Mit der GitHub CLI** (`gh auth login` vorher einmal ausführen):

```bash
gh repo create <owner>/openpers --public --source . --remote origin \
  --description "Open-source HR software for the DACH region – self-hosted" \
  --homepage "https://github.com/<owner>/openpers"
git push -u origin main
```

**Oder im Browser:** github.com → *New repository* → Name `openpers`, *Public*, **ohne** README,
Lizenz oder .gitignore (sind schon vorhanden) → dann:

```bash
git remote add origin https://github.com/<owner>/openpers.git
git push -u origin main
```

Den Branch `feat/v1` musst du nicht hochladen.

## 4. Repository einrichten (Settings)

| Wo | Was | Warum |
|---|---|---|
| *About* (Zahnrad auf der Startseite) | Beschreibung, Topics: `hr`, `hris`, `self-hosted`, `personio-alternative`, `dsgvo`, `typescript` | Auffindbarkeit |
| *Settings → General → Features* | Issues an, Discussions an (für Fragen), Wiki aus | Fragen landen nicht als Bugs |
| *Settings → Branches → Add rule* für `main` | „Require a pull request“, „Require status checks: CI / test, CI / docker“ | Nichts Ungetestetes auf `main` |
| *Settings → Code security* | Dependabot alerts + security updates, Secret scanning + push protection, Private vulnerability reporting | Passt zu `SECURITY.md` |
| *Settings → Actions → General* | „Read and write permissions“ ist **nicht** nötig – die Workflows fordern ihre Rechte selbst an | Minimalrechte |

GitHub erkennt die Lizenz automatisch als „AGPL-3.0“, sobald `LICENSE` den reinen Lizenztext
enthält (ist so vorbereitet; der Copyright-Hinweis steht in `NOTICE`).

## 5. Erste Version veröffentlichen

```bash
npm version 0.1.0 --no-git-tag-version   # nur falls die Version noch angepasst werden soll
git tag v0.1.0
git push origin v0.1.0
```

Der Workflow *Release* (`.github/workflows/release.yml`) startet automatisch und

1. führt alle Tests aus,
2. baut das Docker-Image für `linux/amd64` und `linux/arm64`,
3. lädt es nach `ghcr.io/<owner>/openpers` mit den Tags `0.1.0`, `0.1` und `latest`,
4. erstellt einen GitHub-Release mit automatisch erzeugten Release Notes.

**Danach einmalig:** Unter *Profil → Packages → openpers → Package settings* die Sichtbarkeit auf
**Public** stellen (neue Pakete sind zunächst privat) und das Paket mit dem Repository verknüpfen.

Spätere Versionen: `npm version minor` (erstellt Commit und Tag `v0.2.0`), dann
`git push --follow-tags`.

## 6. Prüfen, ob Fremde es installieren können

Auf einem anderen Rechner oder in einem leeren Ordner:

```bash
git clone https://github.com/<owner>/openpers.git && cd openpers
cp .env.example .env
# SECRET_KEY und POSTGRES_PASSWORD setzen, OPENPERS_IMAGE=ghcr.io/<owner>/openpers:0.1
docker compose up -d
```

Dann http://localhost:3000 öffnen → Einrichtungsassistent. Klappt das ohne Nacharbeit, ist die
Veröffentlichung fertig. Ausführliche Betriebsdoku für Nutzer: [`docs/self-hosting.md`](self-hosting.md).

## 7. README-Feinschliff nach dem Push

- In `README.md` `<owner>` durch deinen Namen ersetzen (Badges, Clone-URL, Image-Name).
- Screenshots ergänzen: mit Demo-Daten (`DEMO_PASSWORD=… npm run seed:demo`) aufnehmen, als
  `docs/screenshots/*.png` ablegen und im README einbinden. Nur erfundene Personen zeigen.

## 8. Rechtliches – kurz

- **AGPL-3.0:** Jeder darf OpenPers nutzen, ändern und weitergeben. Wer eine geänderte Version
  Nutzern über das Netz anbietet (z. B. als SaaS), muss den geänderten Quellcode bereitstellen.
  Das schützt dich davor, dass jemand ein geschlossenes Produkt daraus macht.
- **Markenname:** „Personio“ nur beschreibend verwenden („Alternative zu …“), nicht im Projektnamen
  oder Logo. `NOTICE` stellt klar, dass keine Verbindung besteht.
- **Haftung:** Lizenz schließt Gewährleistung aus; Hinweise zu BUrlG/ArbZG/DSGVO in der App sind
  Hilfen, keine Rechtsberatung (steht im README).
- **Beiträge:** `CONTRIBUTING.md` verlangt Sign-off (DCO). So bleibt nachvollziehbar, dass
  Beitragende ihren Code unter der AGPL einbringen dürfen.

## Checkliste

- [ ] `.env.example` zurückgesetzt, `git diff` sauber
- [ ] Historie geprüft (grep/gitleaks), keine echten Daten
- [ ] Tests, Typecheck, Build grün
- [ ] `main` enthält den Stand von `feat/v1`
- [ ] Repo angelegt, `main` gepusht
- [ ] Branch-Schutz, Secret Scanning, Dependabot, Private Vulnerability Reporting aktiv
- [ ] Tag `v0.1.0` gepusht, Release-Workflow grün, Paket auf *Public*
- [ ] Installation aus dem veröffentlichten Image getestet
- [ ] `<owner>` im README ersetzt, Screenshots ergänzt
