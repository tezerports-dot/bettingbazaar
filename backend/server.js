// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)


// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import express      from 'express';
import mongoose     from 'mongoose';
import http         from 'http';
import https        from 'https';
import { Server as SocketIOServer } from 'socket.io';
import cors         from 'cors';
import helmet       from 'helmet';
import compression  from 'compression';
import rateLimit    from 'express-rate-limit';
// AQ-6 (Express 5): express-mongo-sanitize@2 reassigns the now read-only
// req.query and throws on every request under Express 5 — replaced with an
// in-place sanitizer that behaves identically on Express 4 and 5.
import { mongoSanitize } from './middleware/mongoSanitize.js';
import dotenv       from 'dotenv';
import path         from 'path';
import fs           from 'fs';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';

dotenv.config();

// AQ-1: refuse to boot in production without the secrets/URIs that keep the
// platform safe (missing any is fatal in prod; a loud warning otherwise).
validateEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── STARTUP MODULES ──────────────────────────────────────────────────────────
import { validateEnv }        from './startup/validateEnv.js'; // AQ-1: fail-fast env gate
import { connectMongoDB }     from './startup/mongoConnect.js';
import { connectRedis }       from './startup/redisConnect.js';
import { seedAdminAccount }   from './startup/seedAdmin.js';
import { registerCronJobs }   from './startup/cronJobs.js';
import { attachSocketHandlers } from './startup/socketHandlers.js';
import { initRealtimeBridge } from './startup/realtimeBridge.js'; // Phase X: multi-instance real-time
import { registerFundingEventSubscribers } from './domains/funding/fundingEvents.js';

// ─── MODELS (must load before any route that calls mongoose.model()) ──────────
import './models/index.js';

// ─── ROUTES ───────────────────────────────────────────────────────────────────
import authRoutes, { loginHandler } from './routes.js';
import adminRoutes        from './routes/admin/index.js';      // ← new modular index
import betRoutes          from './domains/markets/bet.routes.js';
import userRoutes         from './domains/user/user.routes.js';
import merchantRoutes     from './domains/merchant/merchant.routes.js';
import paymentRoutes      from './domains/payment/payment.routes.js';
import supportRoutes      from './domains/support/support.routes.js'; // CAP-71: RAG support assistant
import uploadRoutes       from './routes/upload.routes.js';
import referralRoutes     from './routes/referral.routes.js';
import paymentCfgRoutes   from './routes/payment-config.routes.js';
import giftCodeRoutes     from './routes/giftcode.routes.js';
import retentionRoutes, { rebuildLeaderboard } from './routes/retention.routes.js';
import gameProviderRoutes from './domains/casino/gameProvider.routes.js';
import gameRegistryRoutes from './domains/gameRegistry/gameRegistry.routes.js';
import { seedGameRegistry } from './domains/gameRegistry/gameRegistry.seed.js';
import { httpMetrics, metricsHandler } from './services/metrics.service.js';
// Plan items 19/21/28/24/4/51 (2026-07-13): central security + network config,
// OWASP filter, service registry, storage abstraction.
import { HELMET_OPTIONS, CORS_SHAPE, RATE_LIMIT_TIERS } from './config/security.config.js';
import { network, canonicalRedirect } from './config/network.config.js';
import { owaspFilter } from './middleware/owaspFilter.js';
// Item 9 (2026-07-13): bounded concurrency / load shedding — one instance's
// safety valve (503 the excess past the admin-configured ceiling).
import { loadShed, startLoadShedConfigRefresh } from './middleware/loadShed.js';
import { registerService } from './services/serviceRegistry.js';
import { providerRegistry } from './providers/registry.js';
import { S3StorageProvider } from './providers/storage/S3StorageProvider.js';
import { LocalDiskStorageProvider } from './providers/storage/LocalDiskStorageProvider.js';
import recoveryRoutes     from './routes/account-recovery.routes.js';
import winnersRoutes      from './routes/winners.routes.js';
import appBootstrapRoutes from './routes/app-bootstrap.routes.js';


import { requestLogger }  from './middleware/requestLogger.js';
import { errorHandler }   from './middleware/errorHandler.js';
import { requestContext } from './middleware/requestContext.js'; // X-6: correlation ids
import { tlsFingerprintDefense, startTlsFingerprintDefenseConfigRefresh } from './middleware/tlsFingerprintDefense.js';
import { rejectAmbiguousFraming } from './middleware/headerNormalization.js';
import { authLimiter, adminAuthLimiter, betLimiter } from './middleware/security.js';
// Item 12 (2026-07-13): IP-rotation defense — per-subnet backstop + optional
// global surge breaker on sensitive endpoints, on top of the per-IP limiters.
import { createSubnetLimiter, globalSurgeBreaker, startIpDefenseConfigRefresh } from './middleware/ipDefense.js';
import GameEngine         from './domains/markets/gameEngine.js';
import CycleGenerator     from './domains/markets/cycleGenerator.service.js';
import SSEManager         from './domains/notification/sseManager.service.js';
import { initSSERoutes }  from './routes/sse.routes.js';

// ─── APP SETUP ────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', network.trustProxy);

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'];

function corsOriginCheck(origin, callback) {
  if (!origin) return callback(null, true);
  if (process.env.NODE_ENV !== 'production') return callback(null, true);
  if (allowedOrigins.includes(origin)) return callback(null, true);
  return callback(new Error(`CORS: origin not allowed — ${origin}`));
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
  cors: { origin: corsOriginCheck, methods: ['GET', 'POST'], credentials: false },
  transports: ['websocket'], allowUpgrades: false, perMessageDeflate: false,
  pingTimeout: 60000, pingInterval: 25000, connectTimeout: 45000, maxHttpBufferSize: 1e6,
});
global.io = io;




//   - Game pool broadcasts (bet_placed, cycle events)
//   - Admin room events (admin_bet_placed)


const PORT = network.port; // item 28: single parse point in config/network.config.js

// ─── GLOBAL MIDDLEWARE ────────────────────────────────────────────────────────
// Security policy lives in config/security.config.js (item 19) — values are
// identical to what was inline here before; edit THAT file to change policy.
app.use(rejectAmbiguousFraming);
app.use(compression());
app.use(helmet(HELMET_OPTIONS));
// Item 29: optional canonical-host 301 (only when CANONICAL_HOST is set; keys
// on the requested Host only — see network.config.js).
app.use(canonicalRedirect);

const corsOptions = { origin: corsOriginCheck, ...CORS_SHAPE };
// AQ-6 (Express 5 / path-to-regexp 8): bare '*' is no longer a valid route
// pattern — a catch-all wildcard must be named. '/{*splat}' matches every path
// including the root. (app.use(cors) already answers preflights; this is the
// explicit belt-and-suspenders preflight handler, kept for parity.)
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
app.use((req, res, next) => (_ASSET_UPLOAD_PATHS.has(req.path) ? _assetJson : _tightJson)(req, res, next));
app.use(express.urlencoded({ extended: true, limit: JSON_LIMIT }));
app.use(mongoSanitize);
app.use(cookieParser());
app.use(requestContext); // X-6: correlation id (before the logger, so it's logged)
app.use(tlsFingerprintDefense); // JA3/TLS fingerprint policy from admin-managed SystemConfig
app.use(requestLogger);
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
app.get('/metrics', (req, res) => {
  const token = process.env.METRICS_TOKEN;
  if (!token && process.env.NODE_ENV === 'production') {
    return res.status(503).end('metrics token not configured');
  }
  if (!token || req.headers.authorization !== `Bearer ${token}`) {
    return res.status(401).end('unauthorized');
  }
  return metricsHandler(req, res);
});
app.use('/api/', rateLimit({
  ...RATE_LIMIT_TIERS.global, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again later.' }
}));
// Item 24: OWASP-pattern request filter — flag-gated (FLAGS.WAF_FILTER,
// default OFF). Mounted after body parsing so it can scan JSON bodies.
app.use('/api/', owaspFilter);

// ─── STATIC FILES ─────────────────────────────────────────────────────────────
const appAssetsDir = path.join(__dirname, 'app-assets');
fs.mkdirSync(appAssetsDir, { recursive: true });
// Slots retain .png names for stable PWA URLs, but uploads may be JPEG, WebP,
// or GIF. Serve the stored, byte-detected AppAsset content type rather than
// allowing the filename extension to select an incorrect MIME type.
app.get('/app-assets/:name', async (req, res, next) => {
  try {
    const asset = await mongoose.model('AppAsset').findOne({
      slot: req.params.name,
      storage: 'LOCAL',
    }).select('contentType').lean();
    const filePath = path.join(appAssetsDir, req.params.name);
    if (!asset || !asset.contentType || !fs.existsSync(filePath)) return next();
    res.type(asset.contentType);
    return res.sendFile(filePath);
  } catch (error) {
    return next(error);
  }
});
app.use('/app-assets', express.static(appAssetsDir, { maxAge: '1h' }));
// Item 51: local-disk StorageProvider serves from backend/storage/ (S3 deploys
// never write here — the S3 provider returns CDN/S3 URLs instead).
app.use('/storage', express.static(path.join(__dirname, 'storage'), { maxAge: '1h' }));

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
//               Mongo outage must NOT make the orchestrator kill and restart
//               every pod (that turns a dependency blip into a full outage).
//   READINESS = "should this instance receive traffic?" — deps up AND not
//               draining. Flipping this to 503 on SIGTERM is how we bleed
//               traffic off an instance before it stops accepting connections.
let shuttingDown = false;

function readinessState() {
  const mongoUp = mongoose.connection.readyState === 1;
  return {
    ready: mongoUp && !shuttingDown,
    mongodb: mongoUp ? 'connected' : 'disconnected',
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
app.get('/health/ready', (req, res) => {
  const s = readinessState();
  res.status(s.ready ? 200 : 503).json({ status: s.ready ? 'ready' : 'not-ready', ...s });
});
// Back-compat: /health and /api/v1/health keep readiness semantics (Railway's
// healthcheckPath and the Docker HEALTHCHECK point here). Now also 503 while
// draining so deploys route away from an instance that's shutting down.
function legacyHealth(req, res) {
  const s = readinessState();
  res.status(s.ready ? 200 : 503).json({ status: s.ready ? 'healthy' : 'unhealthy', ...s });
}
app.get('/health', legacyHealth);
app.get('/api/v1/health', legacyHealth);

// ─── API ROUTES ───────────────────────────────────────────────────────────────
// Item 12: chain order is per-IP → per-subnet → (optional) global surge, then
// the routes. Per-IP catches the single abuser fastest; the subnet limiter
// catches an attacker rotating IPs within one block; the surge breaker (off
// until an admin sets a ceiling) catches distributed rotation across subnets.
startIpDefenseConfigRefresh();
app.use('/api/v1/auth', authLimiter, createSubnetLimiter('auth'), globalSurgeBreaker('auth'), authRoutes);
// MED-04 FIX: removed /api/auth duplicate mount — it duplicated rate limit slots
// allowing 2× brute-force attempts. All clients should use /api/v1/auth/*.
app.use('/api', recoveryRoutes);
app.use('/api', winnersRoutes);
app.use('/api/app', appBootstrapRoutes);

app.post('/api/admin/login', adminAuthLimiter, createSubnetLimiter('adminAuth'), (req, res, next) => {
  req.body = { ...req.body, loginType: req.body.loginType || 'admin' };
  next();
}, loginHandler);

app.use('/api/admin', adminRoutes);   // ← now routes/admin/index.js (13 sub-routers)

// Public error report endpoint (no JWT — panel may be mid-crash)
const errorReportLimiter = rateLimit({ windowMs: 60000, max: 10, message: { success: false, message: 'Too many error reports' } });
app.post('/api/internal/error-report', errorReportLimiter, async (req, res) => {
  try {
    const FrontendErrorReport = mongoose.model('FrontendErrorReport'); // LOW-06: model defined in backend/models/payment.model.js
    const { message, stack, component, url, panel } = req.body;
    if (!message) return res.status(400).json({ success: false, message: 'message required' });
    await FrontendErrorReport.create({
      message:   String(message).slice(0, 2000),
      stack:     stack     ? String(stack).slice(0, 10000)    : undefined,
      component: component ? String(component).slice(0, 5000) : undefined,
      url:       url       ? String(url).slice(0, 500)        : undefined,
      panel:     ['user', 'merchant'].includes(panel) ? panel : 'unknown',
      ts:        new Date(),
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[error-report] insert failed:', err.message);
    res.json({ success: true });
  }
});

app.get('/api/download/android', async (req, res) => {
  try {
    const SystemConfig = mongoose.model('SystemConfig');
    const config = await SystemConfig.findOne({ key: 'main' }).lean();
    if (config?.androidUrl) return res.redirect(302, config.androidUrl);
    res.status(404).json({ success: false, message: 'APK not yet available.' });
  } catch { res.status(500).json({ success: false, message: 'Server error' }); }
});
app.get('/api/download/ios', async (req, res) => {
  try {
    const SystemConfig = mongoose.model('SystemConfig');
    const config = await SystemConfig.findOne({ key: 'main' }).lean();
    if (config?.iosUrl) return res.redirect(302, config.iosUrl);
    res.status(404).json({ success: false, message: 'Use Safari → Add to Home Screen for iOS.' });
  } catch { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.use('/api/game',      gameProviderRoutes);
// Game Registry (catalogue metadata + categories). Same base path; its routes
// (/games, /categories, /admin/games, /admin/categories) don't collide with the
// provider router's (/providers, /launch, /admin/game-providers).
app.use('/api/game',      gameRegistryRoutes);
app.use('/api/bet',       betRoutes);
app.use('/api',           userRoutes);
app.use('/api/merchant',  merchantRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/support',   supportRoutes); // CAP-71: RAG support assistant (dormant until keys set)
app.use('/api',           uploadRoutes);
app.use('/api/referral',  referralRoutes);
app.use('/api/giftcode',  giftCodeRoutes);
app.use('/api/payment',   paymentCfgRoutes);
app.use('/api',           retentionRoutes);
// /api/vip routes are provided by retentionRoutes above. The legacy
// vip router was removed to avoid shadowed, schema-incompatible duplicates
// for /api/vip/config and /api/vip/my.

// ─── GAME ENGINE + SSE ───────────────────────────────────────────────────────
const sseManager     = new SSEManager();
const gameEngine     = new GameEngine(io);
const cycleGenerator = new CycleGenerator(io, sseManager);

gameEngine.start();
cycleGenerator.start();

global.sseManager = sseManager;
app.use('/api/sse', initSSERoutes(sseManager, cycleGenerator));


attachSocketHandlers(io, cycleGenerator, gameEngine);

// Cross-instance real-time bridge (Phase X): fan out socket.io + SSE events
// across all backend instances via Redis. No-op without REDIS_URL.
initRealtimeBridge(io, sseManager);

// ─── SPA FALLBACKS ───────────────────────────────────────────────────────────
// AQ-6 (Express 5): named wildcards ('/admin/*splat') — '/admin/*' is invalid
// under path-to-regexp 8. '/{*splat}' matches all remaining paths incl. root.
app.get('/admin/*splat', (req, res, next) => {
  if (req.path.startsWith('/api') || path.extname(req.path)) return next();
  const p = path.join(__dirname, '../admin-panel/dist/index.html');
  fs.existsSync(p) ? res.sendFile(p) : res.status(503).send('<h1>Admin Panel Not Built</h1>');
});
app.get('/merchant/*splat', (req, res, next) => {
  if (req.path.startsWith('/api') || path.extname(req.path)) return next();
  const p = path.join(__dirname, '../merchant-panel/dist/index.html');
  fs.existsSync(p) ? res.sendFile(p) : res.status(503).send('<h1>Merchant Panel Not Built</h1>');
});
app.get('/{*splat}', (req, res, next) => {
  if (req.path.startsWith('/api') || path.extname(req.path)) return next();
  const p = path.join(__dirname, '../dist/index.html');
  fs.existsSync(p) ? res.sendFile(p) : res.status(200).json({ success: true, message: 'API running.' });
});
app.use((req, res) => {
  if (path.extname(req.path)) return res.status(404).send('Not found');
  res.status(404).json({ success: false, message: 'Route not found' });
});
app.use(errorHandler);
app.set('io', io);

// ─── START ────────────────────────────────────────────────────────────────────
Promise.allSettled([
  // Load the TLS policy before opening the listener. A failed initial read must
  // fail startup rather than serving requests with the log-only defaults.
  connectMongoDB()
    .then(() => seedAdminAccount())
    .then(() => seedGameRegistry())
    .then(() => startTlsFingerprintDefenseConfigRefresh()),
  connectRedis().then(r => { global.redis = r; }),
  // Hybrid money DB (plan step 1): apply the Postgres schema when
  // DATABASE_URL is set; silent no-op otherwise. Dual-write hooks in the
  // money models activate on the same signal.
  import('./postgres/pgClient.js').then(m => m.applySchema()).catch(e => console.error('[pg] schema apply failed:', e.message)),
  // CAP-71: RAG vector store. Apply the pgvector schema ONLY when RAG retrieval
  // is actually configured (DATABASE_URL + embedding provider key) — so a
  // money-only Postgres without the pgvector extension is never touched.
  import('./domains/support/ragService.js')
    .then(m => (m.retrievalReady() ? import('./domains/support/ragStore.js').then(s => s.initSchema()) : null))
    .catch(e => console.error('[rag] schema init skipped:', e.message)),
  // CAP-74: attach the external event backbone (Kafka) when KAFKA_BROKERS is set.
  // No-op otherwise — the monolith keeps using the in-process bus only.
  import('./services/eventBackbone.js').then(m => m.configureFromEnv()).catch(e => console.error('[backbone] configure failed:', e.message)),
]).then((results) => {
  if (results[0].status === 'rejected') {
    console.error('❌ Startup failed while loading TLS fingerprint policy:', results[0].reason);
    process.exitCode = 1;
    return;
  }
  console.log('✅ DB services initialized');
  registerCronJobs(rebuildLeaderboard);
  registerFundingEventSubscribers(); // Funding Platform (Phase 009) — eventBus wiring
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server listening on port ${PORT}`);
  });
});

// AQ-4: real graceful drain. Order matters — fail readiness FIRST so the load
// balancer stops sending new work, wait a beat for it to notice, THEN stop
// accepting connections and let in-flight requests finish before closing the
// datastores. The previous version never called server.close(), so the listener
// kept accepting new requests through the whole grace window and then killed
// them mid-flight on process.exit — rolling deploys dropped requests.
async function closeResources() {
  await Promise.allSettled([
    import('./services/jobQueue.service.js').then(m => m.closeJobQueue()),      // 17+56: finish/close queue
    import('./services/eventBackbone.js').then(m => m.resetBackbone()),         // CAP-74: disconnect Kafka producer
    import('./postgres/pgClient.js').then(m => m.closePg()),                    // hybrid money DB: drain PG pool
    import('./services/workerPool.service.js').then(m => m.closeWorkerPool()),  // item 5: terminate CPU threads
  ]);
  try { await mongoose.connection.close(false); } catch (_) {}
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
    server.close(async () => {
      console.log('[shutdown] listener closed; in-flight drained — closing datastores.');
      await closeResources();
      clearTimeout(hardExit);
      console.log('[shutdown] complete.');
      process.exit(0);
    });
    // Nudge lingering long-lived connections (e.g. SSE) toward closing.
    setTimeout(() => { try { server.closeAllConnections?.(); } catch (_) {} }, Math.max(0, DEADLINE_MS - DRAIN_DELAY_MS - 2000)).unref?.();
  }, DRAIN_DELAY_MS);
};
process.on('SIGTERM', () => _shutdown('SIGTERM'));
process.on('SIGINT',  () => _shutdown('SIGINT'));

export default app;
