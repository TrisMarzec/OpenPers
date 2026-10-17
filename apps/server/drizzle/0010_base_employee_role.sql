-- Every account linked to a person keeps the built-in employee role (own absences, times, documents).
-- Before this, a user with only the manager role could not request leave or track their own time.
INSERT INTO "role_assignments" ("user_id", "role_id", "scope")
SELECT u."id", r."id", 'self'
FROM "users" u
CROSS JOIN "roles" r
WHERE r."key" = 'employee'
  AND u."person_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "role_assignments" ra WHERE ra."user_id" = u."id" AND ra."role_id" = r."id"
  );
