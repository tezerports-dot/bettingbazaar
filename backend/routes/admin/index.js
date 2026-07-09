// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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
import kycRoutes        from './kyc.admin.routes.js';
import subAdminsRoutes  from './subadmins.admin.routes.js';
import merchantsRoutes  from '../../domains/merchant/merchant.admin.routes.js';
import brandingRoutes   from './branding.admin.routes.js';
import contentRoutes    from '../../domains/cms/content.admin.routes.js';
import disputesRoutes   from '../../domains/disputes/disputeResolution.admin.routes.js';
import utrRoutes        from './utr.admin.routes.js';
import merchantAssignmentRoutes from '../../domains/merchant/merchant.assignment.routes.js';
import paymentOrderRoutes       from '../../domains/payment/paymentOrder.routes.js';
import cyclesRoutes     from './cycles.admin.routes.js';
import systemRoutes     from './system.admin.routes.js';
import auditRoutes      from './audit.admin.routes.js';
import depositPolicyRoutes from '../../domains/configuration/depositPolicy.admin.routes.js';
import merchantBonusPolicyRoutes from '../../domains/configuration/merchantBonusPolicy.admin.routes.js';
import revenueRoutes    from '../../domains/revenue/revenue.admin.routes.js';

const router = express.Router();

router.use('/', analyticsRoutes);
router.use('/', usersRoutes);
router.use('/', kycRoutes);
router.use('/', subAdminsRoutes);
router.use('/', merchantsRoutes);
router.use('/', brandingRoutes);
router.use('/', contentRoutes);
router.use('/', disputesRoutes);
router.use('/', utrRoutes);
router.use('/', merchantAssignmentRoutes);
router.use('/', paymentOrderRoutes);
router.use('/', cyclesRoutes);
router.use('/', systemRoutes);
router.use('/', auditRoutes);
router.use('/', depositPolicyRoutes);
router.use('/', merchantBonusPolicyRoutes);
router.use('/', revenueRoutes);

export default router;
