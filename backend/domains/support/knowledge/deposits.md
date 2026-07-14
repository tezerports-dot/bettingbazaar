# Deposits — buying BB tokens

BettingBazaar uses **BB tokens** as the in-app balance. The conversion is fixed:
**1 BB token = ₹1**.

## How a deposit works (merchant P2P)

Deposits are fulfilled peer-to-peer by verified merchants, not by a card gateway:

1. On the Wallet page choose **Buy tokens** and enter the amount.
2. The system assigns you a merchant automatically and shows that merchant's
   payment details — a **UPI ID and a UPI QR code** — for this specific order.
3. Pay the exact amount to that merchant using any UPI app by scanning the QR
   or using the UPI ID.
4. Enter the **UTR / reference number** from your UPI payment to confirm.
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
