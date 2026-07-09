// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)


// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import express      from 'express';
import mongoose     from 'mongoose';
import http         from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors         from 'cors';
import helmet       from 'helmet';
import compression  from 'compression';
import rateLimit    from 'express-rate-limit';
import mongoSanitize from 'express-mongo-sanitize';
import dotenv       from 'dotenv';
import path         from 'path';
import fs           from 'fs';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── STARTUP MODULES ──────────────────────────────────────────────────────────
import { connectMongoDB }     from './startup/mongoConnect.js';
import { connectRedis }       from './startup/redisConnect.js';
import { seedAdminAccount }   from './startup/seedAdmin.js';
import { registerCronJobs }   from './startup/cronJobs.js';
import { attachSocketHandlers } from './startup/socketHandlers.js';
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
import uploadRoutes       from './routes/upload.routes.js';
import referralRoutes     from './routes/referral.routes.js';
import paymentCfgRoutes   from './routes/payment-config.routes.js';
import giftCodeRoutes     from './routes/giftcode.routes.js';
import retentionRoutes, { rebuildLeaderboard } from './routes/retention.routes.js';
import gameProviderRoutes from './domains/casino/gameProvider.routes.js';
import recoveryRoutes     from './routes/account-recovery.routes.js';
import winnersRoutes      from './routes/winners.routes.js';


import vipRoutes          from './routes/vip.routes.js';
import { requestLogger }  from './middleware/requestLogger.js';
import { errorHandler }   from './middleware/errorHandler.js';
import { authLimiter, adminAuthLimiter, betLimiter } from './middleware/security.js';
import GameEngine         from './domains/markets/gameEngine.js';
import CycleGenerator     from './domains/markets/cycleGenerator.service.js';
import SSEManager         from './domains/notification/sseManager.service.js';
import { initSSERoutes }  from './routes/sse.routes.js';

// ─── APP SETUP ────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'];

function corsOriginCheck(origin, callback) {
  if (!origin) return callback(null, true);
  if (process.env.NODE_ENV !== 'production') return callback(null, true);
  if (allowedOrigins.includes(origin)) return callback(null, true);
  return callback(new Error(`CORS: origin not allowed — ${origin}`));
}

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: corsOriginCheck, methods: ['GET', 'POST'], credentials: false },
  transports: ['websocket'], allowUpgrades: false, perMessageDeflate: false,
  pingTimeout: 60000, pingInterval: 25000, connectTimeout: 45000, maxHttpBufferSize: 1e6,
});
global.io = io;




//   - Game pool broadcasts (bet_placed, cycle events)
//   - Admin room events (admin_bet_placed)


const PORT = process.env.PORT || 8080;

// ─── GLOBAL MIDDLEWARE ────────────────────────────────────────────────────────
app.use(compression());
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc:     ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'wss:', 'ws:', 'https:'],
      objectSrc:  ["'none'"], manifestSrc: ["'self'"],
    }
  },
  crossOriginEmbedderPolicy: false
}));

const corsOptions = {
  origin: corsOriginCheck, credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  optionsSuccessStatus: 200
};
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(mongoSanitize());
app.use(cookieParser());
app.use(requestLogger);
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000, max: 1000, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again later.' }
}));

// ─── STATIC FILES ─────────────────────────────────────────────────────────────
const appAssetsDir = path.join(__dirname, 'app-assets');
fs.mkdirSync(appAssetsDir, { recursive: true });
app.use('/app-assets', express.static(appAssetsDir, { maxAge: '1h' }));
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

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const mongoStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  const redisStatus = global.redis ? 'connected' : 'unavailable';
  if (mongoStatus === 'disconnected') {
    return res.status(503).json({ status: 'unhealthy', timestamp: new Date().toISOString(), mongodb: mongoStatus, redis: redisStatus });
  }
  res.json({ status: 'healthy', timestamp: new Date().toISOString(), mongodb: mongoStatus, redis: redisStatus, uptime: process.uptime() });
});
app.get('/api/v1/health', (req, res) => {
  const mongoStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  const redisStatus = global.redis ? 'connected' : 'unavailable';
  res.status(mongoStatus === 'connected' ? 200 : 503).json({
    status: mongoStatus === 'connected' ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(), mongodb: mongoStatus, redis: redisStatus, uptime: process.uptime()
  });
});

// ─── API ROUTES ───────────────────────────────────────────────────────────────
app.use('/api/v1/auth', authLimiter, authRoutes);
// MED-04 FIX: removed /api/auth duplicate mount — it duplicated rate limit slots
// allowing 2× brute-force attempts. All clients should use /api/v1/auth/*.
app.use('/api', recoveryRoutes);
app.use('/api', winnersRoutes);

app.post('/api/admin/login', adminAuthLimiter, (req, res, next) => {
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
app.use('/api/bet',       betRoutes);
app.use('/api',           userRoutes);
app.use('/api/merchant',  merchantRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api',           uploadRoutes);
app.use('/api/referral',  referralRoutes);
app.use('/api/giftcode',  giftCodeRoutes);
app.use('/api/payment',   paymentCfgRoutes);
app.use('/api',           retentionRoutes);
app.use('/api/vip',       vipRoutes);

// ─── GAME ENGINE + SSE ───────────────────────────────────────────────────────
const sseManager     = new SSEManager();
const gameEngine     = new GameEngine(io);
const cycleGenerator = new CycleGenerator(io, sseManager);

gameEngine.start();
cycleGenerator.start();

global.sseManager = sseManager;
app.use('/api/sse', initSSERoutes(sseManager, cycleGenerator));


attachSocketHandlers(io, cycleGenerator, gameEngine);

// ─── SPA FALLBACKS ───────────────────────────────────────────────────────────
app.get('/admin/*', (req, res, next) => {
  if (req.path.startsWith('/api') || path.extname(req.path)) return next();
  const p = path.join(__dirname, '../admin-panel/dist/index.html');
  fs.existsSync(p) ? res.sendFile(p) : res.status(503).send('<h1>Admin Panel Not Built</h1>');
});
app.get('/merchant/*', (req, res, next) => {
  if (req.path.startsWith('/api') || path.extname(req.path)) return next();
  const p = path.join(__dirname, '../merchant-panel/dist/index.html');
  fs.existsSync(p) ? res.sendFile(p) : res.status(503).send('<h1>Merchant Panel Not Built</h1>');
});
app.get('*', (req, res, next) => {
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
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on port ${PORT}`);
});

Promise.allSettled([
  connectMongoDB().then(() => seedAdminAccount()),
  connectRedis().then(r => { global.redis = r; })
]).then(() => {
  console.log('✅ DB services initialized');
  registerCronJobs(rebuildLeaderboard);
  registerFundingEventSubscribers(); // Funding Platform (Phase 009) — eventBus wiring
});

const _shutdown = (sig) => {
  console.log(`[${sig}] Shutting down gracefully...`);
  try { if (global.gameEngine)     global.gameEngine.stop();     } catch (_) {}
  try { if (global.cycleGenerator) global.cycleGenerator.stop(); } catch (_) {}
  setTimeout(() => process.exit(0), 10000);
};
process.on('SIGTERM', () => _shutdown('SIGTERM'));
process.on('SIGINT',  () => _shutdown('SIGINT'));

export default app;
