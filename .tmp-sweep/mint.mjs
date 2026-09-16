import { signToken } from '../backend/domains/identity/jwt.util.js';
import { db } from '#db';
const kind = process.argv[2];
if (kind === 'player') {
  const u = await db.users.getUser('player-ravi-001');
  console.log(await signToken({ userId: u.userId, mobile: u.mobile }));
} else {
  console.log(await signToken({ merchantId: process.env.MID, isMerchant: true }));
}
process.exit(0);
