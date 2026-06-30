
// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import mongoose from 'mongoose';
import jwt      from 'jsonwebtoken';

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
        const TokenRates   = mongoose.model('TokenRates');
        const cfg   = await SystemConfig.findOne({ key: 'main' }).lean();
        const rates = await TokenRates.findOne({ key: 'main' }).lean();
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
          tokenBuyRate:       rates?.buyRate                  ?? 1,
          tokenSellRate:      rates?.sellRate                 ?? 1,
          maintenanceMode:    cfg?.maintenanceMode            ?? false,
          maintenanceMessage: cfg?.maintenanceMessage         ?? '',
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

    socket.on('request_cycle_history', async (params = {}) => {
      try {
        const { type, limit = 50 } = params;
        const parsedLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
        const Cycle = mongoose.model('Cycle');
        const query = { status: 'RESULT_DECLARED' };
        if (type) query.type = type;
        const cycles = await Cycle.find(query).sort({ endTime: -1 }).limit(parsedLimit).lean();
        socket.emit('cycle_history', {
          cycles: cycles.map(c => ({
            id: c.cycleId, type: c.type,
            startTime: c.startTime, endTime: c.endTime,
            winner: c.winner, status: c.status,
            delhiPool: c.totalDelhi || 0, bombayPool: c.totalBombay || 0,
            totalPool: (c.totalDelhi || 0) + (c.totalBombay || 0),
          }))
        });
      } catch (e) { socket.emit('cycle_history', { cycles: [] }); }
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

    socket.on('join_user_room', (userId) => {
      const cookieHeader = socket.handshake.headers?.cookie || '';
      const cookieToken  = cookieHeader.split(';').map(s => s.trim())
        .find(s => s.startsWith('auth_token='))?.split('=')[1];
      const token = cookieToken || socket.handshake.auth?.token;
      if (!token) return;
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.userId?.toString() === userId?.toString() || decoded.isAdmin) {
          socket.join(`user-${userId}`);
        }
      } catch { /* invalid token — silently reject */ }
    });

    socket.on('join_merchant_room', (merchantId) => {
      const cookieHeader = socket.handshake.headers?.cookie || '';
      const cookieToken  = cookieHeader.split(';').map(s => s.trim())
        .find(s => s.startsWith('auth_token='))?.split('=')[1];
      const token = cookieToken || socket.handshake.auth?.token;
      if (!token) return;
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.isMerchant || decoded.isAdmin) {
          socket.join(`merchant-${merchantId}`);
        }
      } catch { /* invalid token — silently reject */ }
    });

    socket.on('join_admin_room', async (data) => {
      try {
        const token = data?.token;
        if (!token) return;
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.isAdmin || decoded.isSubAdmin) {
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
