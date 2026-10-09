import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';
import handleContactMemory from '../lib/contactMemoryApi.js';
import {
  normalizeMemoryRow,
  containsSensitiveSecret,
  sanitizeMemoryContent,
  consolidateAndStoreMemories,
  safeUpdateMemoryRow,
  loadEmotionalState,
  inferMemoryType,
} from '../lib/memoryManager.js';

export default async function handler(req, res) {
  // Imported WhatsApp history and reviewed per-contact memories (Phase 3).
  // Anything thrown here used to escape as an empty-bodied 500; answer with a
  // JSON error instead, and log the cause.
  if (req.query?.scope === 'contact') {
    try {
      return await handleContactMemory(req, res, { supabase: getServiceClient() });
    } catch (err) {
      console.error('contact memory handler crashed:', req.query?.action, err?.message);
      if (res.headersSent) return undefined;
      return res.status(500).json({ error: 'Something went wrong. Try again.' });
    }
  }
  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  if (req.method === 'GET') {
    const typeFilter = req.query?.type ? String(req.query.type).toLowerCase() : null;
    const { data, error } = await supabase
      .from('memories')
      .select('*, contacts(name)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) return res.status(500).json({ error: error.message });

    let memories = (data || [])
      .map((m) => {
        const norm = normalizeMemoryRow(m);
        if (!norm) return null;
        return {
          id: norm.id,
          content: norm.content,
          memory_type: norm.memory_type,
          subject_key: norm.subject_key,
          importance: norm.importance,
          contact_id: norm.contact_id,
          contactName: m.contacts?.name || null,
          source_call_id: norm.source_call_id,
          created_at: norm.created_at,
          updated_at: norm.updated_at,
        };
      })
      .filter(Boolean);

    if (typeFilter) {
      memories = memories.filter((m) => m.memory_type === typeFilter);
    }

    const emotionState = await loadEmotionalState({ supabase, userId });
    return res.status(200).json({
      memories,
      emotionState: {
        primaryEmotion: emotionState.primaryEmotion,
        secondaryEmotion: emotionState.secondaryEmotion,
        intensity: emotionState.intensity,
        dimensions: emotionState.dimensions,
        mood: {
          label: `${emotionState.primaryEmotion || 'warm'}${emotionState.secondaryEmotion ? ` & ${emotionState.secondaryEmotion}` : ''}`,
        },
        updatedAt: emotionState.updatedAt,
      },
    });
  }

  if (req.method === 'POST') {
    const { content, memory_type, memoryType, contact_id } = req.body || {};
    if (!content || !String(content).trim()) {
      return res.status(400).json({ error: 'Memory content is required.' });
    }
    if (containsSensitiveSecret(content)) {
      return res.status(400).json({
        error: 'For your security, passwords, API keys, and sensitive credentials cannot be saved as memories.',
      });
    }
    const clean = sanitizeMemoryContent(content);
    if (!clean) {
      return res.status(400).json({ error: 'Memory is too short or invalid.' });
    }
    const result = await consolidateAndStoreMemories({
      supabase,
      userId,
      contactId: contact_id || null,
      candidates: [
        {
          content: clean,
          memory_type: memory_type || memoryType || inferMemoryType(clean),
          contact_id: contact_id || null,
        },
      ],
    });
    return res.status(200).json({ ok: true, ...result });
  }

  if (req.method === 'PATCH' || req.method === 'PUT') {
    const { id, content, memory_type } = req.body || {};
    if (!id || !content || !String(content).trim()) {
      return res.status(400).json({ error: 'id and content are required.' });
    }
    if (containsSensitiveSecret(content)) {
      return res.status(400).json({
        error: 'For your security, passwords, API keys, and sensitive credentials cannot be saved as memories.',
      });
    }
    const updated = await safeUpdateMemoryRow(supabase, id, userId, {
      content,
      memory_type,
    });
    if (!updated) {
      return res.status(404).json({ error: 'Could not update memory.' });
    }
    const norm = normalizeMemoryRow(updated);
    return res.status(200).json({ ok: true, memory: norm });
  }

  if (req.method === 'DELETE') {
    const id = req.body?.id || req.query?.id;
    const clearAll = Boolean(req.body?.clearAll || req.query?.clearAll === 'true' || req.query?.all === '1');
    if (clearAll) {
      const { error } = await supabase.from('memories').delete().eq('user_id', userId);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, cleared: true });
    }
    if (!id) return res.status(400).json({ error: 'id required' });
    const { error } = await supabase.from('memories').delete().eq('id', id).eq('user_id', userId);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
