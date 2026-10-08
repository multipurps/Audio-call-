-- Minute purchases: record a failed payment as its own state.
--
-- Until now a payment the provider reported as failed could only be stored as
-- 'cancelled'. The app already works without this migration (it falls back to
-- 'cancelled'), but with it Home can tell "your payment failed" apart from
-- "you cancelled".
--
-- Safe to run more than once.

alter table minute_purchases drop constraint if exists minute_purchases_status_check;
alter table minute_purchases
  add constraint minute_purchases_status_check
  check (status in ('pending', 'paid', 'expired', 'cancelled', 'failed'));
