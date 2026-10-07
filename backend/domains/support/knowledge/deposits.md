# Deposits — buying BB tokens

BettingBazaar uses **BB tokens** as the in-app balance. The conversion is fixed:
**1 BB token = ₹1**.

## How a deposit works (merchant P2P)

Deposits are fulfilled peer-to-peer by verified merchants, not by a card gateway:

1. On the Wallet page choose **Buy tokens** and pick one of the order sizes on
   offer (cash sizes up to ₹10,000; bank-transfer sizes from ₹50,000).
2. The system assigns your order to a merchant automatically. Where to pay
   appears only once that merchant has **accepted** the order; until then there
   is nothing to pay.
3. Pay the exact amount, for this order only:
   - a **bank-transfer size**: to the merchant's bank account shown on the
     order (account holder, account number and IFSC);
   - a **cash size**: the merchant goes to a cash machine and scans its QR for
     the exact amount; a **Pay** button then appears on the order, which opens
     your UPI app with that payment filled in.
   Merchants are never paid to a UPI ID, and no one is shown another person's
   mobile number.
4. Enter the **UTR / reference number** of the payment you made to confirm.
5. Once the payment is verified, your tokens are credited.

If no merchant is available, the system retries assignment briefly. If a merchant
still cannot be assigned after those attempts, the order fails and no money is
taken — you can simply try again.

## Which balance a deposit credits

Deposited tokens go into your **deposit balance**, which is **non-withdrawable**.
The deposit balance can be used to place bets. Money you can withdraw comes from
your **winnings balance** (see the Withdrawals help topic).

## Important safety points

- Always pay the **exact order amount** to the **exact merchant** shown for that
  order. Do not reuse an old QR code or pay a different account.
- Enter the correct **UTR** for the payment you actually made.
- If a merchant reports that a payment was not received, the account involved can
  be flagged for review. Only submit a UTR for a payment you genuinely completed.

Specific minimum/maximum amounts and any promotional bonuses are shown in the app
at the time of purchase and are set by the platform.
