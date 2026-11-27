// Playground: your avatar or Live Swap with no call. It still costs what a video call costs (2 credits a
// minute), because the LLM, the avatar and Live Swap all use tokens. It is billed through the same `calls`
// row trigger as every call (sql/046): the row's duration_seconds is set from SERVER time, never the client's.
import { minutesLeft, minutesGate } from './billing.js';

export const PLAYGROUND_MAX_SECONDS = 10 * 60;
export const PLAYGROUND_MIN_CREDITS = 2; // the first minute is charged when it starts

// POST /api/assistant?action=playground  body: { op: 'start', kind } | { op: 'tick'|'end', id }
export async function playgroundRoute(req, res, supabase, userId, { now = () => Date.now() } = {}) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const body = req.body || {};
  try {
    if (body.op === 'start') {
      const left = await minutesLeft(supabase, userId);
      const gate = minutesGate(left);
      if (!gate.ok) return res.status(gate.status).json({ error: gate.error, code: gate.code });
      if (left.remaining < PLAYGROUND_MIN_CREDITS) {
        return res.status(402).json({ error: 'Playground needs at least 2 credits (video costs 2 credits a minute). Add credits to continue.', code: 'no-minutes' });
      }
      const kind = body.kind === 'swap' ? 'swap' : 'avatar';
      const { data, error } = await supabase.from('calls').insert({
        user_id: userId, platform: 'playground', to_number: 'playground',
        objective: kind === 'swap' ? 'Playground: Live Swap' : 'Playground: avatar',
        status: 'in_progress', is_video: true, transcript: [],
        duration_seconds: 1, // charges the first minute (2 credits) now
      }).select('id').single();
      if (error) throw error;
      const after = await minutesLeft(supabase, userId);
      return res.status(200).json({ id: data.id, remaining: after ? after.remaining : null });
    }
    if (body.op === 'tick' || body.op === 'end') {
      const id = String(body.id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'id required' });
      const { data: row, error: e1 } = await supabase.from('calls').select('id, created_at, status')
        .eq('id', id).eq('user_id', userId).eq('platform', 'playground').maybeSingle();
      if (e1) throw e1;
      if (!row) return res.status(404).json({ error: 'Playground session not found' });
      const secs = Math.max(1, Math.min(PLAYGROUND_MAX_SECONDS + 60, Math.ceil((now() - Date.parse(row.created_at)) / 1000)));
      if (row.status !== 'completed') {
        const { error: e2 } = await supabase.from('calls').update({
          duration_seconds: secs, status: body.op === 'end' ? 'completed' : 'in_progress',
        }).eq('id', id).eq('user_id', userId);
        if (e2) throw e2;
      }
      const left = await minutesLeft(supabase, userId);
      return res.status(200).json({ ok: true, seconds: secs, remaining: left ? left.remaining : null });
    }
    return res.status(400).json({ error: 'op must be start, tick or end' });
  } catch (err) {
    console.error(`[playground] user=${userId} ${err?.message}`);
    return res.status(500).json({ error: 'Playground could not start. Please try again.' });
  }
}
