// First-call tutorial: which line the example request goes out on, and how it is worded.
// The server never guesses between two lines, so the tutorial selects one explicitly.

const LABELS = { whatsapp: 'WhatsApp', telegram: 'Telegram' };
// Order used only when the person has several lines and has not picked one yet.
const PREFERENCE = ['whatsapp', 'telegram', 'phone'];

export const channelLabel = (channel) => LABELS[channel] || '';

// selected = the line already chosen in chat (kept if it is still linked); channels = { phone, whatsapp, telegram }.
export function pickFirstCallChannel({ selected = null, channels = {}, telegramEnabled = true } = {}) {
  const has = { phone: Boolean(channels.phone), whatsapp: Boolean(channels.whatsapp), telegram: telegramEnabled && Boolean(channels.telegram) };
  if (selected && has[selected]) return selected;
  return PREFERENCE.find((c) => has[c]) || null;
}

// Phone is the default line and has no label, so it reads as a plain "Call Ada ...".
export function firstCallPrompt(name, channel) {
  const label = channelLabel(channel);
  return `Call ${name}${label ? ` on ${label}` : ''} and tell them I said hello.`;
}

export function firstCallExplainer(name, channel) {
  const label = channelLabel(channel);
  return `This is your first request. Emysa will call ${name}${label ? ` on ${label}` : ''} for you.`;
}
