// Maps the WaCalls relay's live session detail to the status the app shows.
// The Connected accounts screen used to show only a saved flag in the
// database, which could say "Not connected" while the relay was paired and
// placing calls. The relay is the source of truth.

export function relayDetailToStatus(detail) {
  if (detail?.paired) return 'connected';
  if (detail?.state === 'code') return 'pending_code';
  if (detail?.state === 'qr') return 'pending_qr';
  return 'disconnected';
}

/**
 * @param {object} row   whatsapp_accounts row (status, display_name, wacalls_session_id)
 * @param {Function} fetchDetail  async () => relay detail; may throw with .statusCode
 * @returns {{ status, displayName, update }}  `update` is a DB patch or null
 */
export async function resolveWhatsappStatus(row, fetchDetail) {
  const saved = { status: row?.status || 'disconnected', displayName: row?.display_name || null };
  if (!row?.wacalls_session_id) return { ...saved, status: 'disconnected', update: null };
  let detail;
  try {
    detail = await fetchDetail();
  } catch (err) {
    // 404 = the relay really has no such session. Anything else (relay
    // asleep, timeout, 5xx) says nothing about the login, so keep what was
    // saved instead of telling the user they are disconnected.
    if (err?.statusCode === 404) {
      return {
        status: 'disconnected', displayName: null,
        update: { wacalls_session_id: null, status: 'disconnected', display_name: null },
      };
    }
    return { ...saved, unreachable: true, update: null };
  }
  const status = relayDetailToStatus(detail);
  const displayName = detail?.jid || saved.displayName;
  const changed = status !== saved.status || (detail?.paired && detail?.jid && detail.jid !== saved.displayName);
  return {
    status, displayName,
    update: changed ? { status, ...(detail?.paired && detail?.jid ? { display_name: detail.jid } : {}) } : null,
  };
}
