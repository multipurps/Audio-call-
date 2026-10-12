// The call-mood picker's state, kept free of the DOM so every rule is testable.
//
// Rules: the user picks one mood. "Argue" exists only under Angry, only when switched on,
// and is dropped the moment another mood is picked. Natural (the default) sends nothing,
// so a call placed without touching the picker behaves exactly as it always did.

export const MOOD_OPTIONS = Object.freeze([
  { id: 'natural', label: 'Natural' },
  { id: 'angry', label: 'Angry' },
  { id: 'sassy', label: 'Sassy', sub: 'rude' },
  { id: 'sweet', label: 'Sweet' },
  { id: 'jovial', label: 'Jovial', sub: 'funny' },
  { id: 'sad', label: 'Sad', sub: 'emotional' },
  { id: 'talkative', label: 'Talkative' },
]);

export const DEFAULT_MOOD = Object.freeze({ mood: 'natural', argue: false });

const IDS = MOOD_OPTIONS.map((o) => o.id);

export function selectMood(state, mood) {
  if (!IDS.includes(mood)) return { ...state };
  // Re-picking Angry keeps the Argue switch where it was; any other pick clears it.
  return { mood, argue: mood === 'angry' ? Boolean(state.argue && state.mood === 'angry') : false };
}

export function toggleArgue(state) {
  return state.mood === 'angry' ? { ...state, argue: !state.argue } : { ...state };
}

export const argueVisible = (state) => state.mood === 'angry';

// The text on the floating button: "Mood" until something is chosen.
export function moodButtonLabel(state) {
  if (!state || state.mood === 'natural') return 'Mood';
  const label = MOOD_OPTIONS.find((o) => o.id === state.mood)?.label || 'Mood';
  return state.mood === 'angry' && state.argue ? 'Angry · Argue' : label;
}

// What is sent with the message. Natural sends nothing at all.
export function moodPayload(state) {
  if (!state || state.mood === 'natural' || !IDS.includes(state.mood)) return {};
  return state.mood === 'angry' ? { mood: 'angry', argue: Boolean(state.argue) } : { mood: state.mood };
}

// The chip floats only while the user is writing: the box is focused, has text, or the menu is open.
export function moodChipVisible({ focused = false, hasText = false, menuOpen = false } = {}) {
  return Boolean(focused || hasText || menuOpen);
}
