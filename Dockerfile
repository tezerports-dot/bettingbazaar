# GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
# Portable container image — runs on ANY container host (AWS ECS/Fargate, GCP
# Cloud Run, Azure, Fly.io, Render, Kubernetes, self-hosted, …). All config is
# injected as environment variables at runtime (see .env.example / docs/governance/04-GOVERNANCE.md §17).
#
# AQ-5 (2026-07-13): Node 22 LTS (Node 20 reached EOL 2026-04-30), multi-stage
# (frontend toolchains never reach the runtime image), and a non-root runtime
# user (CIS Docker Benchmark; drops the blast radius of any RCE).
#
# ── Layer ordering (2026-07-28) ─────────────────────────────────────────────
# Manifests are copied and installed BEFORE application source. Docker caches
# per layer and invalidates every layer after the first change, so the previous
# `COPY . .` ahead of four `npm ci` runs meant a one-character source edit threw
# away all four dependency installs and re-downloaded them. Dependencies change
# rarely and sources change constantly, so they are now separate layers: a code
# push reuses the cached node_modules and only re-runs the builds.
#
# Each panel installs independently. They are separate npm projects with their
# own lockfiles, so a change in one does not invalidate the others.
#
# Build:  docker build -t bettingbazaar .
# Run:    docker run -p 8080:8080 --env-file .env bettingbazaar

# ── Stage 2: build the three frontends (needs devDeps: vite/tsc) ─────────────
FROM node:22-slim AS builder
WORKDIR /app
# NOT NODE_ENV=production here: npm would skip devDependencies, and vite/tsc/
# tailwind are devDependencies. The panels' own builds set their own mode.

# Dependencies first — these layers survive a source-only change.
COPY user-panel/package.json     user-panel/package-lock.json*     ./user-panel/
RUN cd user-panel     && npm ci --include=dev --legacy-peer-deps
COPY admin-panel/package.json    admin-panel/package-lock.json*    ./admin-panel/
RUN cd admin-panel    && npm ci --include=dev --legacy-peer-deps
COPY merchant-panel/package.json merchant-panel/package-lock.json* ./merchant-panel/
RUN cd merchant-panel && npm ci --include=dev --legacy-peer-deps

# Then the sources. Only these layers rebuild on a code push.
COPY user-panel     ./user-panel
COPY admin-panel    ./admin-panel
COPY merchant-panel ./merchant-panel
RUN cd user-panel     && npm run build \
 && cd ../admin-panel && npm run build \
 && cd ../merchant-panel && npm run build

# ── Stage 3: lean runtime — prod deps + backend + built dist only ────────────
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Backup tooling. `services/backup.service.js` shells out to `pg_dump`, and
# without it the daily backup degrades to a logged-and-alerted skip on every
# run — a money platform with no backups, failing quietly.
#
# The image previously carried the dump/restore binaries of the deleted
# document store and NOT this one — the wrong tool for the only datastore this
# platform has. Nothing ever called them.
#
# PINNED TO 18, from PGDG rather than Debian's default (15). `pg_dump` refuses
# to dump a server newer than itself, so a 15 client against the 18 server this
# platform runs fails with a version-mismatch error rather than a backup.
#
# Installed in the runtime stage rather than copied from a builder: `pg_dump`
# links against libpq and its transitive libraries, so letting apt resolve them
# here is what makes the binary actually runnable. The keyring and apt lists are
# removed in the SAME layer, so none of that state reaches the shipped image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends wget gnupg ca-certificates \
 && wget -qO- https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-18 \
 && apt-get purge -y --auto-remove wget gnupg \
 && rm -rf /var/lib/apt/lists/*

# Production dependencies only — no vite/tsc/vitest/tailwind in the runtime image.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --legacy-peer-deps && npm cache clean --force

# App source + built frontends (server.js serves ../dist, ../admin-panel/dist,
# ../merchant-panel/dist relative to backend/).
COPY backend ./backend
# The data layer. `#db` resolves to ./database/index.js (see package.json
# imports), so without this the container cannot start: the first `import { db }
# from '#db'` fails at module load. It was never copied, which was survivable
# only while something else answered for the data.
COPY database ./database
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
