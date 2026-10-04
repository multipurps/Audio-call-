// Maps how a Signal call ended to the app's status vocabulary (api/social-calling.js relay-call-status).
// reasons seen in signal-cli: remote_hangup, rejected, remote_busy, ringrtc_hangup, or a lowercased ringrtc state.
export function endStatus({ connected, reason }) {
  const r = String(reason || '').toLowerCase();
  if (connected) return 'completed';
  if (r.includes('busy')) return 'busy';
  if (r.includes('reject') || r.includes('declin')) return 'declined';
  if (r.includes('fail') || r.includes('error') || r.includes('internal') || r === 'bridge_restart') return 'failed';
  return 'no_answer';
}
