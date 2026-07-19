# GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
# Portable container image — runs on ANY container host (AWS ECS/Fargate, GCP
# Cloud Run, Azure, Fly.io, Render, Kubernetes, self-hosted, …). All config is
# injected as environment variables at runtime (see .env.example / PORTABILITY.md).
#
# AQ-5 (2026-07-13): Node 22 LTS (Node 20 reached EOL 2026-04-30), multi-stage
# (frontend toolchains never reach the runtime image), and a non-root runtime
# user (CIS Docker Benchmark; drops the blast radius of any RCE).
#
# Build:  docker build -t bettingbazaar .
# Run:    docker run -p 8080:8080 --env-file .env bettingbazaar

# ── Stage 1: build the three frontends (needs devDeps: vite/tsc) ──────────────
FROM node:22-slim AS builder
WORKDIR /app
ENV NODE_ENV=production
COPY . .
RUN npm ci --include=dev --legacy-peer-deps \
 && (cd user-panel     && npm ci --include=dev --legacy-peer-deps && npm run build) \
 && (cd admin-panel    && npm ci --include=dev --legacy-peer-deps && npm run build) \
 && (cd merchant-panel && npm ci --include=dev --legacy-peer-deps && npm run build)

# ── Stage 2: lean runtime — prod deps + backend + built dist only ─────────────
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# mongodb-database-tools provides `mongodump` for the daily automated backup job
# (services/backup.service.js). Official MongoDB apt repo (Debian bookworm). If
# this layer is removed, the backup job degrades to a logged+alerted skip — it
# never crashes the app.
RUN apt-get update && apt-get install -y --no-install-recommends wget gnupg ca-certificates \
 && wget -qO- https://pgp.mongodb.com/server-7.0.asc | gpg --dearmor -o /usr/share/keyrings/mongodb.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/mongodb.gpg] http://repo.mongodb.org/apt/debian bookworm/mongodb-org/7.0 main" > /etc/apt/sources.list.d/mongodb.list \
 && apt-get update && apt-get install -y --no-install-recommends mongodb-database-tools \
 && apt-get purge -y wget gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Production dependencies only — no vite/tsc/vitest/tailwind in the runtime image.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --legacy-peer-deps && npm cache clean --force

# App source + built frontends (server.js serves ../dist, ../admin-panel/dist,
# ../merchant-panel/dist relative to backend/).
COPY backend ./backend
COPY scripts ./scripts
COPY --from=builder /app/user-panel/dist      ./dist
COPY --from=builder /app/admin-panel/dist     ./admin-panel/dist
COPY --from=builder /app/merchant-panel/dist  ./merchant-panel/dist

# Runtime-writable dirs (local-disk fallback when S3 isn't configured). Created
# and handed to the non-root user so boot-time mkdir doesn't hit EACCES.
RUN mkdir -p /app/backend/app-assets /app/backend/storage \
 && chown -R node:node /app/backend/app-assets /app/backend/storage

# Drop privileges — the built-in 'node' user, never root.
USER node

# The app reads PORT from the environment (defaults to 8080); EXPOSE is a hint.
EXPOSE 8080

# Container-native health check hits the READINESS probe (AQ-4): a draining or
# dependency-down instance reports unhealthy and is routed away.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "backend/server.js"]
