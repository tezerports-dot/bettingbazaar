// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * routes/admin/index.js
 * Aggregates all admin domain sub-routers into a single Express router.
 * server.js mounts this at: app.use('/api/admin', adminRoutes)
 *
 * Adding a new admin domain = create new file + one import + one use() here.
 * Zero changes to server.js required.
 */
import express from 'express';
import analyticsRoutes  from '../../domains/analytics/analytics.admin.routes.js';
import usersRoutes      from './users.admin.routes.js';
import subAdminsRoutes  from './subadmins.admin.routes.js';
import accountRoutes    from './account.admin.routes.js';
import merchantsRoutes  from '../../domains/merchant/merchant.admin.routes.js';
import brandingRoutes   from './branding.admin.routes.js';
import contentRoutes    from '../../domains/cms/content.admin.routes.js';
import disputesRoutes   from '../../domains/disputes/disputeResolution.admin.routes.js';
import utrRoutes        from './utr.admin.routes.js';
import merchantAssignmentRoutes from '../../domains/merchant/merchant.assignment.routes.js';
import paymentOrderRoutes       from '../../domains/payment/paymentOrder.routes.js';
import cyclesRoutes     from './cycles.admin.routes.js';
import boardsRoutes     from './boards.admin.routes.js';
import boardRulesRoutes from './boardRules.admin.routes.js';
import systemRoutes     from './system.admin.routes.js';
import auditRoutes      from './audit.admin.routes.js';
import depositPolicyRoutes from '../../domains/configuration/depositPolicy.admin.routes.js';
import revenueRoutes    from '../../domains/revenue/revenue.admin.routes.js';
import merchantPlatformRoutes from '../../domains/merchant/merchantPlatform.admin.routes.js';
// Telegram config (replaceable bot/channel), bulk KYC, referral disbursal.
import telegramAdminRoutes    from './telegram.admin.routes.js';
import communicationRoutes from '../../domains/communication/communication.admin.routes.js';
import operationsRoutes from '../../domains/operations/operations.admin.routes.js';
import reportingRoutes from '../../domains/reporting/reporting.admin.routes.js';
import supportAdminRoutes from '../../domains/support/support.admin.routes.js'; // CAP-71: RAG support assistant
import chatRoutes        from './chat.admin.routes.js'; // Public chat moderation + support-ticket desk
import androidReleaseRoutes from '../../domains/distribution/androidRelease.admin.routes.js';
import ipBlocksRoutes from './ipBlocks.admin.routes.js';
import teamAdminRoutes from '../../domains/team/team.admin.routes.js';
import merchantAccountAdminRoutes from '../../domains/merchant/merchantAccount.admin.routes.js';
import usdtDepositAdminRoutes from '../../domains/payment/usdtDeposit.admin.routes.js';
import { authenticateStaff } from '../../domains/identity/auth.middleware.js';

const router = express.Router();

// Every /api/admin sub-router is for STAFF accounts only (§33.5). A player's
// or merchant's session is refused here, 403 WRONG_PANEL, before any route
// asks for an area; sub-routes still ask for theirs.
router.use(authenticateStaff);

router.use('/', analyticsRoutes);
router.use('/', usersRoutes);
router.use('/', subAdminsRoutes);
router.use('/', accountRoutes);
router.use('/', merchantsRoutes);
router.use('/', brandingRoutes);
router.use('/', contentRoutes);
router.use('/', disputesRoutes);
router.use('/', utrRoutes);
router.use('/', merchantAssignmentRoutes);
router.use('/', paymentOrderRoutes);
router.use('/', cyclesRoutes);
router.use('/', boardsRoutes);
router.use('/', boardRulesRoutes);
router.use('/', systemRoutes);
router.use('/', auditRoutes);
router.use('/', depositPolicyRoutes);
router.use('/', revenueRoutes);
router.use('/', merchantPlatformRoutes);
router.use('/', ipBlocksRoutes);
router.use('/', teamAdminRoutes);
router.use('/', merchantAccountAdminRoutes);
router.use('/', usdtDepositAdminRoutes);
router.use('/', telegramAdminRoutes);
router.use('/', communicationRoutes);
router.use('/', operationsRoutes);
router.use('/', reportingRoutes);
router.use('/', supportAdminRoutes);
router.use('/', chatRoutes);
router.use('/', androidReleaseRoutes);

export default router;
