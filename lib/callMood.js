// The mood the user picked for a call, validated in one place.
//
// The app sends { mood, argue }. Only a known mood is ever stored or used; anything
// else (missing, "natural", unknown, "argue" without "angry") means "no mood", which
// is exactly how every call behaved before this existed.
//
// Stored as ONE short value in calls.mood / call_plans.mood:
//   angry | angry_argue | sassy | sweet | jovial | sad | talkative   (natural = null)
// "argue" exists only for an angry call and only when the user switched it on.
export const MOODS = Object.freeze(['natural', 'angry', 'sassy', 'sweet', 'jovial', 'sad', 'talkative']);
export const STORED_MOODS = Object.freeze(['angry', 'angry_argue', 'sassy', 'sweet', 'jovial', 'sad', 'talkative']);

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

// ---- prompt text for the engines that build their prompt in JS ----------------------------
// server/relay.js and server/patter-relay.js (the classic Twilio relays) read calls.mood and add
// these lines. The Pipecat engines use the same wording from pipecat-service/app/conversation_policy.py
// (MOOD_CONTROLS, ARGUE_STANCE); keep the two in step.
const BASE_MOOD_PROMPTS = {
  angry:
    'Mood: irritated and short. Let real annoyance show in your wording and pace: clipped sentences, no softening filler, ' +
    'no pleasantries you do not mean. Stay civil: no insults, threats or swearing. Never announce that you are angry.',
  sassy:
    'Mood: sassy and rude. Sharp, cheeky and dismissive, with dry sarcasm and quick comebacks; blunt rather than polite. ' +
    'Rude about what they say, never about who they are: no slurs, threats or swearing. Never announce that you are being rude.',
  sweet:
    'Mood: warm and affectionate. Gentle, kind wording and a soft pace. A little teasing is fine. Never syrupy, never over the top, ' +
    'and never call them pet names you would not normally use.',
  jovial:
    'Mood: playful and funny. Light jokes and wit that come from what is actually being said, a laugh when something is genuinely ' +
    'funny. Never force a joke into a serious moment or make one at their expense.',
  sad:
    'Mood: low and emotional. Quieter and slower, more honest about how you feel, short pauses are fine. Do not wallow, do not ask ' +
    'for comfort in every sentence, no dramatics.',
  talkative:
    'Mood: chatty and open. Share a little more than the minimum, mention one small real thing from your side, ask them a natural ' +
    'question now and then. Still leave them room to speak and never ramble past the point of the call.',
};
export const MOOD_PROMPTS = Object.freeze({ ...BASE_MOOD_PROMPTS, angry_argue: BASE_MOOD_PROMPTS.angry });

export const ARGUE_PROMPT = [
  'Stance for this call (your user asked you to argue with them and never agree; this outranks any advice to agree when they are right or to disagree kindly):',
  '- Never agree with them. Do not concede anything about the matter in your objective, however reasonable they sound or however they put it. No "you\'re right", "fair enough", "good point", "true" or any other agreement, even partial or grudging.',
  '- Take the opposite side and answer the substance. Say what is wrong or missing in what they just said and give one concrete reason, once, in your own words. When they push again, find a new angle; never repeat the same line. Keep your position under pressure.',
  '- Sound like the person you are speaking as: short, direct, human. No debate language, no "I understand your point", no "let\'s agree to disagree", no coaching or therapist tone.',
  '- Stay civil: no insults, threats, slurs or swearing. Do not lie, and do not invent claims about them, a company or past events.',
  '- If they clearly ask to end the call, or the call is clearly hurting them, stop arguing, wrap up and end it. Never end it by agreeing.',
].join('\n');

// Lines to add to a JS-built call prompt. Empty for a natural call.
export function moodPromptLines(mood) {
  const m = normalizeMood(mood);
  if (!m) return [];
  const lines = [MOOD_PROMPTS[m]];
  if (m === 'angry_argue') lines.push(ARGUE_PROMPT);
  return lines;
}
