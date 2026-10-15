# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage — install devDependencies, bundle to a single self-contained file.
# ---------------------------------------------------------------------------
FROM node:25-alpine AS build
WORKDIR /app

# Copy manifests first so the dependency layer caches across source-only changes.
COPY package.json package-lock.json ./
RUN npm ci

# Copy the source tree. .dockerignore keeps node_modules, dist, test, docs,
# .git, and .github out of the build context.
COPY . .

# esbuild --bundle inlines @modelcontextprotocol/sdk and its transitive deps
# (including ajv) into dist/server.mjs, so the runtime image needs no node_modules.
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime stage — dist/ only. No devDependencies, no node_modules.
# ---------------------------------------------------------------------------
FROM node:25-alpine AS runtime
WORKDIR /app

# The container binds 0.0.0.0 internally; the loopback guarantee comes from the
# host port mapping (127.0.0.1:8971:8971), not from the process. Because the
# process always sees a non-loopback bind, READYROOM_TOKEN is mandatory and the
# bind-refusal rule in src/config.ts always applies.
ENV NODE_ENV=production \
    READYROOM_STATE_DIR=/app/.state \
    READYROOM_BIND=0.0.0.0

# The bundle is self-contained (verified: it boots and serves /healthz with no
# node_modules present), so only dist/ and package.json are copied in.
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# The `node` user already exists in the official image. Give it a writable state
# dir so FileTicketStore can write tickets.json / audit.jsonl / daemon.json.
RUN mkdir -p /app/.state && chown -R node:node /app

USER node

EXPOSE 8971

# Node is PID 1 and receives SIGTERM directly; src/index.ts installs the handler
# that closes the HTTP server, the MCP transports, and the stdio transport.
CMD ["node", "dist/server.mjs"]

# Node 22 ships a global fetch, so no extra tooling is needed in the base image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8971/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
