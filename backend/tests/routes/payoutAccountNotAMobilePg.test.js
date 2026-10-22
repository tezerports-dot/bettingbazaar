// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A bank account whose number is somebody's mobile cannot be saved (§24, Step 2d).
 *
 * The member's account is shown to the player on a bank-transfer buy, and the
 * player's to the member on a sell. Payments banks issue the customer's mobile
 * as the account number, so such an account would show it to the other side
 * (owner, 2026-10-03: "make sure nowhere you expose anyone's mobile numbers").
 *
 * Pinned on every path that saves one (a player's bank details, a member's
 * profile) and on the row itself, with the opposite cases:
 * a ten-digit account at a regular bank and a twelve-digit payments-bank
 * account are accounts, not phone numbers, and go through.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { getUser } from '#db/repositories/users.js';
import { getMerchant, updateMerchant } from '#db/repositories/merchants.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('an account number that is a mobile number', () => {
  let userApp, merchantApp;
  // Every account this run may give bank details to. A save the rule refuses
  // writes nothing — unless the rule is broken (a mutation run), and then the
  // row it let through must not outlive the run: it would fail the next
  // schema apply on this database (trap 10).
  const players = [];
  const members = [];
  const newPlayer = async () => { const p = await actor({}); players.push(p.userId); return p; };
  const newMember = async () => { const m = await merchantActor({}); members.push(m.merchantId); return m; };
  // An account number no earlier run holds (the (number, IFSC) pair is unique).
  const regularAccount = () => `5010${String(Date.now()).slice(-8)}${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`;
  const someoneElse = () => `9${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;

  beforeAll(async () => {
    await applySchema();
    userApp = mountRouter((await import('../../domains/user/user.routes.js')).default);
    merchantApp = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
  }, 60_000);

  afterAll(async () => {
    // Trap 10: only this run's accounts.
    await pgQuery('UPDATE users SET bank_details = NULL WHERE user_id = ANY($1)', [players]);
    await pgQuery(`UPDATE merchants SET bank_account_no = NULL, bank_ifsc = NULL, bank_account_holder_name = 'A Member', bank_name = 'Some Bank'
                    WHERE merchant_id = ANY($1)`, [members]);
    await closePg();
  });

  const refused = (res) => {
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.code).toBe('ACCOUNT_IS_A_MOBILE');
    expect(res.body.message).toMatch(/mobile number.*regular bank/);
  };

  describe('a player saving where their sells are paid', () => {
    const save = (me, accountNumber, ifscCode, names = {}) => as(userApp, me).put(`/user/${me.userId}/bank-details`)
      .send({ accountHolderName: 'A Player', accountNumber, ifscCode, bankName: 'Some Bank', upiId: 'a.player@okaxis', ...names });

    it('refuses a payments-bank account, whoever\'s number it is', async () => {
      const me = await newPlayer();
      for (const [number, ifsc] of [[someoneElse(), 'PYTM0123456'], [`91${someoneElse()}`, 'AIRP0000001'], [someoneElse(), 'jiop0000001']]) {
        refused(await save(me, number, ifsc));
      }
      expect((await getUser(me.userId)).bankDetails ?? null).toBeNull();
    });

    it('refuses their own mobile at any bank, however it is spelled', async () => {
      const me = await newPlayer();
      refused(await save(me, me.mobile, 'HDFC0001234'));
      refused(await save(me, `0${me.mobile}`, 'SBIN0001234'));
      refused(await save(me, `${me.mobile.slice(0, 5)} ${me.mobile.slice(5)}`, 'ICIC0001234'));
      expect((await getUser(me.userId)).bankDetails ?? null).toBeNull();
    });

    it('refuses a mobile number written into the holder\'s name or the bank\'s name', async () => {
      const me = await newPlayer();
      const account = regularAccount();
      refused(await save(me, account, 'HDFC0001234', { accountHolderName: `Ravi ${someoneElse()}` }));
      refused(await save(me, account, 'HDFC0001234', { accountHolderName: 'Ravi +91 98765-43210' }));
      refused(await save(me, account, 'HDFC0001234', { bankName: 'HDFC call 0091 98765 43210' }));
      expect((await getUser(me.userId)).bankDetails ?? null).toBeNull();
    });

    it('takes a ten-digit account at a regular bank, and a payments-bank account that is not a mobile', async () => {
      const me = await newPlayer();
      const kotak = someoneElse();
      expect((await save(me, kotak, 'KKBK0000123')).status).toBe(200);
      expect((await getUser(me.userId)).bankDetails.accountNumber).toBe(kotak);
      // Another player: a save locks the details for 48 hours.
      const other = await newPlayer();
      expect((await save(other, '100012345678', 'IPOS0000001')).status).toBe(200);
      expect((await getUser(other.userId)).bankDetails.accountNumber).toBe('100012345678');
    });
  });

  describe('a member saving where bank-transfer buys are paid', () => {
    const save = (member, accountNo, ifsc, names = {}) => as(merchantApp, member).put('/profile')
      .send({ bankDetails: { accountHolderName: 'A Member', bankName: 'Some Bank', accountNo, ifsc, ...names } });

    it('refuses a payments-bank account and their own mobile, and keeps the account they had', async () => {
      const member = await newMember();
      const before = (await getMerchant(member.merchantId)).bankDetails.accountNo;
      refused(await save(member, someoneElse(), 'PYTM0123456'));
      refused(await save(member, member.mobile, 'HDFC0000123'));
      // However the IFSC and the number are typed: this route stores the IFSC as sent.
      refused(await save(member, someoneElse(), ' pytm 0123456'));
      refused(await save(member, `0091${someoneElse()}`, 'Airp0000001'));
      refused(await save(member, regularAccount(), 'HDFC0000123', { accountHolderName: `Shop ${someoneElse()}` }));
      expect((await getMerchant(member.merchantId)).bankDetails.accountNo).toBe(before);
    });

    it('takes a regular account', async () => {
      const member = await newMember();
      const account = regularAccount();
      const res = await save(member, account, 'HDFC0000123', { accountHolderName: 'Shop 42 Ltd', bankName: 'HDFC Bank, Branch 110001' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await getMerchant(member.merchantId)).bankDetails.accountNo).toBe(account);
    });

    it('is refused by the row, so no other writer can store one either', async () => {
      const member = await newMember();
      await expect(updateMerchant(member.merchantId, {
        'bankDetails.accountNo': someoneElse(), 'bankDetails.ifsc': 'AIRP0000001',
      })).rejects.toMatchObject({ code: '23514', constraint: 'merchants_bank_account_not_a_mobile' });
      await expect(pgQuery(
        `UPDATE users SET bank_details = jsonb_build_object('accountNumber', mobile, 'ifscCode', 'HDFC0000001')
          WHERE user_id = $1`, [(await newPlayer()).userId],
      )).rejects.toMatchObject({ code: '23514', constraint: 'users_bank_account_not_a_mobile' });
    });
  });

  // A member's application no longer carries a bank account (owner,
  // 2026-10-14: a merchant applies by Continue with Telegram, and an admin's
  // create takes a name and a mobile only), so `PUT /profile` above is the
  // one route that writes a member's account. What the application used to
  // be held to is held there.
  //
  // A member's UPI ID (owner, 2026-10-21): a player paying a UPI buy is given
  // a link built from it, so one that is a mobile is refused by the row
  // (`merchants_upi_id_shape`), and one inside the bank details is not read.
  describe('a member\'s UPI ID', () => {
    it('refuses one that is a mobile, however it is spelled, and keeps the one they had', async () => {
      const member = await newMember();
      const handle = someoneElse();
      for (const upiId of [`${handle}@okaxis`, `${member.mobile}@ybl`, `91${handle}@paytm`]) {
        const res = await as(merchantApp, member).put('/profile').send({ upiId });
        expect(res.status, upiId).toBe(400);
        expect(res.body.code).toBe('UPI_ID_IS_A_MOBILE');
      }
      expect((await getMerchant(member.merchantId)).upiId).toBeNull();
    });

    it('keeps one that is not a mobile, and never one inside the bank details', async () => {
      const member = await newMember();
      const res = await as(merchantApp, member).put('/profile').send({
        upiId: 'Shop.Counter42@OKAXIS',
        bankDetails: { accountHolderName: 'A Member', accountNo: regularAccount(), ifsc: 'HDFC0000778', bankName: 'Some Bank', upiId: 'other@ybl' },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const merchant = await getMerchant(member.merchantId);
      expect(merchant.upiId).toBe('shop.counter42@okaxis');
      expect(merchant.bankDetails).not.toHaveProperty('upiId');
      expect(JSON.stringify(merchant)).not.toMatch(/other@ybl/);
      expect((await as(merchantApp, member).put('/profile').send({ upiId: 'no-at-sign' })).body.code).toBe('UPI_ID_INVALID');
    });
  });
});
