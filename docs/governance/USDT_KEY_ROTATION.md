# USDT deposit key runbook

How the keys behind USDT deposit addresses are kept, and how to rotate them. Rules live in `CLAUDE.md` §25 and §2 ("A USDT buy's address and what arrived"); this file is procedure.

Code: `backend/domains/payment/usdtBsc.js` (derivation, `keyIdOf`), `database/repositories/usdtDeposits.js` (address rows), `scripts/usdt-sweep.mjs` (offline sweep and `--xpub`).

## What protects the money

| Piece | Where it lives | What a thief gets from it |
| --- | --- | --- |
| Recovery phrase (12 or 24 words) | Offline only: paper or a hardware wallet, never a server, CI, chat or the repo | Everything not yet swept. This is the one secret. |
| `USDT_BEP20_XPUB` (account key at m/44'/60'/0') | Server environment | Can list our addresses. Cannot spend. |
| Deposit address per order (m/44'/60'/0'/0/<index>) | Derived for one order, never reused | One order's USDT until it is swept |
| Gas wallet (m/44'/60'/0'/1/0) | Same phrase | The small BNB kept on it for sweeps |
| Treasury address (`USDT_TREASURY_ADDRESS`) | A separate wallet, ideally a hardware wallet | Where swept USDT rests. Keep its phrase apart from the deposit phrase. |

So a hacked server leaks no spending key. Every order already gets a fresh address that is used once. What "rotating" changes is the phrase behind new addresses.

## When to rotate

- At once, if the phrase may have been seen: typed on a shared machine, photographed, stored online, or a device that held it was lost.
- On a schedule you choose, for example every six months.
- When a person who knew the phrase leaves.

## How to rotate

1. **Make a new phrase offline.** Use a hardware wallet or another standard BIP-39 tool on a machine with no network. Write it down. Do not reuse the old phrase with a new passphrase unless you mean to.
2. **Get its xpub**, on that offline machine:
   ```
   USDT_SWEEP_MNEMONIC="the new words" node scripts/usdt-sweep.mjs --xpub
   ```
   It prints `USDT_BEP20_XPUB=xpub…`, the key id, and the new gas wallet. It prints no private key and reads no network.
3. **Swap it on the server.** Put the new `USDT_BEP20_XPUB` in the server environment and restart. Admin › USDT Deposits now says "New addresses come from key <new key id>". Every buy from now on gets an address under the new key.
4. **Fund the new gas wallet** with a little BNB.
5. **Sweep the old addresses with the old phrase.** Buys opened before the swap keep their old addresses, which are still watched and credited. Download the sweep file and run the tool with the OLD phrase. It sweeps the old key's lines and refuses the new key's (the key id does not match). Run it again with the new phrase for the new key's lines. Paste both results files on Admin › USDT Deposits.
6. **Retire the old phrase** once its addresses are swept and no open buy uses it: wait out the payment window and the late-money watch (`usdtDeposits.paymentWindowMinutes`, `lateWatchHours`), sweep once more, then destroy the old phrase. Money sent to an old address after that is lost, so do not destroy it early.

## If the phrase leaked

Do steps 1 to 4 at once, then sweep every old address with the old phrase straight away (step 5), before the thief does. The sweep tool reads each address's live balance, so a line the thief already emptied shows as empty. Move the treasury too if its phrase was kept with the leaked one.

## What a rotation does not do

- It does not move USDT already on old addresses. Only the sweep does.
- It does not stop a payment a player is making to an old address right now; that order is still credited.
- It is not needed after a server breach alone: the server holds no private key. Rotate the server's other secrets instead.
