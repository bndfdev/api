# syntax=docker/dockerfile:1

# Bondfire API — production image.
# Node 22 (see "engines" in package.json) on Debian slim for glibc, which the
# @node-rs/argon2 native addon ships prebuilt binaries for.

# ---- dependencies (production only) ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
# The app needs docs/api/dist/openapi.yaml at runtime (request validation),
# so the whole source tree is copied minus the entries in .dockerignore.
COPY --chown=node:node . .

# The node image already ships an unprivileged "node" user (uid 1000).
USER node

EXPOSE 3000

# Liveness only: does not touch MongoDB. Orchestrators should use /health/ready.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
