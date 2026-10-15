## What and why

<!-- Short description of the change and the HR process it supports. -->

## Checklist

- [ ] `npm run typecheck`, `npm test` and `npm run build` pass locally
- [ ] New API routes have a test (permissions included) and appear in the OpenAPI spec
- [ ] Database changes come with a migration (`npm run db:generate -w @openpers/server`)
- [ ] UI texts exist in German **and** English (`apps/web/src/locales`)
- [ ] No real personal data in code, tests, screenshots or fixtures
