# Payments and security

## Guarantees and where they are enforced
- **Amounts:** taken from `payment_requests.amount_pence` (server side, via `checkout_prepare`), never from the browser.
- **Pay links:** a link that would now overcharge the player, for example after a cash part-payment or a cheaper re-split, is paused (`needs_review`) until an admin reissues it.
- **Concurrency:** concurrent checkouts reuse one reserved attempt, with an identical Stripe idempotency key and parameters, so only one Checkout Session is created. An open session is reused for up to an hour.
- **Webhooks:**
  - Signatures are verified with HMAC-SHA256 and a 300-second tolerance (`verifyStripeSignature`).
  - Events are recorded once (`stripe_events` primary key).
  - Payments are unique per PaymentIntent.
  - A payment is matched through our own checkout row, never by amount. Metadata or amount mismatches are recorded as `needs_review` and never mark the wrong player paid.
- **Redirects:** returning to the site after Stripe only shows "Confirming…". Only the webhook marks a request PAID.
- **Fees:** estimates (default 1.5% + 20p per payment, configurable) are labelled as estimates. The actual fee comes from the balance transaction, via the webhook or "Refresh actual fees from Stripe".
- **Access:**
  - Players can read only their own requests and balances.
  - Finance data needs `finance.view`, and refunds need `payments.refund` (Owner by default).
  - Only the Owner can switch Stripe mode.
  - Service-role functions can't be called with user tokens.
- **Audit:** price changes, attendance changes, request issuance, manual entries, voids, refunds, permission changes, settings changes and test-flag changes are all recorded in `admin_audit_log`.
- **No card data:** card details never reach CAFF. Checkout is Stripe-hosted with `payment_method_types=card` and nothing is saved.
- **Pricing:** there is no card surcharge. "Cover in price" charges everyone the same amount.

## Test versus live isolation
Two independent locks have to agree before money moves in a given mode:
1. **Lambda:** `STRIPE_MODE` (stack parameter `StripeMode`) must match the key's prefix (`sk_`/`rk_` with `_test_` or `_live_`). Otherwise every request returns 503.
2. **Database:** `payment_settings.stripe_mode` (Owner-only) must match the key, or checkout is refused. Webhook events from the other mode are ignored.

Test secrets live under `/caff/payments/`. Live secrets go under `/caff/payments-live/`, so they are never mixed.

## Live launch procedure (only after the owner approves)
1. The owner clicks **Get live account** (shown when leaving the CAFF sandbox) and completes Stripe's business, identity and payout-bank steps. Stripe then creates the live CAFF account (new `acct_` id, separate from sandbox `acct_1UUS7nIatQExHTBt`). Check the account menu shows CAFF live (no "Sandbox" banner) before continuing.
2. In the **live CAFF account** (not the sandbox, and never MotorPortal HQ):
   - Create a restricted key with the same 4 permissions as the test key: Checkout Sessions write, Charges and Refunds write, Payment Intents read, Balance read.
   - Create a webhook to `https://caffleague.com/api/stripe/webhook` with snapshot payloads and the same 10 events as test mode.
3. Store SecureStrings `/caff/payments-live/STRIPE_SECRET_KEY`, `/caff/payments-live/STRIPE_WEBHOOK_SECRET` and `/caff/payments-live/SUPABASE_SERVICE_ROLE_KEY` (the Supabase key can be the same one). The owner pastes the values; agents never handle them.
4. Update `caff-payments` with `StripeMode=live` and `SecretsPath=/caff/payments-live/` through a change set.
5. As Owner, set Admin → Sessions → Payment settings → Stripe mode to Live.
6. Smoke test without charging: open a pay link and confirm Checkout shows live mode with no "Sandbox" badge, then cancel. Ask the owner before any real payment.

Rollback: set Payment settings back to Test and update the stack to `StripeMode=test` and `SecretsPath=/caff/payments/`.

## Known test data
Session `68e3f37d-dc04-4185-a532-07cec6049783`, "TEST - Stripe test-mode check", holds one £1.00 test payment (fee 23p). Keep it. Migration 002 marks it `is_test`, which hides it from normal lists, player views and reporting.
