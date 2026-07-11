# GOVERNANCE: Read 04-GOVERNANCE.md before editing this file.
# Portable container image (Phase X, 2026-07-10) — runs on ANY container host
# (AWS ECS/Fargate, GCP Cloud Run, Azure, DigitalOcean, Fly.io, Render,
# Kubernetes, self-hosted, …). No platform-specific assumptions: all config is
# injected as environment variables at runtime (see .env.example / PORTABILITY.md).
#
# Build:  docker build -t bettingbazaar .
# Run:    docker run -p 8080:8080 --env-file .env bettingbazaar
#         (or inject env vars however your platform does it — no .env required)

FROM node:20-slim

WORKDIR /app
ENV NODE_ENV=production

# Copy the whole repo (single-service deploy: backend serves the built panels).
COPY . .

# Install backend deps, build all three frontends into their dist/ folders,
# then drop the frontend build deps to keep the runtime image lean. Root
# node_modules stays (backend runtime). --legacy-peer-deps mirrors CI/nixpacks.
RUN npm install --legacy-peer-deps \
 && ./node_modules/.bin/vite build \
 && (node scripts/inject-build-id.cjs || true) \
 && (cd admin-panel    && npm install --legacy-peer-deps && ./node_modules/.bin/vite build && rm -rf node_modules) \
 && (cd merchant-panel && npm install --legacy-peer-deps && ./node_modules/.bin/vite build && rm -rf node_modules)

# The app reads PORT from the environment (defaults to 8080); EXPOSE is a hint.
EXPOSE 8080

# Container-native health check hits the public /health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Portable entrypoint — env is injected by the platform, no .env file required.
CMD ["node", "backend/server.js"]
