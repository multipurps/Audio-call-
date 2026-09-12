import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';

const BONUS_MINUTES = 30;

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 confusion
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export default async function handler(req, res) {
  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  const action = req.query?.action || req.body?.action;

  if (action === 'redeem') return redeem(req, res, supabase, userId);
  return status(req, res, supabase, userId);
}

async function status(req, res, supabase, userId) {
  let { data: profile } = await supabase.from('profiles').select('referral_code').eq('user_id', userId).maybeSingle();

  let code = profile?.referral_code;
  if (!code) {
    // Extremely unlikely to collide given the alphabet/length, but retry once if it does.
    for (let attempt = 0; attempt < 3 && !code; attempt++) {
      const candidate = generateCode();
      const { error } = await supabase.from('profiles').upsert({ user_id: userId, referral_code: candidate }, { onConflict: 'user_id' });
      if (!error) code = candidate;
    }
  }

  const { count } = await supabase
    .from('profiles')
    .select('user_id', { count: 'exact', head: true })
    .eq('referred_by', userId);

  return res.status(200).json({ code, referralCount: count || 0, bonusPerReferral: BONUS_MINUTES });
}

async function redeem(req, res, supabase, userId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { code } = req.body || {};
  if (!code || !code.trim()) return res.status(400).json({ error: 'code required' });

  const { data: me } = await supabase.from('profiles').select('referred_by').eq('user_id', userId).maybeSingle();
  if (me?.referred_by) return res.status(200).json({ ok: true, note: 'already redeemed' });

  const { data: referrer } = await supabase
    .from('profiles')
    .select('user_id')
    .eq('referral_code', code.trim().toUpperCase())
    .maybeSingle();
  if (!referrer) return res.status(404).json({ error: 'Invalid referral code' });
  if (referrer.user_id === userId) return res.status(400).json({ error: "That's your own code" });

  await supabase.from('profiles').update({ referred_by: referrer.user_id }).eq('user_id', userId);

  for (const uid of [referrer.user_id, userId]) {
    const { data: usage } = await supabase.from('user_usage').select('bonus_minutes').eq('user_id', uid).maybeSingle();
    await supabase.from('user_usage').upsert(
      { user_id: uid, bonus_minutes: (usage?.bonus_minutes || 0) + BONUS_MINUTES },
      { onConflict: 'user_id' }
    );
  }

  return res.status(200).json({ ok: true, bonusMinutes: BONUS_MINUTES });
}
