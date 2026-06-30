// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * startup/seedAdmin.js — Auto-seed admin account on first boot.
 * Single responsibility: ensure admin user exists, nothing else.
 * Never crashes server if it fails — logs warning and continues.
 */
import mongoose from 'mongoose';
import bcrypt   from 'bcryptjs';

export async function seedAdminAccount() {
  try {
    const adminMobile   = process.env.DEFAULT_ADMIN_MOBILE;
    const adminPassword = process.env.DEFAULT_ADMIN_PASSWORD;

    if (!adminMobile || !adminPassword) {
      console.warn('⚠️  Skipping admin seed — DEFAULT_ADMIN_MOBILE or DEFAULT_ADMIN_PASSWORD not set');
      return;
    }

    const User = mongoose.model('User');
    const existingAdmin = await User.findOne({ isAdmin: true });
    if (existingAdmin) {
      // LOW-03 FIX: only re-hash if credentials actually changed
      const samePassword = await bcrypt.compare(adminPassword, existingAdmin.passwordHash || '');
      const sameMobile   = existingAdmin.mobile === adminMobile;
      if (!samePassword || !sameMobile) {
        const passwordHash = await bcrypt.hash(adminPassword, 12);
        await User.findByIdAndUpdate(existingAdmin._id, { mobile: adminMobile, passwordHash });
        console.log('✅ Admin credentials updated from env vars');
      } else {
        console.log('✅ Admin credentials unchanged — skipping re-hash');
      }
      return;
    }

    const passwordHash = await bcrypt.hash(adminPassword, 12);
    await User.create({
      username: 'Super Admin', mobile: adminMobile, passwordHash,
      // HIGH-09 FIX: removed walletBalance (not in User schema) and isMerchant (merchants are separate model)
      status: 'ACTIVE', kycStatus: 'APPROVED',
      isAdmin: true, isQueueManager: false, isSubAdmin: false,
      roles: ['user', 'admin']
    });
    console.log('✅ Admin account seeded successfully');
  } catch (error) {
    console.warn('⚠️  Admin seed failed (server still running):', error.message);
  }
}
