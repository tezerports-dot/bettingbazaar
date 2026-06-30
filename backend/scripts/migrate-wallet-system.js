/**
 * MIGRATION STATUS: APPLIED — do not re-run.
 * H-08 / GOVERNANCE: applied migrations must be deleted after all environments confirm.
 * This file is kept only for audit trail. Delete it once confirmed in production.
 */
// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

async function migrateWalletSystem() {
  try {
    console.log('🔄 Starting wallet system migration...');
    console.log('📊 Connecting to MongoDB...');
    
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');
    
    const { User, TokenRates } = await import('../models/index.js');
    
    // 1. Create default token rates
    console.log('\n📝 Step 1: Creating default token rates...');
    let rates = await TokenRates.findOne({ key: 'main' });
    
    if (!rates) {
      rates = await TokenRates.create({
        key: 'main',
        buyRate: 1.1,
        sellRate: 1.0,
        updatedAt: new Date()
      });
      console.log('✅ Created default token rates:');
      console.log(`   Buy Rate: ₹${rates.buyRate} per token`);
      console.log(`   Sell Rate: ₹${rates.sellRate} per token`);
      console.log(`   Merchant Profit: ₹${(rates.buyRate - rates.sellRate)} per token`);
    } else {
      console.log('ℹ️  Token rates already exist');
      console.log(`   Buy Rate: ₹${rates.buyRate} per token`);
      console.log(`   Sell Rate: ₹${rates.sellRate} per token`);
    }
    
    // 2. Migrate existing users
    console.log('\n📝 Step 2: Migrating user balances...');
    const users = await User.find({});
    let migratedCount = 0;
    let initializedCount = 0;
    
    for (const user of users) {
      if (user.walletBalance && user.walletBalance > 0 && !user.depositBalance && !user.winningsBalance) {
        user.depositBalance = user.walletBalance;
        user.winningsBalance = 0;
        user.lockedBalance = user.lockedBalance || 0;
        user.lockedDepositAmount = 0;
        user.lockedWinningsAmount = 0;
        
        await user.save();
        migratedCount++;
        console.log(`✅ Migrated ${user.mobile}: ₹${user.walletBalance} → depositBalance`);
      } else if (!user.depositBalance && !user.winningsBalance) {
        user.depositBalance = 0;
        user.winningsBalance = 0;
        user.lockedBalance = 0;
        user.lockedDepositAmount = 0;
        user.lockedWinningsAmount = 0;
        await user.save();
        initializedCount++;
      }
    }
    
    console.log(`\n✅ Migration complete!`);
    console.log(`   Total users processed: ${users.length}`);
    console.log(`   Users migrated: ${migratedCount}`);
    console.log(`   Users initialized: ${initializedCount}`);
    console.log(`\n💡 Next steps:`);
    console.log(`   1. Admin can set token rates in admin panel`);
    console.log(`   2. Users purchase tokens → depositBalance (NON-WITHDRAWABLE)`);
    console.log(`   3. Winnings from bets → winningsBalance (WITHDRAWABLE)`);
    console.log(`   4. Only winningsBalance can be withdrawn`);
    console.log(`\n🎯 System is ready for production!`);
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\n👋 Disconnected from MongoDB');
    process.exit(0);
  }
}

migrateWalletSystem();
