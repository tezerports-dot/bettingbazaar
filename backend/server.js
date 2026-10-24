// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)


// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// FIRST, before any router exists: when BB_ROUTE_COVERAGE is set (a test
// facility, refused in production) it records which routes tests reach.
import { writeRouteInventory } from './startup/routeCoverage.js';
import express      from 'express';
import http         from 'http';
import https        from 'https';
import { Server as SocketIOServer } from 'socket.io';
import cors         from 'cors';
import compression  from 'compression';
import { eventStreamCompression, isEventStream } from './middleware/eventStreamCompression.js';
import rateLimit    from 'express-rate-limit';
// AQ-6 (Express 5): the sanitizer package this replaced reassigned the now read-only
// req.query and throws on every request under Express 5 — replaced with an
// in-place sanitizer that behaves identically on Express 4 and 5.
import { inputSanitize } from './middleware/inputSanitize.js';
import dotenv       from 'dotenv';
import path         from 'path';
import fs           from 'fs';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';

dotenv.config();

// AQ-1: refuse to boot in production without the secrets/URIs that keep the
// platform safe (missing any is fatal in prod; a loud warning otherwise).
validateEnv();

// PostgreSQL is the only datastore. There is no authority to resolve, no
// cutover to be incoherent about, and no posture to report — so the boot check
// that did all three is gone. What remains is the one thing that was always
// true underneath it: without a database there is nothing to serve, and the
// process says so rather than starting and failing per request.
if (!process.env.DATABASE_URL) {
  console.error('❌ Refusing to start: DATABASE_URL is not set. PostgreSQL is the only datastore.');
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── STARTUP MODULES ──────────────────────────────────────────────────────────
import { validateEnv }        from './startup/validateEnv.js'; // AQ-1: fail-fast env gate
import { runtimeProfile }     from './startup/runtimeRole.js';
import { connectRedis }       from './startup/redisConnect.js';
import { seedAdminAccount }   from './startup/seedAdmin.js';
import { registerCronJobs }   from './startup/cronJobs.js';
import { attachSocketHandlers } from './startup/socketHandlers.js';
import { cycleSnapshotPublisher } from './domains/markets/cycleSnapshotPublisher.js';
import { initRealtimeBridge } from './startup/realtimeBridge.js'; // Phase X: multi-instance real-time
import { registerFundingEventSubscribers } from './domains/funding/fundingEvents.js';

// ─── ROUTES ───────────────────────────────────────────────────────────────────
import authRoutes from './routes.js';
// The staff sign-in door's legs, each with the staff door's limits (§33).
import { doorRoute } from './domains/identity/loginDoors.js';
// The player sign-in door: Continue with Telegram (owner, 2026-10-14). Separate
// from `authRoutes` because its legs carry their own limits per route — see the
// mount below, and §32 S27.
import playerAuthRoutes from './domains/identity/playerAuth.routes.js';
import adminRoutes        from './routes/admin/index.js';      // ← new modular index
import betRoutes          from './domains/markets/bet.routes.js';
import cricketRoutes      from './domains/cricket/cricket.routes.js';
import { cricketOddsPublisher } from './domains/cricket/cricketOddsPublisher.js';
// The Telegram Mini App's own calls (Step 3). Public by design: the Mini App
// has no session, and `initData` — signed by the one bot's token, single-use —
// is its credential, verified per request.
import miniAppRoutes      from './domains/telegram/miniApp.routes.js';
import referralRedirect   from './routes/referralRedirect.routes.js';
import userRoutes         from './domains/user/user.routes.js';
import merchantRoutes     from './domains/merchant/merchant.routes.js';
import teamMerchantRoutes from './domains/team/team.merchant.routes.js';
import merchantAccountRoutes from './domains/merchant/merchantAccount.routes.js';
import paymentRoutes      from './domains/payment/payment.routes.js';
import supportRoutes      from './domains/support/support.routes.js'; // CAP-71: RAG support assistant
import merchantSupportRoutes from './domains/support/merchantSupport.routes.js';
import uploadRoutes       from './routes/upload.routes.js';
import retentionRoutes, { rebuildLeaderboard } from './routes/retention.routes.js';
import gameProviderRoutes from './domains/casino/gameProvider.routes.js';
import gameRegistryRoutes from './domains/gameRegistry/gameRegistry.routes.js';
import { seedGameRegistry } from './domains/gameRegistry/gameRegistry.seed.js';
import {
  httpMetrics, metricsHandler, setRealtimeStatsProvider, setSseStatsProvider, setRedisHealthProvider,
} from './services/metrics.service.js';
import { createRateLimitStore } from './middleware/redisRateLimitStore.js';
import clientTelemetryRoutes from './routes/clientTelemetry.routes.js';
import clientEndpointRoutes from './routes/clientEndpoint.routes.js';
import { startPgBouncerStats } from '#db/pgbouncerStats.js';
// Plan items 19/21/28/24/4/51 (2026-07-13): central security + network config,
// OWASP filter, service registry, storage abstraction.
import { CORS_SHAPE, RATE_LIMIT_TIERS, isPhantomBetPlacement } from './config/security.config.js';
import { refreshProviderFrameSources, startProviderFrameSourceRefresh } from './domains/casino/providerFrameSources.js';
import { securityHeaders } from './middleware/cspMiddleware.js';
import { network, canonicalRedirect, adminHostGate, adminPreflightGate, merchantHostGate } from './config/network.config.js';
import {
  attachProxyProtocolRequestMetadata,
  listenWithOptionalProxyProtocol,
} from './network/proxyProtocolV2.js';
import { owaspFilter } from './middleware/owaspFilter.js';
// Item 9 (2026-07-13): bounded concurrency / load shedding — one instance's
// safety valve (503 the excess past the admin-configured ceiling).
import { loadShed, startLoadShedConfigRefresh } from './middleware/loadShed.js';
import { registerService } from './services/serviceRegistry.js';
import { providerRegistry } from './providers/registry.js';
import { S3StorageProvider } from './providers/storage/S3StorageProvider.js';
import { LocalDiskStorageProvider } from './providers/storage/LocalDiskStorageProvider.js';
import winnersRoutes      from './routes/winners.routes.js';
import wellKnownRoutes from './routes/wellKnown.routes.js';


import { requestLogger }  from './middleware/requestLogger.js';
import { errorHandler }   from './middleware/errorHandler.js';
import { requestContext } from './middleware/requestContext.js'; // X-6: correlation ids
import { tlsFingerprintDefense, startTlsFingerprintDefenseConfigRefresh } from './middleware/tlsFingerprintDefense.js';
import { ipBlocklist, startIpBlocklistRefresh, realtimeAdmission } from './middleware/ipBlocklist.js';
import { rejectAmbiguousFraming } from './middleware/headerNormalization.js';
import { authLimiter, securityMonitor } from './middleware/security.js';
// Item 12 (2026-07-13): IP-rotation defense — per-subnet backstop + optional
// global surge breaker on sensitive endpoints, on top of the per-IP limiters.
import { startIpDefenseConfigRefresh } from './middleware/ipDefense.js';
import GameEngine         from './domains/markets/gameEngine.js';
import CycleGenerator     from './domains/markets/cycleGenerator.service.js';
import SSEManager         from './domains/notification/sseManager.service.js';
import { initSSERoutes }  from './routes/sse.routes.js';
import androidPublicRoutes from './domains/distribution/androidRelease.routes.js';
import { RELEASES_DIR, LOCAL_RELEASE_PATH } from './domains/distribution/androidRelease.shared.js';
import { getSystemConfig } from '#db/repositories/config.js';
import { db } from '#db';
import { isDatabaseReachable } from '#db/client.js';
import { mountSpaFallbacks } from './startup/spaFallbacks.js';
import { isServableOrigin } from './config/servedHosts.js';
import { installServerErrorCapture, flushErrorLog, logError } from './services/errorLog.service.js';

// ─── APP SETUP ────────────────────────────────────────────────────────────────
// Every console.error from here on is also an Admin › Error Logs entry.
installServerErrorCapture();
const runtime = runtimeProfile();
console.log(`✅ Runtime role: ${runtime.role} (api=${runtime.acceptsHttpApi}, realtime=${runtime.acceptsRealtime}, schedulers=${runtime.runsSchedulers}, workers=${runtime.runsWorkers})`);
const app = express();
app.set('trust proxy', network.trustProxy);

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'];

function corsOriginCheck(origin, callback) {
  if (!origin) return callback(null, true);
  if (process.env.NODE_ENV !== 'production') return callback(null, true);
  if (allowedOrigins.includes(origin)) return callback(null, true);
  // A host this deployment serves (DOMAINS, the API hosts, the player site, the
  // offline-signed gateway document's standby pool) is admitted as
  // https://<host>, so a standby put live by DNS alone is not refused
  // (config/servedHosts.js, docs/governance/DOMAIN_FAILOVER.md).
  return isServableOrigin(origin).then(
    (ok) => (ok ? callback(null, true) : callback(originRefused())),
    () => callback(originRefused()),
  );
}

// A refused origin is the caller's answer, not a server fault: 403 with a code,
// so errorHandler does not report it as a 500 (outside check, 2026-10-15).
function originRefused() {
  return Object.assign(new Error('This website is not allowed to call this API.'), {
    status: 403,
    code: 'ORIGIN_NOT_ALLOWED',
  });
}

const backendMtlsConfig = ['BACKEND_MTLS_CERT', 'BACKEND_MTLS_KEY', 'BACKEND_MTLS_CA'];
const configuredMtlsValues = backendMtlsConfig.filter((key) => process.env[key]);
if (configuredMtlsValues.length > 0 && configuredMtlsValues.length < backendMtlsConfig.length) {
  throw new Error(`Incomplete backend mTLS configuration; set all of: ${backendMtlsConfig.join(', ')}`);
}
const backendMtlsEnabled = configuredMtlsValues.length === backendMtlsConfig.length;
const caddyBackendMtlsConfig = ['CADDY_BACKEND_CLIENT_CERT', 'CADDY_BACKEND_CLIENT_KEY', 'BACKEND_MTLS_CA_CERT'];
const configuredCaddyMtlsValues = caddyBackendMtlsConfig.filter((key) => process.env[key]);
if (backendMtlsEnabled && configuredCaddyMtlsValues.length !== caddyBackendMtlsConfig.length) {
  throw new Error(`Backend mTLS is enabled but Caddy upstream mTLS is incomplete; set all of: ${caddyBackendMtlsConfig.join(', ')}`);
}
if (!backendMtlsEnabled && configuredCaddyMtlsValues.length > 0) {
  throw new Error('Caddy backend mTLS variables are set while backend mTLS is disabled; set BACKEND_MTLS_CERT, BACKEND_MTLS_KEY, and BACKEND_MTLS_CA or clear Caddy mTLS variables.');
}
const server = backendMtlsEnabled
  ? https.createServer({
      cert: fs.readFileSync(process.env.BACKEND_MTLS_CERT),
      key: fs.readFileSync(process.env.BACKEND_MTLS_KEY),
      ca: fs.readFileSync(process.env.BACKEND_MTLS_CA),
      requestCert: true,
      rejectUnauthorized: true,
    }, app)
  : http.createServer(app);
const io = new SocketIOServer(server, {
  // The runtime role AND the IP deny-list: an address refused on every HTTP
  // route must not open a socket either (realtimeAdmission explains).
  allowRequest: realtimeAdmission(app, runtime.acceptsRealtime),
  cors: { origin: corsOriginCheck, methods: ['GET', 'POST'], credentials: false },
  transports: ['websocket'], allowUpgrades: false, perMessageDeflate: false,
  pingTimeout: 60000, pingInterval: 25000, connectTimeout: 45000, maxHttpBufferSize: 1e6,
});
global.io = io;
let activeListener = server;




//   - Game pool broadcasts (bet_placed, cycle events)
//   - Admin room events (admin_bet_placed)


const PORT = network.port; // item 28: single parse point in config/network.config.js

// ─── GLOBAL MIDDLEWARE ────────────────────────────────────────────────────────
// Security policy lives in config/security.config.js (item 19) — values are
// identical to what was inline here before; edit THAT file to change policy.
app.use(rejectAmbiguousFraming);
app.use(attachProxyProtocolRequestMetadata);
// ── compression ─────────────────────────────────────────────────────────────
// Ordinary responses here; the event streams by their own compressor, which
// keeps one gzip context per connection and flushes after every event
// (`middleware/eventStreamCompression.js`, where the measurements are). This
// one must never touch a stream: `compression()` with no filter would gzip
// `text/event-stream` and, with nothing flushing it, hold every event until
// ~16 KB had piled up — which once made every stream silent in every browser
// while the server logged them as sent (S37).
app.use(compression({
  filter(req, res) {
    if (isEventStream(res)) return false;
    return compression.filter(req, res);
  },
}));
app.use('/api/sse', eventStreamCompression);
// The CSP's `frame-src` is read from `game_providers`, so the first read has to
// happen before a response can need it, and it has to keep happening. Not
// awaited: a database that is not up yet must not stop the server binding, and
// an empty list is `default-src 'self'` — the behaviour that shipped — which
// self-heals on the next refresh. See providerFrameSources.js, "Failing closed".
refreshProviderFrameSources();
startProviderFrameSourceRefresh();
app.use(securityHeaders);
// Item 29: optional canonical-host 301 (only when CANONICAL_HOST is set; keys
// on the requested Host only — see network.config.js).
app.use(canonicalRedirect);
// The admin panel answers only on ADMIN_HOST, and the merchant panel only on
// MERCHANT_HOST, when each is set (network.config.js).
app.use(adminHostGate);
app.use(merchantHostGate);

const corsOptions = { origin: corsOriginCheck, ...CORS_SHAPE };
// AQ-6 (Express 5 / path-to-regexp 8): bare '*' is no longer a valid route
// pattern — a catch-all wildcard must be named. '/{*splat}' matches every path
// including the root. (app.use(cors) already answers preflights; this is the
// explicit belt-and-suspenders preflight handler, kept for parity.)
// The admin API answers OPTIONS only to a real preflight from a trusted origin
// (owner, 2026-10-21); anything else there is a plain 404 with no method list.
app.use(adminPreflightGate((origin) => new Promise((resolve) => {
  corsOriginCheck(origin, (err, ok) => resolve(!err && ok === true));
})));
app.options('/{*splat}', cors(corsOptions));
app.use(cors(corsOptions));
// AQ-10: tighten the request-body limit. It was 10mb on EVERY route — a large
// DoS surface (each request could pin 10mb of memory + parse time). Uploads in
// this app use presigned S3 URLs (client → S3 directly), so almost no route
// legitimately posts a big JSON body. The one exception is the admin base64
// app-asset upload, which gets a scoped larger parser; everything else is tight.
const JSON_LIMIT = process.env.JSON_BODY_LIMIT || '1mb';
const _tightJson = express.json({ limit: JSON_LIMIT });
const _assetJson = express.json({ limit: process.env.ASSET_JSON_LIMIT || '8mb' });
const _ASSET_UPLOAD_PATHS = new Set(['/api/admin/app-assets/upload']);
// ── The provider wallet callback needs the bytes it was signed over ────────
// Its HMAC is computed over the request BODY, and a digest taken over a
// re-serialisation of the parsed body only matches when our serialiser happens
// to agree with the provider's — key order, whitespace, unicode escaping.
// `verify` stashes the exact buffer so the signature can be checked against it
// (webhookSignature.js accepts either, so nothing that verified before stops).
//
// SCOPED to that path on purpose. Keeping a raw copy of every request body
// doubles what a 1 MB upload holds in memory, for a check only one route makes.
const _RAW_BODY_PREFIX = '/api/game/wallet/';
const _rawJson = express.json({
  limit: JSON_LIMIT,
  verify: (req, _res, buf) => { req.rawBody = buf; },
});
app.use((req, res, next) => {
  if (req.path.startsWith(_RAW_BODY_PREFIX)) return _rawJson(req, res, next);
  return (_ASSET_UPLOAD_PATHS.has(req.path) ? _assetJson : _tightJson)(req, res, next);
});
// NO urlencoded body parser — deliberately. No session rides in a cookie
// (routes.js `extractToken`: the Authorization header only, owner 2026-10-21),
// so a page on another site cannot act for a signed-in account at all; keeping
// the parser off also keeps every "simple request" body (urlencoded, multipart,
// text/plain) unparsed, so a cross-site <form> reaches no handler with fields.
// If a provider callback ever needs form encoding, mount a urlencoded parser ON
// THAT ROUTE ONLY, never globally, and require a signature on it.
app.use(inputSanitize);
app.use(cookieParser());
app.use(requestContext); // X-6: correlation id (before the logger, so it's logged)
app.use(tlsFingerprintDefense); // JA3/TLS fingerprint policy from admin-managed SystemConfig
app.use(requestLogger);
// The admin IP deny-list. BEFORE securityMonitor, the load shedder and every
// limiter, so a blocked address costs one in-memory lookup and one log line —
// mounted after securityMonitor, each refusal would become an audit ROW, and a
// blocked client hammering the API would be turned into database writes.
app.use(ipBlocklist);
// Every 401 and 403 into the audit trail, with the attempted mobile on the
// admin and login paths. It was written, exported and mounted NOWHERE, so a
// burst of failed admin logins left no durable record anywhere — the one
// signal a credential-stuffing attempt against a money platform produces.
// Mounted after requestContext so each row carries the correlation id, and it
// calls the original res.json through, so it observes rather than intercepts.
app.use(securityMonitor);
app.use(httpMetrics);    // item 33: Prometheus HTTP duration/count (bounded route labels)
// Item 9: bound in-flight work at the edge — 503 the excess so overload can't
// starve the event loop mid-transaction. Mounted BEFORE routers so rejection is
// cheap; health/metrics/SSE are exempt (see loadShed.js). Config refresh is
// started here (reads SystemConfig.loadShedding every 30s; env is the fallback).
app.use(loadShed);
startLoadShedConfigRefresh();

// GET /metrics — Prometheus scrape endpoint (item 33). If METRICS_TOKEN is set,
// require it as a Bearer token so the endpoint isn't public; unset = open
// (single-service/dev). Registered BEFORE the API rate limiter — scrapers poll
// frequently and must not consume the user budget.
function authorisedMetrics(req, res) {
  const token = process.env.METRICS_TOKEN;
  if (!token && process.env.NODE_ENV === 'production') {
    return res.status(503).end('metrics token not configured');
  }
  if (!token || req.headers.authorization !== `Bearer ${token}`) {
    return res.status(401).end('unauthorized');
  }
  return metricsHandler(req, res);
}
app.get('/metrics', authorisedMetrics);
// bb_pgbouncer_pool on /metrics when PGBOUNCER_STATS_URL is set (production compose).
startPgBouncerStats();

// PM2 cluster mode: on the shared port, /metrics answers from whichever worker
// the connection lands on. METRICS_PORT_BASE gives each worker its own scrape
// port (base + NODE_APP_INSTANCE) on the private network — never published —
// behind the same token, so a scraper sees every worker.
const METRICS_PORT_BASE = Number(process.env.METRICS_PORT_BASE || 0);
if (METRICS_PORT_BASE > 0) {
  const metricsPort = METRICS_PORT_BASE + Number(process.env.NODE_APP_INSTANCE || 0);
  const metricsApp = express();
  metricsApp.disable('x-powered-by');
  metricsApp.get('/metrics', authorisedMetrics);
  const metricsServer = http.createServer(metricsApp);
  metricsServer.on('error', (e) => console.error(`[metrics] worker scrape port ${metricsPort} failed:`, e.message));
  metricsServer.listen(metricsPort, '0.0.0.0', () => console.log(`📈 Worker metrics on :${metricsPort}`));
  metricsServer.unref();
}
// Phantom managers fire many equalizer (ghost) bets in quick succession to
// balance the display pool, so their placements must NOT be throttled. Exempt
// POST /api/bet/phantom from the global backstop: the route is already gated
// (authenticate + phantomAccess → 403 for everyone else) and loadShed still
// bounds total in-flight work, so this removes no real DoS protection.
// (The isPhantomBetPlacement predicate lives in config/security.config.js.)
app.use('/api/', rateLimit({
  ...RATE_LIMIT_TIERS.global, standardHeaders: true, legacyHeaders: false,
  // Shared across PM2 workers and containers (§36): a per-process counter is
  // N× looser with N workers.
  store: createRateLimitStore('rl:global:'),
  skip: isPhantomBetPlacement,
  message: { success: false, message: 'Too many requests. Please try again later.' }
}));
// Item 24: OWASP-pattern request filter — flag-gated (FLAGS.WAF_FILTER,
// default OFF). Mounted after body parsing so it can scan JSON bodies.
app.use('/api/', owaspFilter);

// ─── STATIC FILES ─────────────────────────────────────────────────────────────
const appAssetsDir = path.join(__dirname, 'app-assets');
fs.mkdirSync(appAssetsDir, { recursive: true });
const isSafeAppAssetSlot = (slot) => /^[a-z0-9][a-z0-9-]*\.png$/.test(slot);
// Slots retain .png names for stable PWA URLs, but uploads may be JPEG, WebP,
// or GIF. Serve the stored, byte-detected AppAsset content type rather than
// allowing the filename extension to select an incorrect MIME type.
app.get('/app-assets/:name', async (req, res, next) => {
  try {
    if (!isSafeAppAssetSlot(req.params.name)) return res.sendStatus(404);
    const asset = await db.content.getAsset(req.params.name);
    const filePath = path.join(appAssetsDir, req.params.name);
    // Only a LOCAL asset is served from this directory. One stored on the CDN
    // has its bytes somewhere else entirely, and sending a local file under its
    // content type would serve whatever happened to be left on this disk.
    if (!asset) return next();
    // Stored in the bucket: the bytes are not on this disk, so falling through
    // answered 404 for every uploaded slot in production (S3 is mandatory
    // there). Send the reader to where the bytes are. The URL is the one
    // uploadBufferToS3 returned — derived by the server, never from a request.
    // The stored key never changes across re-uploads (`app-assets/<slot>`), and
    // the storage tells browsers to keep it an hour, so the redirect names the
    // upload's time: a new upload is a new address and shows at once.
    if (asset.storage !== 'LOCAL') {
      res.set('Cache-Control', 'no-cache');
      const version = new Date(asset.updatedAt).getTime();
      const sep = asset.url.includes('?') ? '&' : '?';
      return res.redirect(302, Number.isFinite(version) ? `${asset.url}${sep}t=${version}` : asset.url);
    }
    if (!asset.contentType) return next();
    res.type(asset.contentType);
    return res.sendFile(filePath, (error) => {
      if (error?.code === 'ENOENT') return next();
      if (error) return next(error);
    });
  } catch (error) {
    return next(error);
  }
});
app.use('/app-assets', express.static(appAssetsDir, { maxAge: '1h' }));
// Item 51: local-disk StorageProvider serves from backend/storage/ (S3 deploys
// never write here — the S3 provider returns CDN/S3 URLs instead).
app.use('/storage', express.static(path.join(__dirname, 'storage'), { maxAge: '1h' }));
// Development only: APKs uploaded while S3 is not configured. Each file name
// carries its version and hash, so a long cache cannot serve a stale build.
app.use(LOCAL_RELEASE_PATH, express.static(RELEASES_DIR, { maxAge: '7d', immutable: true }));

// ─── SERVICE + PROVIDER REGISTRATION (items 4 + 51) ──────────────────────────
// Storage: S3 when configured (multi-instance-safe), local disk otherwise.
const _s3Store = new S3StorageProvider();
const _localStore = new LocalDiskStorageProvider();
if (process.env.NODE_ENV === 'production' && !_s3Store.isAvailable()) {
  throw new Error('FATAL: production storage requires a fully configured S3-compatible provider; refusing local-disk fallback.');
}
providerRegistry.storage.register(_s3Store);
providerRegistry.storage.register(_localStore);
registerService('storage', _s3Store.isAvailable() ? _s3Store : _localStore);
// Cross-cutting services — look up by name where hard-coupling is undesirable.
registerService('metrics',  { handler: metricsHandler });
registerService('alerting', { send: (...a) => import('./services/alerting.service.js').then(m => m.sendAlert(...a)) });
// §14 GOVERNANCE: user panel static must NOT bleed into /admin or /merchant.
// Serving dist/ at root '/' caused user panel index.css (which @imports
// glassmorphism.css with .glass-overlay { position:fixed; inset:0 }) to load
// inside admin and merchant panels — creating a full-screen transparent overlay
// that blocked all clicks on those panels.
// Referral links: /r/<code> → whichever sign-up bot is live right now.
//
// Mounted HERE, above the static middleware and far above the SPA catch-all,
// because both of those would otherwise answer /r/<code> with index.html. This
// is a redirect, not a page — the visitor must never see the app shell.
app.use('/', referralRedirect);

// Android reads /.well-known/assetlinks.json to decide whether this origin
// really vouches for the APK claiming its links. Mounted above the static
// middleware and the SPA catch-all for the same reason as the redirect above:
// the catch-all would answer it with JSON that is not a Digital Asset Links
// document, and a malformed answer is indistinguishable from a hostile one as
// far as App Link verification is concerned — it just fails.
app.use('/.well-known', wellKnownRoutes);

// The player app's hashed bundles, cached for good like the other panels'
// below: a changed file gets a new name. Without it every open (the Telegram
// Mini App most of all, which no service worker serves) asked the server again
// for each file before it could render.
app.use('/assets', express.static(path.join(__dirname, '../dist/assets'), {
  maxAge: '1y', immutable: true, fallthrough: false,
}));

app.use('/', (req, res, next) => {
  if (req.path.startsWith('/admin') || req.path.startsWith('/merchant') || req.path.startsWith('/api')) {
    return next(); // never serve user panel assets to other panels
  }
  express.static(path.join(__dirname, '../dist'))(req, res, next);
});

const adminDistPath = path.join(__dirname, '../admin-panel/dist');
if (fs.existsSync(adminDistPath)) {
  app.use('/admin/assets', express.static(path.join(adminDistPath, 'assets'), {
    maxAge: '1y', immutable: true,
    setHeaders: (res, fp) => {
      if (fp.endsWith('.js'))  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      if (fp.endsWith('.css')) res.setHeader('Content-Type', 'text/css; charset=utf-8');
    }
  }));
  app.use('/admin', express.static(adminDistPath, { index: false }));
}

const merchantDistPath = path.join(__dirname, '../merchant-panel/dist');
if (fs.existsSync(merchantDistPath)) {
  app.use('/merchant/assets', express.static(path.join(merchantDistPath, 'assets'), {
    maxAge: '1y', immutable: true,
    setHeaders: (res, fp) => {
      if (fp.endsWith('.js'))  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      if (fp.endsWith('.css')) res.setHeader('Content-Type', 'text/css; charset=utf-8');
    }
  }));
  app.use('/merchant', express.static(merchantDistPath, { index: false }));
}

// ─── HEALTH / PROBES (AQ-4) ─────────────────────────────────────────────────
// Kubernetes-correct probe split (also drives Railway/Docker healthchecks):
//   LIVENESS  = "is the process alive?" — NEVER depends on external deps. A
//               database outage must NOT make the orchestrator kill and restart
//               every pod (that turns a dependency blip into a full outage).
//   READINESS = "should this instance receive traffic?" — deps up AND not
//               draining. Flipping this to 503 on SIGTERM is how we bleed
//               traffic off an instance before it stops accepting connections.
let shuttingDown = false;

async function readinessState() {
  // A REAL round trip, not a connection-state flag. A pool with an open socket
  // to a database that has stopped answering reports "connected" — and a
  // readiness probe that stays green through an outage is worse than no probe,
  // because it keeps the load balancer sending traffic to an instance that
  // cannot serve it.
  const databaseUp = await isDatabaseReachable();
  return {
    ready: databaseUp && !shuttingDown,
    database: databaseUp ? 'connected' : 'disconnected',
    redis: global.redis ? 'connected' : 'unavailable',
    draining: shuttingDown,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  };
}

// Liveness — process-only, dependency-free. 503 only while draining so the
// orchestrator stops restarting a pod we're deliberately shutting down.
app.get('/health/live', (req, res) => {
  res.status(shuttingDown ? 503 : 200).json({ status: shuttingDown ? 'draining' : 'alive', uptime: process.uptime() });
});
// Readiness — deps + drain aware.
app.get('/health/ready', async (req, res) => {
  // AWAITED. The probe is a real round trip now, and calling it without
  // awaiting returns a pending Promise whose `.ready` is undefined — so every
  // readiness check would answer 503 and the orchestrator would take every
  // instance out of rotation.
  const s = await readinessState();
  res.status(s.ready ? 200 : 503).json({ status: s.ready ? 'ready' : 'not-ready', ...s });
});
// Back-compat: /health and /api/v1/health keep readiness semantics (Railway's
// healthcheckPath and the Docker HEALTHCHECK point here). Now also 503 while
// draining so deploys route away from an instance that's shutting down.
async function legacyHealth(req, res) {
  const s = await readinessState();
  res.status(s.ready ? 200 : 503).json({ status: s.ready ? 'healthy' : 'unhealthy', ...s });
}
app.get('/health', legacyHealth);
app.get('/api/v1/health', legacyHealth);

// ─── API ROUTES ───────────────────────────────────────────────────────────────
// Item 12: chain order is per-IP → per-subnet → (optional) global surge, then
// the routes. Per-IP catches the single abuser fastest; the subnet limiter
// catches an attacker rotating IPs within one block; the surge breaker (off
// until an admin sets a ceiling) catches distributed rotation across subnets.
if (runtime.acceptsHttpApi) {
startIpDefenseConfigRefresh();
// ── The player sign-in door (Continue with Telegram) ────────────────────────
// Mounted BEFORE the session router so its own routes are matched first.
//
// Each leg's limits are INSIDE this router, per route (loginDoors.js), rather
// than on this mount: a chain on the mount would make a poll consume another
// leg's budget (§32 S27).
app.use('/api/v1/auth', playerAuthRoutes);
// Session lifecycle: /me, /logout, /health. No captcha here — every page load
// calls /me to restore the session, so gating this router would 403 every user
// on every load.
//
// And no SUBNET limiter or surge breaker either, for the same reason and a
// sharper one. Both counted every request, success included, at 4 x 8 = 32 per
// /24 per 30 minutes — which is a handful of page loads. Measured on a running
// server: `GET /me` answered 429 from an address that had submitted no
// credential. Most Indian mobile traffic sits behind carrier-grade NAT, so a
// /24 is thousands of people, and one of them reloading a page would have
// signed the rest of them out. Both now sit on the credential ROUTES, in
// playerAuth.routes.js, which is the only place either can do its job.
app.use('/api/v1/auth', authLimiter, authRoutes);
app.use('/api', winnersRoutes);

// ── The staff sign-in door (§33) ─────────────────────────────────────────────
// Password, then an authenticator code (owner, 2026-10-13; no Telegram). The
// password leg is paced FIRST (a paced request is not a failed attempt), then
// the admin failure budget and the subnet limiter; the code legs on the
// second-factor budget, keyed on the account (loginDoors.js).
app.post('/api/admin/login', ...doorRoute('STAFF', 'login'));
app.post('/api/admin/login/totp', ...doorRoute('STAFF', 'totp'));
app.post('/api/admin/login/totp/setup', ...doorRoute('STAFF', 'totpSetup'));
app.post('/api/admin/login/totp/activate', ...doorRoute('STAFF', 'totpActivate'));

app.use('/api/admin', adminRoutes);   // ← now routes/admin/index.js (13 sub-routers)

// Public error report endpoint (no JWT — panel may be mid-crash)
const errorReportLimiter = rateLimit({ windowMs: 60000, max: 10, store: createRateLimitStore('rl:errorreport:'), message: { success: false, message: 'Too many error reports' } });

// How player apps found their API origin (discovery, failover) — counters only.
app.use('/api', clientTelemetryRoutes);
// Where player apps should connect (Admin > Settings > API Host) — discovery's answer.
app.use('/api', clientEndpointRoutes);
// A panel's report: which panel, what kind of failure. The severity is the
// server's, from the kind, never the caller's (owner, 2026-10-20).
const PANEL_SOURCES = { user: 'PLAYER_APP', merchant: 'MERCHANT_PANEL', admin: 'ADMIN_PANEL' };
const PANEL_KINDS = {
  crash:   { category: 'SCREEN_CRASH', severity: 'CRITICAL' },
  error:   { category: 'SCRIPT',       severity: 'WARNING' },
  promise: { category: 'PROMISE',      severity: 'MINOR' },
  update:  { category: 'UPDATE_LOAD',  severity: 'MINOR' },
};
app.post('/api/internal/error-report', errorReportLimiter, (req, res) => {
  const { message, stack, component, url, panel, kind } = req.body ?? {};
  if (!message || typeof message !== 'string') return res.status(400).json({ success: false, message: 'message required' });
  const source = PANEL_SOURCES[panel];
  if (!source) return res.status(400).json({ success: false, message: 'panel must be user, merchant or admin' });
  // A chunk that failed to load is a stale page after a deploy, whatever the panel called it.
  const how = /dynamically imported module|Loading chunk|Importing a module script failed/i.test(message)
    ? PANEL_KINDS.update : (PANEL_KINDS[kind] ?? PANEL_KINDS.crash);
  logError({
    source, ...how, message,
    detail: typeof stack === 'string' ? stack : null,
    component: typeof component === 'string' ? component : null,
    location: typeof url === 'string' ? url : null,
  });
  res.json({ success: true });
});

// /api/download/android and /api/app/android/update — the uploaded, published
// APK is the one owner of where the Android app lives (androidReleases, §2).
app.use('/api', androidPublicRoutes);
app.get('/api/download/ios', async (req, res) => {
  try {
    const config = await getSystemConfig();
    if (config?.iosUrl) return res.redirect(302, config.iosUrl);
    res.status(404).json({ success: false, message: 'Use Safari → Add to Home Screen for iOS.' });
  } catch { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.use('/api/game',      gameProviderRoutes);
// Game Registry (catalogue metadata + categories). Same base path; its routes
// (/games, /categories, /admin/games, /admin/categories) don't collide with the
// provider router's (/providers, /launch, /admin/game-providers).
app.use('/api/game',      gameRegistryRoutes);
app.use('/api/telegram',  miniAppRoutes);
app.use('/api/bet',       betRoutes);
app.use('/api/v1/cricket', cricketRoutes);
app.use('/api',           userRoutes);
// The merchant sign-in door's limits are ON its routes (merchant.routes.js,
// loginDoors.js), never on a path prefix (§32 S28).

// Merchants have no signup form: a merchant applies by Continue with Telegram,
// whose Mini App approve makes the application (owner, 2026-10-14).
app.use('/api/merchant/support', merchantSupportRoutes); // the merchants' own support desk
app.use('/api/merchant',  merchantRoutes);
app.use('/api/merchant',  teamMerchantRoutes);
app.use('/api/merchant',  merchantAccountRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/support',   supportRoutes); // the player's support desk, and the RAG assistant (dormant until keys set)
app.use('/api',           uploadRoutes);
app.use('/api',           retentionRoutes);
// Referral and VIP were removed from the platform on 2026-07-30 (owner
// decision). No /api/referral or /api/vip routes exist; the models, the
// referral commission and the panel pages went with them.
} else {
  app.use('/api', (_req, res) => res.status(404).json({ success: false, message: `API disabled on ${runtime.role} runtime role` }));
}

// ─── GAME ENGINE + SSE ───────────────────────────────────────────────────────
const sseManager     = new SSEManager();
const gameEngine     = new GameEngine(io);
const cycleGenerator = new CycleGenerator(io, sseManager);

// NOT started here. They start below, once the PostgreSQL chain has applied
// the schema — beside the cron jobs, which always waited for it. Started at
// module load they raced `applySchema()`: on a fresh database the generator's
// first ticks hit `relation "cycles" does not exist`, and on an existing one
// PostgreSQL logged a DEADLOCK between the generator's read and the schema
// apply's AccessExclusiveLock (measured 2026-10-01). The settlement engine was
// started the same way, against whatever half of the schema had landed.
if (!runtime.runsSchedulers) {
  console.log(`⏸️ Runtime role ${runtime.role}: game engine and cycle scheduler are not started.`);
}

global.sseManager = sseManager;
if (runtime.acceptsRealtime) {
  app.use('/api/sse', initSSERoutes(sseManager, cycleGenerator));
  attachSocketHandlers(io);

  // Expose realtime delivery gauges on /metrics (connected sockets + publisher
  // stats). Event-loop lag is already a default metric. IoC so metrics.service
  // imports neither io nor the publisher.
  setSseStatsProvider(() => sseManager.getStats());
  setRealtimeStatsProvider(() => ({
    connectedSockets: io?.engine?.clientsCount ?? 0,
    ...cycleSnapshotPublisher.stats(),
  }));

} else {
  app.use('/api/sse', (_req, res) => res.status(404).json({ success: false, message: 'Realtime disabled on this API role' }));
}

// The live pool feed: coalesce per-bet pool totals into ≤1 snapshot/sec/cycle.
// Started in EVERY role, not only the realtime one: players' bets are placed
// on the api role and auto phantom bets by the scheduler, and a publisher that
// was never started held their totals forever, so players saw the pool move
// only when a page reload re-read it (fixed 2026-10-15). A role with no
// streams of its own hands its snapshots to the realtime workers through
// `sseManager.sharePeer` (the Redis bridge below), and they send them on.
cycleSnapshotPublisher.attach({ io, sseManager }).start();
cricketOddsPublisher.start();

// Cross-instance real-time bridge (Phase X): fan out socket.io + SSE events
// across all instances via Redis. No-op without REDIS_URL. EVERY role joins
// it, not only the realtime one: the scheduler produces the cycle lifecycle
// and the api role produces bet_placed / balance_update / order_update, and
// without the bridge those emits reached only the producer's own (empty)
// io and SSE — measured 2026-10-09 with the role split: 0 of 2,000 clients
// saw a cycle_phase until this moved out of the realtime-only block.
initRealtimeBridge(io, sseManager);

// ─── SPA FALLBACKS ───────────────────────────────────────────────────────────
// startup/spaFallbacks.js: each panel's index.html, its root included.
mountSpaFallbacks(app, path.join(__dirname, '..'));
app.use((req, res) => {
  if (path.extname(req.path)) return res.status(404).send('Not found');
  res.status(404).json({ success: false, message: 'Route not found' });
});
app.use(errorHandler);
app.set('io', io);

// ─── START ────────────────────────────────────────────────────────────────────
// Open the listener FIRST, before the datastore is up.
//
// This used to live inside the .then() of the Promise.allSettled below, so the
// port did not open until the database connection settled. A database that is
// merely slow to accept connections — a service still starting, the normal case
// on a fresh Railway/compose deploy — kept the process from binding for minutes.
// Every probe in that window got ECONNREFUSED rather than an answer, which is
// precisely what Railway's healthcheck (healthcheckPath=/health,
// healthcheckTimeout=60) reads as "this deploy is dead", and
// restartPolicyMaxRetries then repeats the whole cycle.
//
// The readiness endpoints above were already written for this: /health and
// /health/ready return 503 until the connection is live. They just could not be
// reached, because nothing was listening. With the listener open from the start,
// an orchestrator gets an honest "not ready yet" it can wait on, and a real
// answer the moment the database attaches.
//
// Serving before the database is up is safe: readiness fails, so a load balancer
// does not route to this instance, and any request that does arrive fails the
// same way it would have anyway. Nothing below depends on the datastore — the
// cron jobs and event subscribers that DO are still registered in the .then().
activeListener = listenWithOptionalProxyProtocol(server, {
  port: PORT,
  host: '0.0.0.0',
  enabled: network.proxyProtocolV2.enabled,
  trustedSubnets: network.proxyProtocolV2.trustedSubnets,
}).on('listening', () => {
  console.log(`✅ Server listening on port ${PORT} (readiness pending until datastores attach)`);
  writeRouteInventory(app);
}).on('error', (error) => {
  // Without this listener a bind failure is an unhandled 'error' event, which
  // Node turns into a raw stack trace and a hard exit. Exiting IS correct — the
  // process cannot serve traffic — but the operator got
  // "throw er; // Unhandled 'error' event" instead of the reason.
  //
  // EADDRINUSE is the case that actually happens: a rolling deploy where the
  // previous container has not released the port yet, or two instances sharing
  // a PORT by misconfiguration. With restartPolicyMaxRetries that crash-loops,
  // and the logs never say which port or why.
  if (error.code === 'EADDRINUSE') {
    console.error(`❌ FATAL: port ${PORT} is already in use. Another instance is bound to it, ` +
      `or PORT collides with a sibling service. Nothing else can be diagnosed from here.`);
  } else if (error.code === 'EACCES') {
    console.error(`❌ FATAL: not permitted to bind port ${PORT}. Ports below 1024 need elevated privileges.`);
  } else {
    console.error(`❌ FATAL: could not bind port ${PORT}: ${error.code || ''} ${error.message}`);
  }
  process.exit(1);
});

Promise.allSettled([
  // PostgreSQL is the only datastore, so applying its schema is the FIRST thing
  // that must succeed and everything else in this chain depends on it. It is
  // deliberately NOT wrapped in a .catch that logs and continues: this used to
  // be a side entry that swallowed its own failure, because the platform still
  // had a second store to fall back on. It has none. A failed schema apply now
  // fails startup, which is the only honest outcome — the alternative is a
  // process that binds a port, passes nothing, and serves every request an
  // error about a table that was never created.
  import('#db/client.js')
    .then((m) => m.applySchema())
    // Once more now the tables exist. The call at the top of this file runs
    // before the schema on a fresh database and fails closed (logged); without
    // this the frame-src waited for the 60-second timer.
    .then(() => refreshProviderFrameSources())
    .then(() => seedAdminAccount())
    .then(() => seedGameRegistry())
    .then(() => startTlsFingerprintDefenseConfigRefresh())
    // The deny-list loads here, awaited: a server that cannot read it fails
    // startup rather than serving as if nothing were blocked.
    .then(() => startIpBlocklistRefresh()),
  connectRedis().then(r => {
    global.redis = r;
    if (r) setRedisHealthProvider(() => r.status === 'ready');
  }),
  // CAP-71: RAG vector store. Apply the pgvector schema ONLY when RAG retrieval
  // is actually configured (DATABASE_URL + embedding provider key) — so a
  // money-only Postgres without the pgvector extension is never touched.
  import('./domains/support/ragService.js')
    .then(m => (m.retrievalReady() ? import('#db/repositories/supportDocuments.js').then(s => s.initSchema()) : null))
    .catch(e => console.error('[rag] schema init skipped:', e.message)),
  // CAP-74: attach the external event backbone (Kafka) when KAFKA_BROKERS is set.
  // No-op otherwise — the monolith keeps using the in-process bus only.
  import('./services/eventBackbone.js').then(m => m.configureFromEnv()).catch(e => console.error('[backbone] configure failed:', e.message)),
]).then((results) => {
  if (results[0].status === 'rejected') {
    // The listener is already open by this point, so failing startup has to
    // close it — leaving it bound would keep the process alive and advertise a
    // port that will never become ready.
    // results[0] is the PostgreSQL chain: schema, admin seed, game registry,
    // TLS policy, IP deny-list. Any of them failing means this instance cannot serve.
    console.error('❌ Startup failed while preparing PostgreSQL:', results[0].reason);
    process.exitCode = 1;
    try { activeListener?.close(); } catch { /* nothing to close */ }
    return;
  }
  console.log('✅ DB services initialized');
  // PM2 (`wait_ready`): this worker is serving. A rolling reload waits for it
  // before stopping the next old worker, so capacity never drops to zero.
  if (typeof process.send === 'function') process.send('ready');
  // Players online, sampled each minute where their streams are (owner,
  // 2026-10-22: peak concurrent users on the owner's dashboard).
  if (runtime.acceptsRealtime) {
    import('./domains/analytics/presenceSampler.js')
      .then((m) => m.startPresenceSampler(() => sseManager.userClients.size))
      .catch((e) => console.error('[presence] sampler not started:', e.message));
  }
  if (runtime.runsSchedulers) {
    gameEngine.start();
    cycleGenerator.start();
    registerCronJobs(rebuildLeaderboard);
  } else {
    console.log(`⏸️ Runtime role ${runtime.role}: cron jobs are not registered.`);
  }
  registerFundingEventSubscribers(); // Funding Platform (Phase 009) — eventBus wiring
});

// AQ-4: real graceful drain. Order matters — fail readiness FIRST so the load
// balancer stops sending new work, wait a beat for it to notice, THEN stop
// accepting connections and let in-flight requests finish before closing the
// datastores. The previous version never called server.close(), so the listener
// kept accepting new requests through the whole grace window and then killed
// them mid-flight on process.exit — rolling deploys dropped requests.
async function closeResources() {
  try { cricketOddsPublisher.stop(); } catch (_) {}
  import('./domains/analytics/presenceSampler.js').then((m) => m.stopPresenceSampler()).catch(() => {});
  try { cycleSnapshotPublisher.stop(); } catch (_) {}                            // stop the 1s snapshot timer
  await Promise.allSettled([
    import('./services/jobQueue.service.js').then(m => m.closeJobQueue()),      // 17+56: finish/close queue
    import('./services/eventBackbone.js').then(m => m.resetBackbone()),         // CAP-74: disconnect Kafka producer
    import('#db/client.js').then(m => m.closePg()),                    // hybrid money DB: drain PG pool
    import('./services/workerPool.service.js').then(m => m.closeWorkerPool()),  // item 5: terminate CPU threads
  ]);
  try { global.redis?.disconnect?.(); } catch (_) {}
}

let _shuttingDownStarted = false;
const _shutdown = (sig) => {
  if (_shuttingDownStarted) return;
  _shuttingDownStarted = true;
  shuttingDown = true; // readiness now returns 503 → LBs drain this instance
  console.log(`[${sig}] Graceful shutdown — readiness failing; stopping producers.`);

  // Stop background producers immediately (no new cycles/settlement work).
  try { gameEngine?.stop(); } catch (_) {}
  try { cycleGenerator?.stop(); } catch (_) {}
  void flushErrorLog();

  const DRAIN_DELAY_MS = Number(process.env.SHUTDOWN_DRAIN_MS || 5000);
  const DEADLINE_MS    = Number(process.env.SHUTDOWN_DEADLINE_MS || 25000);

  // Absolute backstop: long-lived connections (SSE) never end on their own, so
  // guarantee the process exits even if drain can't complete.
  const hardExit = setTimeout(() => {
    console.error('[shutdown] hard deadline reached — forcing exit.');
    try { server.closeAllConnections?.(); } catch (_) {}
    process.exit(0);
  }, DEADLINE_MS);
  hardExit.unref?.();

  // Give the LB DRAIN_DELAY_MS to observe readiness=503 before we stop accepting.
  setTimeout(() => {
    try { server.closeIdleConnections?.(); } catch (_) {} // release idle keep-alives now
    const finishShutdown = async () => {
      console.log('[shutdown] listener closed; in-flight drained — closing datastores.');
      await closeResources();
      clearTimeout(hardExit);
      console.log('[shutdown] complete.');
      process.exit(0);
    };
    activeListener.close(() => {
      if (activeListener === server) return finishShutdown();
      return server.close(finishShutdown);
    });
    // Nudge lingering long-lived connections (e.g. SSE) toward closing.
    setTimeout(() => { try { server.closeAllConnections?.(); } catch (_) {} }, Math.max(0, DEADLINE_MS - DRAIN_DELAY_MS - 2000)).unref?.();
  }, DRAIN_DELAY_MS);
};
process.on('SIGTERM', () => _shutdown('SIGTERM'));
process.on('SIGINT',  () => _shutdown('SIGINT'));

export default app;
