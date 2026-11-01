// API keys live ONLY in the server environment (Vercel / Render). They are never stored per
// person, never shown in admin, and never sent to the app.
const NAMES = { anam: 'ANAM_API_KEY', xmax: 'XMAX_API_KEY' };

export function serverKey(provider, env = process.env) {
  const name = NAMES[provider];
  return name ? ((env[name] || '').trim() || null) : null;
}
