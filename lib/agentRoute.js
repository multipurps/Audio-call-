import { buildAgentConfig, validateCloneInput } from './elevenlabsAgentConfig.js';

const API = 'https://api.elevenlabs.io/v1';

// The Emysa agent for this user: status, switch on or off, and the user's cloned voice
// from samples. Called from api/voice-clone.js (?target=agent), with the user already
// authenticated. The ElevenLabs key is server-side only.
export async function agentRoute(req, res, supabase, userId, key) {
  const action = req.query?.action;
  if (req.method === 'GET') return status(res, supabase, userId);
  if (req.method === 'PUT' && action === 'enable') return enable(res, supabase, userId, key);
  if (req.method === 'PUT' && action === 'disable') return disable(res, supabase, userId);
  if (req.method === 'POST' && action === 'clone') return clone(req, res, supabase, userId, key);
  return res.status(405).json({ error: 'Method not allowed' });
}

async function readRow(supabase, userId) {
  const { data, error } = await supabase.from('user_agents').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw new Error('Could not read the agent settings');
  return data || null;
}

function view(row) {
  return {
    enabled: !!row?.active,
    hasAgent: !!row?.agent_id,
    hasVoice: !!row?.voice_id,
    voiceId: row?.voice_id || null,
  };
}

async function status(res, supabase, userId) {
  try {
    return res.status(200).json(view(await readRow(supabase, userId)));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function elevenlabs(key, method, path, body) {
  const isForm = body instanceof FormData;
  const resp = await fetch(`${API}${path}`, {
    method,
    headers: { 'xi-api-key': key, ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}) },
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const message = data?.detail?.message || data?.detail || data?.message || `ElevenLabs returned ${resp.status}`;
    const err = new Error(typeof message === 'string' ? message : 'ElevenLabs request failed');
    err.status = resp.status;
    throw err;
  }
  return data;
}

async function saveRow(supabase, userId, patch) {
  const { error } = await supabase
    .from('user_agents')
    .upsert({ user_id: userId, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) throw new Error('Could not save the agent settings');
}

function failure(res, err) {
  return res.status(err.status && err.status < 500 ? 400 : 502).json({ error: err.message });
}

async function enable(res, supabase, userId, key) {
  try {
    const row = await readRow(supabase, userId);
    const voiceId = row?.voice_id || null;
    let agentId = row?.agent_id || null;
    if (agentId) {
      await elevenlabs(key, 'PATCH', `/convai/agents/${agentId}`, { conversation_config: buildAgentConfig({ voiceId }) });
    } else {
      const created = await elevenlabs(key, 'POST', '/convai/agents/create', {
        name: 'Emysa',
        conversation_config: buildAgentConfig({ voiceId }),
      });
      agentId = created.agent_id;
      if (!agentId) throw new Error('ElevenLabs did not return an agent');
    }
    await saveRow(supabase, userId, { agent_id: agentId, active: true });
    return res.status(200).json({ enabled: true, hasAgent: true, hasVoice: !!voiceId, voiceId });
  } catch (err) {
    return failure(res, err);
  }
}

async function disable(res, supabase, userId) {
  try {
    const row = await readRow(supabase, userId);
    if (row) await saveRow(supabase, userId, { active: false });
    return res.status(200).json({ ...view(row), enabled: false });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function clone(req, res, supabase, userId, key) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const problem = validateCloneInput(body);
  if (problem) return res.status(400).json({ error: problem });
  try {
    const form = new FormData();
    form.append('name', body.name.trim());
    for (const f of body.files) {
      form.append('files', new Blob([Buffer.from(f.data, 'base64')], { type: f.type }), f.name || 'sample');
    }
    const created = await elevenlabs(key, 'POST', '/voices/add', form);
    const voiceId = created.voice_id;
    if (!voiceId) throw new Error('ElevenLabs did not return a voice');

    const row = await readRow(supabase, userId);
    await saveRow(supabase, userId, { voice_id: voiceId });
    if (row?.agent_id) {
      // Point the existing agent at the new voice straight away.
      await elevenlabs(key, 'PATCH', `/convai/agents/${row.agent_id}`, { conversation_config: buildAgentConfig({ voiceId }) });
    }
    return res.status(200).json({ voiceId, hasVoice: true });
  } catch (err) {
    return failure(res, err);
  }
}
