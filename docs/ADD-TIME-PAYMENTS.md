# Add time: paying for call minutes with Bachs

Home shows the balance (`monthly_minute_limit + bonus_minutes - call_minutes_used`)
and an **Add time** button. It opens a full page: a 1x-10x stepper over one unit of
call time (default 5 hours for $30) and a **Purchase** button that opens the Bachs
hosted checkout. Card and bank details never touch Emysa.

## How a payment flows

1. The app sends only a `quantity` to `POST /api/referrals?action=checkout`.
   The server owns the price list (`lib/billing.js`), writes a `pending` row in
   `minute_purchases` and asks Bachs for a checkout session.
2. The app opens the checkout in a separate window, so the installed PWA is never
   navigated away. If the window is blocked, a "Tap to continue to payment" link
   appears (a real tap always works, including in an installed PWA).
3. Bachs redirects to `/pay-return.html` (same origin and PWA scope) which only
   says thanks or "cancelled" and offers **Back to Emysa**. It never adds minutes.
4. Minutes are credited **only on the server**, once, by
   `credit_minute_purchase()` after Bachs itself reports the checkout `COMPLETED`
   for the expected reference, amount and currency:
   - the signed `checkout.completed` webhook (`/api/bachs-webhook`), or
   - `POST /api/referrals?action=billing-verify`, which the app calls when it
     returns to the foreground (and polls for up to two minutes), so a missed or
     delayed webhook never leaves a paid user waiting.
   Replays and races credit once: the function flips `pending -> paid` atomically.

Everything runs inside `api/referrals.js` (multiplexed by `?action=`) because
`api/` is at Vercel Hobby's 12-function cap.

## Setup (once)

1. Run `sql/025_minute_purchases.sql` in the Supabase SQL editor **before** deploying.
2. In Vercel, set:
   - `BACHS_API_KEY` — secret key. `sk_sandbox_...` automatically uses the sandbox API.
   - `BACHS_WEBHOOK_SECRET` — the signing secret of your webhook endpoint.
   - `PUBLIC_APP_URL` — already set for Twilio (no trailing slash).
   - optional: `BACHS_CURRENCY` (default `USD`), `BACHS_UNIT_MINUTES` (default `300`),
     `BACHS_UNIT_AMOUNT` (default `30.00`) and `BACHS_MAX_QTY` (default `10`).
     Bachs minimums apply per currency (for example 1000 for NGN), so set real
     prices here for the currency you charge in.
3. In the Bachs dashboard add a webhook endpoint
   `https://<your-app>/api/bachs-webhook` for the `checkout.completed` event
   (other events are acknowledged and ignored).
4. Test in sandbox first: pay with a sandbox key, confirm the balance on Home
   increases, then switch the keys to live.

## Prices

The defaults (5 hours for $30 per unit) are placeholders copied from the design
reference. Set your real price with the env vars above before going live.

The page does not promise an expiry: purchased minutes are added to
`bonus_minutes` and do not expire. If you want "valid for 30 days", expiry has to
be built first (per-purchase tracking).
