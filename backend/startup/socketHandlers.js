
// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import mongoose from 'mongoose';
// AQ-2: verify via the single PASETO authority (Ed25519 signature + iss/aud stamped).
import { verifyJwt } from '../domains/identity/jwt.util.js';
import { cycleSnapshotPublisher } from '../domains/markets/cycleSnapshotPublisher.js';
import { fetchCycleHistory } from '../domains/markets/cycleHistory.service.js';

// Public cycle-room id guard: the room name is client-supplied, so bound it to
// the shape a real cycleId has (no auth needed — pool totals are public — but a
// client must not be able to join arbitrary or oversized room names).
const isValidCycleId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 64 && /^[A-Za-z0-9:_-]+$/.test(id);

export function attachSocketHandlers(io, cycleGenerator, gameEngine) {

  io.on('connection', async (socket) => {
    console.log('👤 Client connected:', socket.id);

    // Push-on-connect helpers
    // M-04 fix: all fallback values match Mongoose schema defaults exactly.
    // GOVERNANCE §5: every server-side fallback must literally match the schema default.
    // Schema: SystemConfig — betLimits.thirtyMin.min=10, maxDeposit=50000, minWithdrawal=500
    // payoutMultiplier is now a SystemConfig field (not a hardcoded literal).
    const sendSystemConfig = async () => {
      try {
        const SystemConfig = mongoose.model('SystemConfig');
        const cfg   = await SystemConfig.findOne({ key: 'main' }).lean();
        const configData = {
          minBet:             cfg?.betLimits?.thirtyMin?.min  ?? 10,      // schema default: 10
          maxBet:             cfg?.betLimits?.thirtyMin?.max  ?? 100000,  // schema default: 100000
          maxFullDayBet:      cfg?.betLimits?.fullDay?.max    ?? 500000,  // schema default: 500000
          minDeposit:         cfg?.minDeposit                 ?? 100,     // schema default: 100
          maxDeposit:         cfg?.maxDeposit                 ?? 50000,   // schema default: 50000
          minWithdrawal:      cfg?.minWithdrawal              ?? 500,     // schema default: 500
          maxWithdrawal:      cfg?.maxWithdrawal              ?? 50000,   // schema default: 50000
          // payoutMultiplier from admin-editable config; fallback = GAME_CORE.ts PAYOUT.MULTIPLIER = 2
          payoutMultiplier:   cfg?.payoutMultiplier           ?? 2,
          tokenBuyRate:       1, // fixed 1:1 conversion (Phase 006 flattening, 2026-07-08)
          tokenSellRate:      1, // fixed 1:1 conversion
          maintenanceMode:    cfg?.maintenanceMode            ?? false,
          maintenanceMessage: cfg?.maintenanceMessage         ?? '',
          // Footer navigation (2026-07-13) — schema default: the historical five tabs
          footerPages:        cfg?.footerPages?.length ? cfg.footerPages : ['home', 'results', 'winners', 'promo', 'profile'],
          minVersion:         cfg?.minVersion                 ?? '1.0.0',
          latestVersion:      cfg?.latestVersion              ?? '1.0.0',
          webUrl:             cfg?.webUrl                     ?? '',
          androidUrl:         cfg?.androidUrl                 ?? '',
          iosUrl:             cfg?.iosUrl                     ?? '',
        };
        global.cachedSystemConfig = configData;
        socket.emit('system_config', configData);
      } catch (e) {
        // Minimal safe fallback matching schema defaults (no independently chosen numbers)
        socket.emit('system_config', {
          maintenanceMode: false, maintenanceMessage: '',
          minVersion: '1.0.0', latestVersion: '1.0.0',
          minBet: 10, maxBet: 100000, payoutMultiplier: 2,
        });
      }
    };

    // C-04 fix: sendBranding() is the single-authority push point for branding.
    // It MUST read from DB — never push a hardcoded asset dict.
    
    const sendBranding = async () => {
      try {
        const Branding = mongoose.model('Branding');
        const b = await Branding.findOne({ key: 'main' }).lean() || {};
        const cdnBaseUrl = b.cdnBaseUrl || process.env.CDN_URL || '';
        const brandingData = {
          appName:              b.appName              || 'Betting Bazaar',
          cdnBaseUrl,
          primaryColor:         b.primaryColor         || '#D4AF37',
          secondaryColor:       b.secondaryColor       || '#8B5CF6',
          accentColor:          b.accentColor          || '#F59E0B',
          logo:                 b.logo                 || '',
          icon:                 b.icon                 || '',
          favicon:              b.favicon              || '',
          splashScreen:         b.splashScreen         || '',
          userPanelName:        b.userPanelName        || 'Betting Bazaar',
          adminPanelName:       b.adminPanelName       || 'Bazaar Admin',
          merchantPanelName:    b.merchantPanelName    || 'Merchant Panel',
          queueManagerPanelName:b.queueManagerPanelName|| 'Queue Manager',
          homePopupImageUrl:    b.homePopupImageUrl    || '',
          homePopupLinkUrl:     b.homePopupLinkUrl     || '',
          homePopupEnabled:     b.homePopupEnabled     || false,
          tricksTipsBannerUrl:  b.tricksTipsBannerUrl  || '',
          rulesPageImageUrl:    b.rulesPageImageUrl     || '',
          depositPageBannerUrl:   b.depositPageBannerUrl   || '',
          withdrawalPageBannerUrl:b.withdrawalPageBannerUrl|| '',
          loginPageBannerUrl:   b.loginPageBannerUrl   || '',
          registerPageBannerUrl:b.registerPageBannerUrl|| '',
        };
        global.cachedBranding = brandingData;
        socket.emit('branding', brandingData);
      } catch (e) {
        // Minimal safe fallback — NO hardcoded asset filenames (C-04 fix)
        socket.emit('branding', {
          appName: 'Betting Bazaar',
          cdnBaseUrl: process.env.CDN_URL || '',
          primaryColor: '#D4AF37',
          secondaryColor: '#8B5CF6',
          accentColor: '#F59E0B',
          logo: '', icon: '', favicon: '', splashScreen: '',
          homePopupEnabled: false,
        });
      }
    };

    cycleGenerator.sendCycleSnapshot(socket);
    Promise.all([sendSystemConfig(), sendBranding()]).catch(() => {});

    // On-demand handlers
    socket.on('request_cycle_snapshot',  () => cycleGenerator.sendCycleSnapshot(socket));
    socket.on('request_system_config',   sendSystemConfig);
    socket.on('request_branding',        sendBranding);

    // `limit` is PER TYPE, not in total: an omitted `type` means "all of them",
    // and one shared budget across types starves the slow ones — see
    // cycleHistory.service.js.
    socket.on('request_cycle_history', async (params = {}) => {
      try {
        const { type, limit } = params;
        socket.emit('cycle_history', await fetchCycleHistory({ types: type, limit }));
      } catch (e) { socket.emit('cycle_history', { cycles: [], types: [] }); }
    });

    socket.on('request_promo', async ({ location } = {}) => {
      try {
        const PromoContent = mongoose.model('PromoContent');
        const content = await PromoContent.find({ location, isActive: true }).sort({ order: 1 }).lean();
        socket.emit('promo_data', { location, content });
      } catch (e) { socket.emit('promo_data', { location, content: [] }); }
    });

    socket.on('request_game_state', async () => {
      const gameState = await gameEngine.getGameState();
      socket.emit('game_state', gameState);
    });

    // ── Public cycle rooms (realtime cost/concurrency fix) ────────────────────
    // A client joins only the cycle(s) it is actually viewing; the coalesced
    // `pool_update` snapshot then reaches watchers of THIS cycle instead of every
    // connected socket. Membership is Socket.IO's own (no Redis watcher list),
    // and the Redis adapter fans `io.to('cycle:X')` across instances for free.
    socket.on('watch_cycle', (payload) => {
      const cycleId = typeof payload === 'string' ? payload : payload?.cycleId;
      if (!isValidCycleId(cycleId)) return;
      socket.join(`cycle:${cycleId}`);
      // Seed the joiner with the current snapshot so pools aren't blank until the
      // next 1s tick.
      const snap = cycleSnapshotPublisher.peek(cycleId);
      if (snap) socket.emit('pool_update', snap);
    });
    socket.on('unwatch_cycle', (payload) => {
      const cycleId = typeof payload === 'string' ? payload : payload?.cycleId;
      if (!isValidCycleId(cycleId)) return;
      socket.leave(`cycle:${cycleId}`);
    });

    const socketToken = () => {
      const cookieHeader = socket.handshake.headers?.cookie || '';
      const cookieToken  = cookieHeader.split(';').map(s => s.trim())
        .find(s => s.startsWith('auth_token='))?.split('=')[1];
      return cookieToken || socket.handshake.auth?.token;
    };

    const loadActiveUser = async (decoded) => {
      if (!decoded?.userId) return null;
      const User = mongoose.model('User');
      const user = await User.findById(decoded.userId).select('isAdmin isSubAdmin isBlocked status').lean();
      if (!user || user.isBlocked || user.status === 'BLOCKED') return null;
      return user;
    };

    socket.on('join_user_room', async (userId) => {
      const token = socketToken();
      if (!token) return;
      try {
        const decoded = verifyJwt(token);
        if (decoded.userId?.toString() === userId?.toString()) {
          socket.join(`user-${userId}`);
          return;
        }
        const user = await loadActiveUser(decoded);
        if (user?.isAdmin) socket.join(`user-${userId}`);
      } catch { /* invalid token — silently reject */ }
    });

    socket.on('join_merchant_room', async (merchantId) => {
      const token = socketToken();
      if (!token) return;
      try {
        const decoded = verifyJwt(token);
        if (decoded.isMerchant && decoded.merchantId?.toString() === merchantId?.toString()) {
          const Merchant = mongoose.model('Merchant');
          const merchant = await Merchant.findById(decoded.merchantId).select('status merchantApprovalStatus').lean();
          if (merchant?.status === 'ACTIVE' && merchant?.merchantApprovalStatus === 'APPROVED') socket.join(`merchant-${merchantId}`);
          return;
        }
        const user = await loadActiveUser(decoded);
        if (user?.isAdmin) socket.join(`merchant-${merchantId}`);
      } catch { /* invalid token — silently reject */ }
    });

    socket.on('join_admin_room', async (data) => {
      try {
        const token = data?.token || socketToken();
        if (!token) return;
        const decoded = verifyJwt(token);
        const user = await loadActiveUser(decoded);
        if (user?.isAdmin || user?.isSubAdmin) {
          socket.join('admin-room');
          socket.emit('joined_admin_room', { success: true });
        }
      } catch { console.warn('⚠️  join_admin_room rejected — invalid token'); }
    });

    socket.on('disconnect', () => {
      console.log('👋 Client disconnected:', socket.id);
    });
  });
}
