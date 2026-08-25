// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)


// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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

// Hybrid money DB: report which store is authoritative for each money path, and
// refuse to boot on an incoherent cutover (e.g. the accounting ledger moved to
// Postgres while balances are still in Mongo — a settlement would then span two
// sources of truth). Silent in the default all-Mongo posture.
// See postgres/moneyAuthority.js and LAUNCH_READINESS.md §E.
const moneyAuthorityCheck = reportAuthorityAtBoot();
if (!moneyAuthorityCheck.ok) {
  console.error('❌ Refusing to start: the money-authority configuration is inconsistent (see above).');
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── STARTUP MODULES ──────────────────────────────────────────────────────────
import { validateEnv }        from './startup/validateEnv.js'; // AQ-1: fail-fast env gate
import { reportAuthorityAtBoot } from './postgres/moneyAuthority.js'; // hybrid money DB: source-of-truth per path
import { runtimeProfile }     from './startup/runtimeRole.js';
import { connectMongoDB }     from './startup/mongoConnect.js';
import { connectRedis }       from './startup/redisConnect.js';
import { seedAdminAccount }   from './startup/seedAdmin.js';
import { registerCronJobs }   from './startup/cronJobs.js';
import { attachSocketHandlers } from './startup/socketHandlers.js';
import { cycleSnapshotPublisher } from './domains/markets/cycleSnapshotPublisher.js';
import { initRealtimeBridge } from './startup/realtimeBridge.js'; // Phase X: multi-instance real-time
import { registerFundingEventSubscribers } from './domains/funding/fundingEvents.js';

// ─── MODELS (must load before any route that calls mongoose.model()) ──────────
import './models/index.js';

// ─── ROUTES ───────────────────────────────────────────────────────────────────
import authRoutes, { loginHandler, loginTwoFactorHandler } from './routes.js';
import adminRoutes        from './routes/admin/index.js';      // ← new modular index
import betRoutes          from './domains/markets/bet.routes.js';
// Telegram bot webhook + the one-time-link session exchange. Public by design:
// the caller is Telegram, and the webhook authenticates on the secret token
// Telegram echoes, not on a session.
import telegramRoutes     from './domains/telegram/telegram.routes.js';
import userRoutes         from './domains/user/user.routes.js';
import merchantRoutes     from './domains/merchant/merchant.routes.js';
import paymentRoutes      from './domains/payment/payment.routes.js';
import supportRoutes      from './domains/support/support.routes.js'; // CAP-71: RAG support assistant
import uploadRoutes       from './routes/upload.routes.js';
import paymentCfgRoutes   from './routes/payment-config.routes.js';
import giftCodeRoutes     from './routes/giftcode.routes.js';
import retentionRoutes, { rebuildLeaderboard } from './routes/retention.routes.js';
import gameProviderRoutes from './domains/casino/gameProvider.routes.js';
import gameRegistryRoutes from './domains/gameRegistry/gameRegistry.routes.js';
import { seedGameRegistry } from './domains/gameRegistry/gameRegistry.seed.js';
import { httpMetrics, metricsHandler, setRealtimeStatsProvider } from './services/metrics.service.js';
// Plan items 19/21/28/24/4/51 (2026-07-13): central security + network config,
// OWASP filter, service registry, storage abstraction.
import { HELMET_OPTIONS, CORS_SHAPE, RATE_LIMIT_TIERS, isPhantomBetPlacement } from './config/security.config.js';
import { network, canonicalRedirect } from './config/network.config.js';
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
import twoFactorRoutes from './domains/identity/twoFactor.routes.js';
import winnersRoutes      from './routes/winners.routes.js';
import appBootstrapRoutes from './routes/app-bootstrap.routes.js';


import { requestLogger }  from './middleware/requestLogger.js';
import { errorHandler }   from './middleware/errorHandler.js';
import { requestContext } from './middleware/requestContext.js'; // X-6: correlation ids
import { tlsFingerprintDefense, startTlsFingerprintDefenseConfigRefresh } from './middleware/tlsFingerprintDefense.js';
import { rejectAmbiguousFraming } from './middleware/headerNormalization.js';
import { authLimiter, adminAuthLimiter, merchantAuthLimiter, betLimiter, twoFactorLimiter } from './middleware/security.js';
// Item 12 (2026-07-13): IP-rotation defense — per-subnet backstop + optional
// global surge breaker on sensitive endpoints, on top of the per-IP limiters.
import { createSubnetLimiter, globalSurgeBreaker, startIpDefenseConfigRefresh } from './middleware/ipDefense.js';
// Bot-mitigation challenge on credential endpoints (LAUNCH_READINESS §F).
// Pass-through until TURNSTILE_SECRET_KEY is set, like every other integration.
import { requireCaptcha } from './middleware/captcha.js';
import GameEngine         from './domains/markets/gameEngine.js';
import CycleGenerator     from './domains/markets/cycleGenerator.service.js';
import SSEManager         from './domains/notification/sseManager.service.js';
import { initSSERoutes }  from './routes/sse.routes.js';

// ─── APP SETUP ────────────────────────────────────────────────────────────────
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
  allowRequest: (_req, callback) => callback(null, runtime.acceptsRealtime),
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
// NO urlencoded body parser — deliberately. This is CSRF defence, not cleanup.
//
// Auth cookies are issued with `sameSite: 'none'` in production (routes.js),
// because the Capacitor/Android shell runs on a different origin and would
// otherwise never receive them. SameSite=None means the browser attaches
// auth_token to CROSS-SITE requests, and authenticate() accepts the cookie as
// proof of identity. The only thing then standing between an attacker's page
// and a money mutation is whether the browser will send a usable request
// without our permission.
//
// CORS does not stop it. For a "simple request" the browser SENDS the request
// and only withholds the *response* — the mutation has already happened. The
// simple content types are urlencoded, multipart, and text/plain, so a hidden
// auto-submitting <form> posting urlencoded was a complete CSRF vector against
// every authenticated POST, with no preflight to block it.
//
// Removing this parser closes that: with only express.json mounted, a
// urlencoded body is never parsed, so req.body is empty and the handler fails
// validation. multipart has no parser either, and express.json ignores
// text/plain. Anything sending real application/json triggers a preflight,
// which the CORS allow-list then rejects for untrusted origins.
//
// Verified before removing: nothing inbound needs it. No route reads a
// form-encoded body, no panel sends one (the only x-www-form-urlencoded in the
// tree is OUTBOUND, to Turnstile in middleware/captcha.js), and no test posts
// one. If a provider callback ever needs form encoding, mount a urlencoded
// parser ON THAT ROUTE ONLY — never globally — and require a signature on it.
//
// This is a vector fix, not a complete CSRF programme. Token-based CSRF, or
// dropping cookie auth for the Authorization header everywhere, is the
// structural answer and needs a decision spanning all three panels plus the
// Android shell. See docs/governance/SECURITY_CODE_REVIEW_CHECKLIST.md.
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
// Phantom managers fire many equalizer (ghost) bets in quick succession to
// balance the display pool, so their placements must NOT be throttled. Exempt
// POST /api/bet/phantom from the global backstop: the route is already gated
// (authenticate + phantomAccess → 403 for everyone else) and loadShed still
// bounds total in-flight work, so this removes no real DoS protection.
// (The isPhantomBetPlacement predicate lives in config/security.config.js.)
app.use('/api/', rateLimit({
  ...RATE_LIMIT_TIERS.global, standardHeaders: true, legacyHeaders: false,
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
    const asset = await mongoose.model('AppAsset').findOne({
      slot: req.params.name,
      storage: 'LOCAL',
    }).select('contentType').lean();
    const filePath = path.join(appAssetsDir, req.params.name);
    if (!asset || !asset.contentType) return next();
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
if (runtime.acceptsHttpApi) {
startIpDefenseConfigRefresh();
// Session lifecycle only: /me, /logout, /health. No captcha here — every page
// load calls /me to restore the session, so gating this router would 403 every
// user on every load. The credential-submitting routes that captcha DID guard
// (/login, /register) no longer exist for players; the staff password door is
// mounted separately below and carries its own captcha.
app.use('/api/v1/auth', authLimiter, createSubnetLimiter('auth'), globalSurgeBreaker('auth'), authRoutes);
// Player signup and login are NOT here — they run through the Telegram bot
// webhooks and the one-time-link exchange, mounted at /api/telegram below.
// 2FA enrolment and management (LAUNCH_READINESS §F). Mandatory for admin and
// sub-admin roles; players do not have passwords and so have no second factor
// to enrol. Enforcement at login lives in the auth handler, this router only
// manages enrolment.
app.use('/api/2fa', twoFactorRoutes);
app.use('/api', winnersRoutes);
app.use('/api/app', appBootstrapRoutes);

app.post('/api/admin/login', adminAuthLimiter, createSubnetLimiter('adminAuth'), requireCaptcha('admin-login'), (req, res, next) => {
  req.body = { ...req.body, loginType: req.body.loginType || 'admin' };
  next();
}, loginHandler);
// Second leg of the admin login. 2FA is MANDATORY for admins and sub-admins
// (LAUNCH_READINESS §F), so without this route an enrolled admin gets a
// challenge token from the line above and has nowhere to redeem it. Rate
// limited on the OTP tier, not the admin-password tier: six digits is a 10^6
// space, so it warrants its own tighter budget.
app.post('/api/admin/login/2fa', twoFactorLimiter, loginTwoFactorHandler);

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
app.use('/api/telegram',  telegramRoutes);
app.use('/api/bet',       betRoutes);
app.use('/api',           userRoutes);
// Scoped to the login PATH, not the whole merchant router.
//
// Mounting it router-wide looked equivalent because the limiter skips
// successful requests — but skipSuccessfulRequests only skips 2xx. Every
// ordinary 4xx a working merchant collects (a validation error on an order
// action, a 404, a stale reference) would have counted against their LOGIN
// budget, and four of those in an hour would lock them out of signing in
// entirely. A limiter that bans people for using the product correctly is a
// worse outage than the brute-force it prevents.
app.use('/api/merchant/auth/login', merchantAuthLimiter, requireCaptcha('merchant-login'));
app.use('/api/merchant',  merchantRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/support',   supportRoutes); // CAP-71: RAG support assistant (dormant until keys set)
app.use('/api',           uploadRoutes);
app.use('/api/giftcode',  giftCodeRoutes);
app.use('/api/payment',   paymentCfgRoutes);
app.use('/api',           retentionRoutes);
// Referral and VIP were removed from the platform on 2026-07-30 (owner
// decision). No /api/referral or /api/vip routes exist; the models, the
// commission engine and the panel pages went with them.
} else {
  app.use('/api', (_req, res) => res.status(404).json({ success: false, message: `API disabled on ${runtime.role} runtime role` }));
}

// ─── GAME ENGINE + SSE ───────────────────────────────────────────────────────
const sseManager     = new SSEManager();
const gameEngine     = new GameEngine(io);
const cycleGenerator = new CycleGenerator(io, sseManager);

if (runtime.runsSchedulers) {
  gameEngine.start();
  cycleGenerator.start();
} else {
  console.log(`⏸️ Runtime role ${runtime.role}: game engine and cycle scheduler are not started.`);
}

global.sseManager = sseManager;
if (runtime.acceptsRealtime) {
  app.use('/api/sse', initSSERoutes(sseManager, cycleGenerator));
  attachSocketHandlers(io, cycleGenerator, gameEngine);

  // Realtime cost/concurrency fix: coalesce per-bet pool broadcasts into ≤1
  // snapshot/sec/cycle. One publisher per process; on a single-server deploy
  // that is exactly one, with the true DB-authoritative total. Across instances
  // the Socket.IO Redis adapter delivers the room emit to every watcher, and
  // each process publishes valid recent totals (display converges sub-second).
  cycleSnapshotPublisher.attach({ io, sseManager }).start();

  // Expose realtime delivery gauges on /metrics (connected sockets + publisher
  // stats). Event-loop lag is already a default metric. IoC so metrics.service
  // imports neither io nor the publisher.
  setRealtimeStatsProvider(() => ({
    connectedSockets: io?.engine?.clientsCount ?? 0,
    ...cycleSnapshotPublisher.stats(),
  }));

  // Cross-instance real-time bridge (Phase X): fan out socket.io + SSE events
  // across all realtime instances via Redis. No-op without REDIS_URL.
  initRealtimeBridge(io, sseManager);
} else {
  app.use('/api/sse', (_req, res) => res.status(404).json({ success: false, message: 'Realtime disabled on this API role' }));
}

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
// Open the listener FIRST, before the datastores are up.
//
// This used to live inside the .then() of the Promise.allSettled below, so the
// port did not open until connectMongoDB() settled. That function retries 10
// times with serverSelectionTimeoutMS=30000 and a 5s pause between attempts, so
// a MongoDB that is merely slow to accept connections — a service still
// starting, the normal case on a fresh Railway/compose deploy — kept the
// process from binding for up to ~5.75 minutes. Every probe in that window got
// ECONNREFUSED rather than an answer, which is precisely what Railway's
// healthcheck (healthcheckPath=/health, healthcheckTimeout=60) reads as "this
// deploy is dead", and restartPolicyMaxRetries then repeats the whole cycle.
//
// The readiness endpoints above were already written for this: /health and
// /health/ready return 503 with `mongodb: 'disconnected'` until the connection
// is live. They just could not be reached, because nothing was listening. With
// the listener open from the start, an orchestrator gets an honest
// "not ready yet" it can wait on, and a real answer the moment Mongo attaches.
//
// Serving before Mongo is up is safe: readiness fails, so a load balancer does
// not route to this instance, and any request that does arrive fails the same
// way it would have anyway. Nothing below depends on a datastore — the cron
// jobs and event subscribers that DO are still registered in the .then().
activeListener = listenWithOptionalProxyProtocol(server, {
  port: PORT,
  host: '0.0.0.0',
  enabled: network.proxyProtocolV2.enabled,
  trustedSubnets: network.proxyProtocolV2.trustedSubnets,
}).on('listening', () => {
  console.log(`✅ Server listening on port ${PORT} (readiness pending until datastores attach)`);
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
    // The listener is already open by this point, so failing startup has to
    // close it — leaving it bound would keep the process alive and advertise a
    // port that will never become ready.
    console.error('❌ Startup failed while loading TLS fingerprint policy:', results[0].reason);
    process.exitCode = 1;
    try { activeListener?.close(); } catch { /* nothing to close */ }
    return;
  }
  console.log('✅ DB services initialized');
  if (runtime.runsSchedulers) {
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
  try { cycleSnapshotPublisher.stop(); } catch (_) {}                            // stop the 1s snapshot timer
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
