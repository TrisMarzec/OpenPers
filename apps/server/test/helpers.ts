import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';

export const ADMIN = { email: 'admin@example.com', password: 'correct-horse-battery' };

export async function createTestApp(): Promise<FastifyInstance> {
  return buildApp({
    inMemory: true,
    secretKey: 'test-secret-key-that-is-long-enough-1234',
    storageDir: mkdtempSync(join(tmpdir(), 'openpers-test-')),
    logger: false,
    startWorker: false,
  });
}

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Record<string, unknown>;
}

export interface Client {
  cookie?: string;
  token?: string;
  get<T = any>(url: string): Promise<Res<T>>;
  post<T = any>(url: string, body?: unknown, headers?: Record<string, string>): Promise<Res<T>>;
  patch<T = any>(url: string, body?: unknown): Promise<Res<T>>;
  put<T = any>(url: string, body?: unknown): Promise<Res<T>>;
  delete<T = any>(url: string): Promise<Res<T>>;
}

export function client(app: FastifyInstance, auth: { cookie?: string; token?: string } = {}): Client {
  const call = async (method: string, url: string, body?: unknown, extra: Record<string, string> = {}) => {
    const headers: Record<string, string> = { 'x-requested-with': 'openpers', ...extra };
    if (auth.cookie) headers.cookie = auth.cookie;
    if (auth.token) headers.authorization = `Bearer ${auth.token}`;
    const res = await app.inject({ method: method as any, url, headers, ...(body !== undefined ? { payload: body as any } : {}) });
    let parsed: any = res.body;
    try {
      parsed = res.body ? JSON.parse(res.body) : undefined;
    } catch {
      /* non-JSON body */
    }
    return { status: res.statusCode, body: parsed, headers: res.headers as Record<string, unknown> };
  };
  return {
    ...auth,
    get: (u) => call('GET', u),
    post: (u, b, h) => call('POST', u, b ?? {}, h),
    patch: (u, b) => call('PATCH', u, b ?? {}),
    put: (u, b) => call('PUT', u, b ?? {}),
    delete: (u) => call('DELETE', u),
  };
}

export async function login(app: FastifyInstance, email: string, password: string): Promise<Client> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password }, headers: { 'x-requested-with': 'openpers' } });
  if (res.statusCode !== 200) throw new Error(`login failed ${res.statusCode} ${res.body}`);
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
  return client(app, { cookie: raw.split(';')[0] });
}

export async function setupCompany(app: FastifyInstance, region = 'DE-BE'): Promise<Client> {
  const res = await client(app).post('/api/v1/setup', {
    companyName: 'Acme GmbH',
    region,
    locale: 'de',
    admin: { ...ADMIN, firstName: 'Ada', lastName: 'Admin' },
  });
  if (res.status !== 201) throw new Error(`setup failed ${res.status} ${JSON.stringify(res.body)}`);
  return login(app, ADMIN.email, ADMIN.password);
}

/** Creates a person (+ employment) and a user account with the given role; returns a logged-in client. */
export async function createEmployee(
  app: FastifyInstance,
  admin: Client,
  opts: { firstName: string; lastName?: string; role?: string; supervisorPersonId?: string; orgUnitIds?: string[]; startDate?: string; weeklyHours?: number[] },
): Promise<{ personId: string; userId: string; client: Client; email: string }> {
  const email = `${opts.firstName.toLowerCase()}.${Math.random().toString(36).slice(2, 7)}@example.com`;
  const p = await admin.post('/api/v1/persons', {
    firstName: opts.firstName,
    lastName: opts.lastName ?? 'Test',
    email,
    employment: {
      startDate: opts.startDate ?? '2024-01-01',
      positionTitle: 'Engineer',
      supervisorPersonId: opts.supervisorPersonId ?? null,
      orgUnitIds: opts.orgUnitIds ?? [],
      weeklyHours: opts.weeklyHours ?? [8, 8, 8, 8, 8, 0, 0],
    },
  });
  if (p.status !== 201) throw new Error(`create person failed ${p.status} ${JSON.stringify(p.body)}`);
  const u = await admin.post('/api/v1/users', { email, password: 'password-123456', roles: [opts.role ?? 'employee'], personId: p.body.id });
  if (u.status !== 201) throw new Error(`create user failed ${u.status} ${JSON.stringify(u.body)}`);
  return { personId: p.body.id, userId: u.body.id, client: await login(app, email, 'password-123456'), email };
}

/** Builds a multipart/form-data body for app.inject. */
export function multipart(fields: Record<string, string>, file?: { name: string; type: string; data: Buffer }) {
  const boundary = `----openpers${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
    parts.push(file.data, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
