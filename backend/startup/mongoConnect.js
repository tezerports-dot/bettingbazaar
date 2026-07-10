// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * startup/mongoConnect.js — MongoDB connection with retry logic.
 * Single responsibility: connect to MongoDB, nothing else.
 */
import mongoose from 'mongoose';

export async function connectMongoDB() {
  let attempts = 0;
  const MAX_ATTEMPTS = 10;
  while (attempts < MAX_ATTEMPTS) {
    try {
      await mongoose.connect(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: 30000,
        connectTimeoutMS:         30000,
        socketTimeoutMS:          45000,
        // Phase F (2026-07-10): pool sized via env so horizontal scaling can
        // tune per-instance connections against the Atlas tier's connection
        // budget without a code change. Defaults preserve prior behavior.
        maxPoolSize:              Number(process.env.MONGO_MAX_POOL_SIZE || 10),
        minPoolSize:              Number(process.env.MONGO_MIN_POOL_SIZE || 2),
        dbName:                   'bettingbazaar'
      });
      console.log('✅ MongoDB Connected');
      return;
    } catch (error) {
      attempts++;
      console.error(`❌ MongoDB connection failed (attempt ${attempts}/${MAX_ATTEMPTS}):`, error.message);
      if (attempts >= MAX_ATTEMPTS) {
        console.error('❌ MongoDB giving up after max retries. Check MONGODB_URI.');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}
