import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Permission } from '@openpers/shared';
import type { Principal } from './authz';
import { forbidden, unauthorized, unprocessable } from './errors';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface RouteRecord {
  method: Method;
  url: string;
  summary?: string;
  tag?: string;
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  auth: boolean;
  perm?: Permission;
}

export interface RouteDef<B extends ZodTypeAny, Q extends ZodTypeAny> {
  method: Method;
  url: string;
  summary?: string;
  tag?: string;
  /** `false` for public endpoints. Defaults to `true`. */
  auth?: boolean;
  /** Coarse permission check (without person scope). Fine-grained checks happen in the handler. */
  perm?: Permission;
  body?: B;
  query?: Q;
}

export interface RouteReq<B extends ZodTypeAny, Q extends ZodTypeAny> {
  user: Principal;
  body: z.infer<B>;
  query: z.infer<Q>;
  params: Record<string, string>;
  raw: FastifyRequest;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export function parseWith<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const res = schema.safeParse(data ?? {});
  if (!res.success) {
    throw unprocessable(
      'Validation failed',
      res.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return res.data;
}

export function makeRoute(app: FastifyInstance, registry: RouteRecord[]) {
  return function route<B extends ZodTypeAny = z.ZodAny, Q extends ZodTypeAny = z.ZodAny>(
    def: RouteDef<B, Q>,
    handler: (req: RouteReq<B, Q>, reply: FastifyReply) => Promise<unknown> | unknown,
  ) {
    const auth = def.auth ?? true;
    registry.push({ method: def.method, url: def.url, summary: def.summary, tag: def.tag, body: def.body, query: def.query, auth, perm: def.perm });
    app.route({
      method: def.method,
      url: def.url,
      handler: async (request, reply) => {
        if (auth && !request.principal) throw unauthorized();
        if (def.perm && !(request.principal!.permissions[def.perm]?.length)) throw forbidden(`Missing permission ${def.perm}`);
        const body = def.body ? parseWith(def.body, request.body) : request.body;
        const query = def.query ? parseWith(def.query, request.query) : request.query;
        const result = await handler(
          { user: request.principal!, body, query, params: request.params as Record<string, string>, raw: request },
          reply,
        );
        if (reply.sent) return reply;
        if (result === undefined) return reply.code(reply.statusCode === 200 ? 204 : reply.statusCode).send();
        return result;
      },
    });
  };
}

export type RouteFn = ReturnType<typeof makeRoute>;

/** Cursor pagination: opaque cursor encodes the offset. */
export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().optional(),
});

export function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  const n = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export function page<T>(items: T[], offset: number, limit: number) {
  const hasMore = items.length > limit;
  return {
    items: hasMore ? items.slice(0, limit) : items,
    nextCursor: hasMore ? Buffer.from(String(offset + limit)).toString('base64url') : null,
  };
}

export function buildOpenApi(registry: RouteRecord[], version: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of registry) {
    const path = r.url.replace(/:(\w+)/g, '{$1}');
    const params = [...r.url.matchAll(/:(\w+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    if (r.query) {
      const js = zodToJsonSchema(r.query, { target: 'openApi3' }) as { properties?: Record<string, unknown>; required?: string[] };
      for (const [name, schema] of Object.entries(js.properties ?? {})) {
        params.push({ name, in: 'query', required: js.required?.includes(name) ?? false, schema } as any);
      }
    }
    paths[path] ??= {};
    paths[path][r.method.toLowerCase()] = {
      summary: r.summary,
      tags: r.tag ? [r.tag] : undefined,
      security: r.auth ? [{ session: [] }, { bearer: [] }] : [],
      parameters: params.length ? params : undefined,
      requestBody: r.body ? { required: true, content: { 'application/json': { schema: zodToJsonSchema(r.body, { target: 'openApi3' }) } } } : undefined,
      responses: { default: { description: 'Response' } },
      'x-permission': r.perm,
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'OpenPers API', version, license: { name: 'AGPL-3.0' } },
    components: {
      securitySchemes: {
        session: { type: 'apiKey', in: 'cookie', name: 'op_session' },
        bearer: { type: 'http', scheme: 'bearer', description: 'API token (opk_…)' },
      },
    },
    paths,
  };
}
