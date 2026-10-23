// The line on the empty chat screen. It follows the time of day, changes from visit to visit, and
// sounds like a person. It never says "Good night" (that is a goodbye, not a greeting) and never
// falls back to "what can I help you with today?".

export function timeBand(hour) {
  if (hour < 5) return 'lateNight';
  if (hour < 9) return 'earlyMorning';
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  if (hour < 21) return 'evening';
  return 'night';
}

// {name} is the first name. Without one, the name and its comma simply drop out.
export const GREETINGS = {
  lateNight: [
    'Still up, {name}?',
    'Late one, {name}. What\u2019s on your mind?',
    'The night shift, {name}. Who are we calling?',
    'Burning the midnight oil, {name}?',
    'Quiet hours. Good time to get things done.',
  ],
  earlyMorning: [
    'Up early, {name}.',
    'Morning, {name}. Let\u2019s get ahead of the day.',
    'Early start. What\u2019s first, {name}?',
    'Good morning, {name}.',
  ],
  morning: [
    'Morning, {name}. What\u2019s on the list?',
    'Good morning, {name}.',
    'Hey {name}. Let\u2019s clear a few things off your list.',
  ],
  afternoon: [
    'Afternoon, {name}.',
    'Good afternoon, {name}. What are we getting done?',
    'Hey {name}. Anyone you need me to call?',
  ],
  evening: [
    'Good evening, {name}.',
    'Evening, {name}. Who needs a call?',
    'Hey {name}. How did the day go?',
  ],
  night: [
    'Evening, {name}. Winding down or getting started?',
    'Late evening, {name}. What\u2019s left on the list?',
    'Hey {name}. One last thing before bed?',
  ],
};

export function firstName(name) {
  const token = String(name || '').trim().split(/\s+/)[0] || '';
  if (!token || token.length > 20 || token.includes('@')) return '';
  return token.charAt(0).toUpperCase() + token.slice(1);
}

function fill(template, name) {
  if (name) return template.replace('{name}', name);
  return template.replace(/,?\s*\{name\}/, '').replace(/\s+([.?!])/g, '$1');
}

// `last` is the line shown the previous time, so the same one does not appear twice in a row.
export function greetingForNow(name, { now = new Date(), random = Math.random, last = null } = {}) {
  const pool = GREETINGS[timeBand(now.getHours())];
  const who = firstName(name);
  const lines = pool.map((t) => fill(t, who));
  const fresh = lines.filter((l) => l !== last);
  const choices = fresh.length ? fresh : lines;
  return choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))];
}
