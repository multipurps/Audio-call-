// One person = one conversation.
//
// Every call/chat with the same person (matched by their normalised number,
// whether it was typed, pasted, or came from a saved contact) lives in a single
// chat_sessions row. When a call is about to be placed from some other chat
// (e.g. a brand-new chat with the number pasted in), that chat is folded into
// the person's existing conversation instead of creating another Recent entry.
//
// The match key is chat_sessions.peer_key, set from the number's digits, so a
// pasted number and a saved contact with the same number resolve to the same
// conversation. Display names are never used for matching.
import { normalizePhone } from './phoneNumbers.js';

export function peerKeyFor({ toNumber = null, contactNumber = null, contactId = null } = {}) {
  const num = normalizePhone(String(contactNumber || toNumber || '').trim());
  if (num) return `p:${num.replace(/\D/g, '')}`;
  if (contactId) return `c:${contactId}`;
  return null;
}

/**
 * Returns the session id a call to this person must use, merging `sessionId`
 * (the chat the request came from) into the person's canonical conversation
 * when they differ. Safe to call repeatedly; returns `sessionId` untouched when
 * there's no usable peer key.
 */
export async function resolvePersonSession(db, userId, { sessionId = null, toNumber = null, contactNumber = null, contactId = null, label = null } = {}) {
  const peerKey = peerKeyFor({ toNumber, contactNumber, contactId });
  if (!peerKey) return { sessionId, merged: false, peerKey: null };

  const { data: canonical, error: lookupErr } = await db.from('chat_sessions').select('id, archived')
    .eq('user_id', userId).eq('peer_key', peerKey).maybeSingle();
  // The database has not had sql/019 applied yet (no peer_key column). Don't
  // crash every message and call with a 500: carry on without per-person
  // merging until the migration is run.
  if (lookupErr && /peer_key|column|schema cache/i.test(lookupErr.message || '')) {
    return { sessionId, merged: false, peerKey: null };
  }

  // Nobody owns this person yet: the originating chat becomes their conversation.
  if (!canonical) {
    if (sessionId) {
      const { error } = await db.from('chat_sessions').update({ peer_key: peerKey, ...(label ? { title: label.slice(0, 100) } : {}) })
        .eq('id', sessionId).eq('user_id', userId).is('peer_key', null);
      if (!error) {
        const { data: now } = await db.from('chat_sessions').select('peer_key').eq('id', sessionId).eq('user_id', userId).maybeSingle();
        if (now?.peer_key === peerKey) return { sessionId, merged: false, peerKey };
        // The originating chat already belongs to a different person: don't
        // overwrite it; give this person their own conversation below.
      }
    }
    const { data: created, error: createErr } = await db.from('chat_sessions')
      .insert({ user_id: userId, title: (label || 'Call').slice(0, 100), peer_key: peerKey }).select('id').single();
    if (createErr) {
      // Lost a race with a concurrent call to the same person: use theirs.
      const { data: again } = await db.from('chat_sessions').select('id').eq('user_id', userId).eq('peer_key', peerKey).maybeSingle();
      if (again) return { sessionId: again.id, merged: false, peerKey };
      throw new Error(createErr.message);
    }
    return { sessionId: created.id, merged: false, peerKey };
  }

  if (canonical.archived) await db.from('chat_sessions').update({ archived: false }).eq('id', canonical.id).eq('user_id', userId);
  if (!sessionId || sessionId === canonical.id) return { sessionId: canonical.id, merged: false, peerKey };

  // Fold the originating chat into the person's conversation, but only if it
  // isn't itself another person's conversation.
  const { data: origin } = await db.from('chat_sessions').select('id, peer_key').eq('id', sessionId).eq('user_id', userId).maybeSingle();
  if (!origin) return { sessionId: canonical.id, merged: false, peerKey };
  if (origin.peer_key && origin.peer_key !== peerKey) {
    return { sessionId: canonical.id, merged: false, peerKey };
  }
  await db.from('assistant_messages').update({ session_id: canonical.id }).eq('session_id', origin.id).eq('user_id', userId);
  await db.from('calls').update({ session_id: canonical.id }).eq('session_id', origin.id).eq('user_id', userId);
  await db.from('call_plans').update({ session_id: canonical.id }).eq('session_id', origin.id).eq('user_id', userId);
  await db.from('chat_sessions').delete().eq('id', origin.id).eq('user_id', userId);
  await db.from('chat_sessions').update({ updated_at: new Date().toISOString() }).eq('id', canonical.id).eq('user_id', userId);
  return { sessionId: canonical.id, merged: true, mergedFrom: origin.id, peerKey };
}
