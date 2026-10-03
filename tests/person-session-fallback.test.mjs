import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePersonSession } from '../lib/personSession.js';

// Minimal supabase-js style stub whose chat_sessions lookup fails the way
// PostgREST does when the peer_key column does not exist yet.
function dbMissingColumn() {
  const chain = {
    select: () => chain, eq: () => chain,
    maybeSingle: async () => ({ data: null, error: { message: "Could not find the 'peer_key' column of 'chat_sessions' in the schema cache" } }),
  };
  return { from: () => chain };
}

test('missing peer_key column degrades to the old behaviour instead of throwing', async () => {
  const r = await resolvePersonSession(dbMissingColumn(), 'u1', { sessionId: 's1', toNumber: '+2349038226059' });
  assert.deepEqual(r, { sessionId: 's1', merged: false, peerKey: null });
});
