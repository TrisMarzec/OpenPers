import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { loadConfig, type Config } from './config';
import { createDb } from './db';
import { buildOpenApi, type RouteRecord } from './lib/api';
import { Authz } from './lib/authz';
import type { AppContext, OpenPersModule } from './lib/context';
import { FieldCipher } from './lib/crypto';
import { HttpError, problem } from './lib/errors';
import { LocalStorage } from './lib/storage';
import { coreModule } from './modules/core';
import { registerAuthHook } from './modules/core/principal';
import { featureModules } from './modules';
import { startWorker } from './lib/worker';
import { resetEventListeners } from './lib/context';
import { applyDueEmploymentChanges } from './modules/people';
import { anonymizeExpiredApplications, retentionMonths } from './modules/recruiting';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}

export async function buildApp(overrides: Partial<Config> = {}): Promise<FastifyInstance> {
  const config = loadConfig(overrides);
  const { db, close } = await createDb({ databaseUrl: config.inMemory ? undefined : config.databaseUrl, dataDir: join(config.dataDir, 'db'), inMemory: config.inMemory });

  const app = Fastify({ logger: config.logger ? { level: process.env.LOG_LEVEL ?? 'info' } : false, bodyLimit: 2 * 1024 * 1024, trustProxy: true });
  const registry: RouteRecord[] = [];
  const ctx: AppContext = { db, config, authz: new Authz(db), cipher: new FieldCipher(config.secretKey), storage: new LocalStorage(config.storageDir), registry, exporters: {}, anonymizers: [], maintenance: [], services: {} };
  app.decorate('ctx', ctx);
  app.addHook('onClose', async () => close());

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

  app.setErrorHandler((err: any, request, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).type('application/problem+json').send(problem(err.status, err.message, err.extra));
    if (err instanceof ZodError) {
      return reply.code(422).type('application/problem+json').send(problem(422, 'Validation failed', { errors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }));
    }
    if (err.code === 'FST_REQ_FILE_TOO_LARGE' || err.statusCode === 413) return reply.code(413).type('application/problem+json').send(problem(413, 'File too large'));
    if (err.validation || (err.statusCode && err.statusCode < 500)) {
      return reply.code(err.statusCode ?? 400).type('application/problem+json').send(problem(err.statusCode ?? 400, err.message));
    }
    // Postgres unique violation
    if (err.code === '23505' || err.cause?.code === '23505') return reply.code(409).type('application/problem+json').send(problem(409, 'Duplicate value'));
    request.log.error(err);
    return reply.code(500).type('application/problem+json').send(problem(500, 'Internal server error'));
  });

  registerAuthHook(app, db);
  resetEventListeners();

  const modules: OpenPersModule[] = featureModules();
  const all = [coreModule(modules), ...modules];
  for (const m of all) await m.register(app, ctx);
  for (const m of all) await m.upgrade?.(ctx);

  app.get('/healthz', async () => ({ status: 'ok', version: config.version }));
  app.get('/api/v1/openapi.json', async () => buildOpenApi(registry, config.version));

  const webDist = config.webDistDir ?? [join(process.cwd(), 'apps/web/dist'), join(process.cwd(), '../web/dist')].find((d) => existsSync(join(d, 'index.html')));
  if (webDist && existsSync(join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: true,
      setHeaders: (res, path) => {
        // Vite emits content-hashed file names below assets/, so they can be cached forever.
        if (/[\\/]assets[\\/]/.test(path)) res.header('cache-control', 'public, max-age=31536000, immutable');
      },
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/assets/') || request.method !== 'GET') {
        return reply.code(404).type('application/problem+json').send(problem(404, 'Not found'));
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).type('application/problem+json').send(problem(404, 'Not found')));
  }

  ctx.maintenance.push(
    async (c) => applyDueEmploymentChanges(c.db),
    async (c) => {
      await anonymizeExpiredApplications(c.db, await retentionMonths(c.db));
    },
  );
  if (config.startWorker) {
    const stop = startWorker(ctx, app.log);
    app.addHook('onClose', async () => stop());
  }

  await app.ready();
  return app;
}
