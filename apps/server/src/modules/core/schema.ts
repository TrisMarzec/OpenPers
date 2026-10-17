import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const company = pgTable('company', {
  id: id(),
  name: text('name').notNull(),
  region: text('region').notNull(),
  locale: text('locale').notNull().default('de'),
  timezone: text('timezone').notNull().default('Europe/Berlin'),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  logoKey: text('logo_key'),
  logoMime: text('logo_mime'),
  logoUpdatedAt: timestamp('logo_updated_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    passwordHash: text('password_hash'),
    oidcSubject: text('oidc_subject'),
    locale: text('locale').notNull().default('de'),
    personId: uuid('person_id'),
    active: boolean('active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('users_email_idx').on(t.email), uniqueIndex('users_person_idx').on(t.personId)],
);

export const roles = pgTable(
  'roles',
  {
    id: id(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    permissions: jsonb('permissions').$type<string[]>().notNull(),
    defaultScope: text('default_scope').notNull().default('self'),
    /** Access level per data category for own profile and others; null = built-in default. */
    fieldAccess: jsonb('field_access').$type<Record<string, { self: string; others: string }> | null>(),
    builtin: boolean('builtin').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('roles_key_idx').on(t.key)],
);

export const roleAssignments = pgTable(
  'role_assignments',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
  },
  (t) => [index('role_assignments_user_idx').on(t.userId)],
);

export const sessions = pgTable('sessions', {
  id: id(),
  tokenHash: text('token_hash').notNull().unique(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const apiTokens = pgTable('api_tokens', {
  id: id(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  prefix: text('prefix').notNull(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  permissions: jsonb('permissions').$type<string[] | null>(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    actorUserId: uuid('actor_user_id'),
    entity: text('entity').notNull(),
    entityId: text('entity_id').notNull(),
    action: text('action').notNull(),
    changes: jsonb('changes').$type<Record<string, unknown>>(),
    at: createdAt(),
  },
  (t) => [index('audit_entity_idx').on(t.entity, t.entityId)],
);

export const outbox = pgTable('outbox', {
  id: id(),
  event: text('event').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const webhooks = pgTable('webhooks', {
  id: id(),
  url: text('url').notNull(),
  description: text('description'),
  status: text('status').notNull().default('ENABLED'),
  events: jsonb('events').$type<string[]>().notNull(),
  authType: text('auth_type').notNull().default('NONE'),
  token: text('token'),
  customHeaders: jsonb('custom_headers').$type<Record<string, string>>(),
  secret: text('secret').notNull(),
  createdAt: createdAt(),
});

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: id(),
    webhookId: uuid('webhook_id').notNull().references(() => webhooks.id, { onDelete: 'cascade' }),
    outboxId: uuid('outbox_id').notNull(),
    event: text('event').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    responseStatus: integer('response_status'),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (t) => [index('webhook_deliveries_due_idx').on(t.status, t.nextAttemptAt)],
);

/** One-time links for invitations and password resets; only the SHA-256 of the token is stored. */
export const userTokens = pgTable(
  'user_tokens',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    /** invite | reset */
    kind: text('kind').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('user_tokens_hash_idx').on(t.tokenHash), index('user_tokens_user_idx').on(t.userId)],
);

/** Outgoing mail queue, sent by the background worker with retries. */
export const emails = pgTable(
  'emails',
  {
    id: id(),
    to: text('to').notNull(),
    subject: text('subject').notNull(),
    text: text('text').notNull(),
    html: text('html').notNull(),
    /** invite | reset | test | … – for the log */
    kind: text('kind').notNull(),
    /** pending | sent | failed | skipped (no mail server configured) */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('emails_due_idx').on(t.status, t.nextAttemptAt)],
);
