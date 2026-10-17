# syntax=docker/dockerfile:1

# ---- build ----
FROM node:25-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:25-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
WORKDIR /app
RUN addgroup -S openpers && adduser -S openpers -G openpers && mkdir -p /data && chown openpers:openpers /data
COPY --from=build --chown=openpers:openpers /app/package.json ./
COPY --from=build --chown=openpers:openpers /app/node_modules ./node_modules
COPY --from=build --chown=openpers:openpers /app/packages ./packages
COPY --from=build --chown=openpers:openpers /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=openpers:openpers /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=openpers:openpers /app/apps/server/drizzle ./apps/server/drizzle
COPY --from=build --chown=openpers:openpers /app/apps/web/dist ./apps/web/dist
USER openpers
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "apps/server/dist/index.js"]
