// The mood the user picked for a call, validated in one place.
//
// The app sends { mood, argue }. Only a known mood is ever stored or used; anything
// else (missing, "natural", unknown, "argue" without "angry") means "no mood", which
// is exactly how every call behaved before this existed.
//
// Stored as ONE short value in calls.mood / call_plans.mood:
//   angry | angry_argue | sweet | jovial | sad | talkative   (natural = null)
// "argue" exists only for an angry call and only when the user switched it on.
export const MOODS = Object.freeze(['natural', 'angry', 'sweet', 'jovial', 'sad', 'talkative']);
export const STORED_MOODS = Object.freeze(['angry', 'angry_argue', 'sweet', 'jovial', 'sad', 'talkative']);

export function normalizeMood(mood, argue = false) {
  if (typeof mood !== 'string') return null;
  const m = mood.trim().toLowerCase();
  if (m === 'angry') return argue === true ? 'angry_argue' : 'angry';
  return STORED_MOODS.includes(m) ? m : null; // 'angry_argue' passes through (a signed pending call carries it)
}

// Spread into an insert: nothing at all when there is no mood, so an un-migrated
// database (no `mood` column yet) is never touched by a call that did not pick one.
export const moodFields = (mood) => (normalizeMood(mood) ? { mood: normalizeMood(mood) } : {});

export const isMissingMoodColumn = (error) => /\bmood\b/i.test(String(error?.message || ''));

// The mood of an earlier call, so "try again" keeps it. Best effort: never throws.
export async function moodOfCall(supabase, callId) {
  if (!callId) return null;
  try {
    const { data, error } = await supabase.from('calls').select('mood').eq('id', callId).maybeSingle();
    return error ? null : normalizeMood(data?.mood);
  } catch {
    return null;
  }
}
