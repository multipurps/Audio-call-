// What a plan includes, in one place, so the server and the screens never disagree.
//
// Premium is the paid plan (sql/037: user_usage.premium_until in the future). Everything that is
// limited by plan is decided on the SERVER from this file; the app only mirrors it for display.

import { premiumState } from './billing.js';

// Custom (cloned) voice slots per account. A free account keeps one; Premium keeps five.
export const VOICE_SLOTS = Object.freeze({ free: 1, premium: 5 });

export const voiceSlotsFor = (premium) => (premium ? VOICE_SLOTS.premium : VOICE_SLOTS.free);

export const PREMIUM_REQUIRED = 'premium_required';

/**
 * Is this user on an active Premium plan?
 *   { premium, known }  known=false means the plan could not be read (a database hiccup). Callers
 *   must NOT treat that as "free": a paying user would be told they have no Premium. They answer
 *   "try again" instead. A database that predates sql/037 has no premium users, so a missing
 *   premium_until column is a definite "free".
 */
export async function premiumForUser(supabase, userId, nowMs = Date.now()) {
  if (!supabase || !userId) return { premium: false, known: false };
  try {
    const { data, error } = await supabase.from('user_usage').select('premium_until').eq('user_id', userId).maybeSingle();
    if (error) {
      if (/premium_until|42703|does not exist/i.test(`${error.code || ''} ${error.message || ''}`)) return { premium: false, known: true };
      console.warn('[plan] could not read the plan:', error.code || '', String(error.message || '').slice(0, 120));
      return { premium: false, known: false };
    }
    return { premium: premiumState(data, nowMs).premium, known: true };
  } catch (err) {
    console.warn('[plan] plan lookup failed:', String(err?.message || err).slice(0, 120));
    return { premium: false, known: false };
  }
}
