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
   - optional: `BACHS_CURRENCY` (default `NGN`) and `BACHS_PACKS` to change the packs
     without a code change (see Prices). Bachs minimums apply per currency (for example
     1000 for NGN). The older `BACHS_PRICES`, `BACHS_UNIT_MINUTES`, `BACHS_UNIT_AMOUNT`
     and `BACHS_MAX_QTY` settings are no longer read; any left in Vercel do nothing.
3. In the Bachs dashboard add a webhook endpoint
   `https://<your-app>/api/bachs-webhook` for the `checkout.completed` event
   (other events are acknowledged and ignored).
4. Test in sandbox first: pay with a sandbox key, confirm the balance on Home
   increases, then switch the keys to live.

## Prices

The app sells six packs, in naira by default:

| Pack | Price |
|---|---|
| 30 minutes | 15,000 |
| 1 hour | 28,000 |
| 2 hours | 43,000 |
| 3 hours | 56,000 |
| 4 hours | 68,000 |
| 5 hours | 80,000 |

The app only ever sends which pack was picked (1 = the first, 2 = the second, and
so on); the server looks up the minutes and the price, so a client can never choose
its own. To change them without a code change, set `BACHS_PACKS` in Vercel as
`minutes:price,minutes:price,...`, for example `30:15000,60:28000`. A list that does
not parse is ignored as a whole and the defaults are used, so a typo cannot charge 0.
A purchase that is already open keeps the price it was created with.

## Admin alerts and admin access

- Every paid purchase sends a web-push alert to the owner and to each approved admin
  who turned on **Purchase alerts** in the admin Overview (it needs the existing
  `VAPID_*` settings). It goes out only from the call that actually credits the minutes,
  so a replayed webhook never alerts twice, and an alert that fails never affects the
  buyer's minutes.
- Run `sql/034_admin_access.sql` once. The owner is still the `ADMIN_EMAIL` account. In
  the admin page, **Admins** (owner only) approves, removes or re-approves other people,
  for example an investor who needs to see revenue. Approved admins can use everything
  in the admin panel except managing admins. Approval only counts once that email
  address is confirmed.
