// The first thing a new person gets after they pay (or are granted credit): a short welcome from the assistant,
// in its own chat. Only for accounts with no chat history at all, and only once.
export const WELCOME_TITLE = 'Welcome to Emysa';

export function welcomeMessages(name) {
  const who = String(name || '').trim();
  return [
    `Hi${who ? ` ${who}` : ''}, I'm Emysa. I make and answer calls for you, in your voice.`,
    "The best way to use me is to talk to me like you would a person. Tell me who to call and what you need, and I'll handle the call.",
    'Who should I call first?',
  ];
}

async function nameFor(supabase, userId) {
  try {
    const { data } = await supabase.from('profiles').select('name').eq('user_id', userId).maybeSingle();
    if (data?.name) return String(data.name).trim().split(/\s+/)[0];
  } catch { /* fall through */ }
  try {
    const { data } = await supabase.auth.admin.getUserById(userId);
    const email = data?.user?.email || '';
    return email.split('@')[0] || '';
  } catch { return ''; }
}

// Returns the welcome chat's session id (existing or new), or null for accounts that already have history.
export async function sendWelcomeOnce(supabase, userId) {
  try {
    const { data: existing } = await supabase.from('chat_sessions').select('id').eq('user_id', userId).eq('title', WELCOME_TITLE).limit(1).maybeSingle();
    if (existing) return existing.id;
    const { count } = await supabase.from('assistant_messages').select('id', { count: 'exact', head: true }).eq('user_id', userId);
    if (count) return null; // already uses the app: not a new account
    const { data: session, error } = await supabase.from('chat_sessions').insert({ user_id: userId, title: WELCOME_TITLE }).select('id').single();
    if (error || !session) return null;
    const base = Date.now();
    const rows = welcomeMessages(await nameFor(supabase, userId)).map((content, i) => ({
      user_id: userId, session_id: session.id, role: 'assistant', content, source: 'text',
      created_at: new Date(base + i * 1000).toISOString(),
    }));
    const { error: msgErr } = await supabase.from('assistant_messages').insert(rows);
    if (msgErr) { await supabase.from('chat_sessions').delete().eq('id', session.id); return null; }
    return session.id;
  } catch (err) {
    console.error('welcome message failed (non-fatal):', err?.message);
    return null;
  }
}

export async function welcomeSessionFor(supabase, userId) {
  try {
    const { data } = await supabase.from('chat_sessions').select('id').eq('user_id', userId).eq('title', WELCOME_TITLE).limit(1).maybeSingle();
    return data?.id || null;
  } catch { return null; }
}
