// Admin tab: global AI behavior, shared knowledge, examples, tests and history.
// It edits instructions and retrieved guidance applied to every call. It does not train or
// fine-tune GPT-Live or Luna.
const SECTIONS = [
  ['style', 'Conversation style and personality'],
  ['language', 'Natural conversational language'],
  ['disagree', 'How it disagrees'],
  ['interrupt', 'How it interrupts and handles being interrupted'],
  ['jokes', 'How it jokes'],
  ['reacts', 'How it reacts and responds'],
];
const MODELS = [['live', 'GPT-Live (default voices)'], ['luna', 'Luna (custom voice, text assistant)']];
const MODES = [['phone', 'Phone calls'], ['app', 'In-app call and chat'], ['social', 'WhatsApp, Telegram, Signal']];

export async function loadAiBehavior(el, { api, esc }) {
  const S = { tab: 'behavior', overview: null, config: emptyConfig(), items: [], filter: { q: '', status: '', kind: '' }, editing: null, msg: '' };

  function emptyConfig() {
    return { global: Object.fromEntries(SECTIONS.map(([k]) => [k, ''])), must: [], avoid: [], models: { live: { extra: '' }, luna: { extra: '' } } };
  }
  const lines = (arr) => (arr || []).join('\n');
  const toList = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
  const say = (m) => { S.msg = m; const n = el.querySelector('#aiMsg'); if (n) n.textContent = m; };
  const when = (iso) => (iso ? new Date(iso).toLocaleString() : '');

  async function refreshOverview() {
    S.overview = await api('ai-overview');
    const base = S.overview.draft || S.overview.live;
    S.config = { ...emptyConfig(), ...(base?.config || {}) };
    S.config.global = { ...emptyConfig().global, ...(base?.config?.global || {}) };
    S.config.models = { live: { extra: '' }, luna: { extra: '' }, ...(base?.config?.models || {}) };
  }

  function shell() {
    const o = S.overview;
    const tabs = [['behavior', 'Behavior'], ['knowledge', 'Knowledge and examples'], ['test', 'Test'], ['history', 'History']];
    el.innerHTML = `
      <div class="aCard wide"><div class="l">Global AI behavior</div>
        <div class="v">${o?.live ? `Version ${o.live.version} live` : 'Nothing published yet'}</div>
        <div class="m">${o?.draft ? `Draft version ${o.draft.version} waiting. ` : ''}${o?.knowledge?.published ?? 0} published and ${o?.knowledge?.drafts ?? 0} draft knowledge entries.</div>
        <div class="aHint">This changes the instructions and guidance every call receives. It does not train or fine-tune GPT-Live or Luna. New calls pick up a publish within about 30 seconds. A call already in progress keeps what it started with.</div>
      </div>
      <div class="aChips" style="margin:0 0 12px;max-width:100%;flex-wrap:wrap;">${tabs.map(([k, n]) => `<button data-t="${k}" class="${S.tab === k ? 'on' : ''}">${n}</button>`).join('')}</div>
      <div id="aiPane"></div><div class="aHint" id="aiMsg">${esc(S.msg)}</div>`;
    el.querySelectorAll('[data-t]').forEach((b) => { b.onclick = () => { S.tab = b.dataset.t; S.editing = null; render(); }; });
  }

  async function render() {
    shell();
    const pane = el.querySelector('#aiPane');
    try {
      if (S.tab === 'behavior') renderBehavior(pane);
      else if (S.tab === 'knowledge') await renderKnowledge(pane);
      else if (S.tab === 'test') renderTest(pane);
      else await renderHistory(pane);
    } catch (e) { pane.innerHTML = `<div class="aHint">${esc(e.message)}</div>`; }
  }

  // ---------- behavior ----------
  function readConfig() {
    const g = {};
    SECTIONS.forEach(([k]) => { g[k] = el.querySelector(`#cfg_${k}`).value; });
    return {
      global: g,
      must: toList(el.querySelector('#cfg_must').value),
      avoid: toList(el.querySelector('#cfg_avoid').value),
      models: { live: { extra: el.querySelector('#cfg_live').value }, luna: { extra: el.querySelector('#cfg_luna').value } },
    };
  }
  function renderBehavior(pane) {
    pane.innerHTML = `<div class="aCard wide">
      ${SECTIONS.map(([k, n]) => `<div class="aField"><label>${n}</label><textarea id="cfg_${k}" rows="2" maxlength="700" style="width:100%">${esc(S.config.global[k])}</textarea></div>`).join('')}
      <div class="aField"><label>Rules that must always be followed (one per line)</label><textarea id="cfg_must" rows="4" style="width:100%">${esc(lines(S.config.must))}</textarea></div>
      <div class="aField"><label>Words and phrases to avoid (one per line)</label><textarea id="cfg_avoid" rows="4" style="width:100%">${esc(lines(S.config.avoid))}</textarea></div>
      <div class="aField"><label>${MODELS[0][1]}: extra instructions only for this model</label><textarea id="cfg_live" rows="3" style="width:100%">${esc(S.config.models.live?.extra || '')}</textarea></div>
      <div class="aField"><label>${MODELS[1][1]}: extra instructions only for this model</label><textarea id="cfg_luna" rows="3" style="width:100%">${esc(S.config.models.luna?.extra || '')}</textarea></div>
      <div class="aField"><label>Note for this version</label><input id="cfg_note" maxlength="200" style="width:100%" value="${esc(S.overview?.draft?.note || '')}"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="aBtn" id="cfgSave">Save draft</button>
        <button class="aBtn ghost" id="cfgPublish" ${S.overview?.draft ? '' : 'disabled'}>Publish draft</button>
        <select id="pvModel">${MODELS.map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select>
        <select id="pvMode">${MODES.map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select>
        <button class="aBtn ghost" id="cfgPreview">Preview what a call receives</button>
      </div>
      <pre id="pvOut" class="aHint" style="white-space:pre-wrap;"></pre></div>`;
    el.querySelector('#cfgSave').onclick = async () => {
      try { S.config = readConfig(); await api('ai-config-save', { method: 'POST', body: { config: S.config, note: el.querySelector('#cfg_note').value } }); await refreshOverview(); S.msg = 'Draft saved. Not live until you publish.'; render(); } catch (e) { say(e.message); }
    };
    el.querySelector('#cfgPublish').onclick = async () => {
      if (!confirm('Publish this draft? Every new call will use it.')) return;
      try {
        S.config = readConfig();
        await api('ai-config-save', { method: 'POST', body: { config: S.config, note: el.querySelector('#cfg_note').value } });
        await refreshOverview();
        await api('ai-config-publish', { method: 'POST', body: { version: S.overview.draft.version } });
        await refreshOverview(); S.msg = 'Published. New calls will use it.'; render();
      } catch (e) { say(e.message); }
    };
    el.querySelector('#cfgPreview').onclick = async () => {
      try {
        const r = await api('ai-preview', { method: 'POST', body: { model: el.querySelector('#pvModel').value, mode: el.querySelector('#pvMode').value, query: '', useDraftConfig: true, config: readConfig(), includeDrafts: true } });
        el.querySelector('#pvOut').textContent = r.block || '(nothing would be added)';
      } catch (e) { say(e.message); }
    };
  }

  // ---------- knowledge and examples ----------
  async function renderKnowledge(pane) {
    const f = S.filter;
    const qs = `&q=${encodeURIComponent(f.q)}&status=${f.status}&kind=${f.kind}`;
    S.items = (await api('ai-knowledge-list', { qs })).items;
    pane.innerHTML = `<div class="aCard wide">
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <input id="kQ" placeholder="Search" value="${esc(f.q)}" style="flex:1;min-width:140px">
        <select id="kStatus"><option value="">Any status</option>${['draft', 'published', 'archived'].map((s) => `<option ${f.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <select id="kKind"><option value="">Any type</option>${['fact', 'rule', 'example', 'correction'].map((s) => `<option ${f.kind === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <button class="aBtn ghost" id="kGo">Search</button><button class="aBtn" id="kNew">New entry</button>
      </div></div>
      <div id="kForm"></div>
      ${S.items.map((i) => `<div class="aRow"><div class="t">${esc(i.title)}</div>
        <div class="m">${esc(i.kind)} | ${esc(i.status)} | models: ${esc(i.models.join(', '))} | modes: ${esc(i.modes.join(', '))}${i.always ? ' | always on' : ''} | tags: ${esc(i.tags.join(', '))}</div>
        <div class="m">${esc((i.body || i.good_example || '').slice(0, 160))}</div>
        <div class="m">Updated ${esc(when(i.updated_at))} by ${esc(i.updated_by || i.created_by || '')}${i.approved_by ? `, approved by ${esc(i.approved_by)}` : ''}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">
          <button class="aBtn ghost sm" data-a="edit" data-id="${i.id}">Edit</button>
          ${i.status !== 'published' ? `<button class="aBtn sm" data-a="published" data-id="${i.id}">Approve and publish</button>` : `<button class="aBtn ghost sm" data-a="draft" data-id="${i.id}">Unpublish</button>`}
          ${i.status !== 'archived' ? `<button class="aBtn ghost sm" data-a="archived" data-id="${i.id}">Archive</button>` : ''}
          <button class="aBtn ghost sm" data-a="history" data-id="${i.id}">Versions</button>
          <button class="aBtn ghost sm" data-a="delete" data-id="${i.id}">Delete</button>
        </div><div id="h_${i.id}"></div></div>`).join('') || '<div class="aHint">No entries match.</div>'}`;
    const go = () => { S.filter = { q: el.querySelector('#kQ').value, status: el.querySelector('#kStatus').value, kind: el.querySelector('#kKind').value }; render(); };
    el.querySelector('#kGo').onclick = go;
    el.querySelector('#kNew').onclick = () => { S.editing = { kind: 'fact', models: ['live', 'luna'], modes: ['phone', 'app', 'social'], tags: [] }; renderForm(); };
    pane.querySelectorAll('[data-a]').forEach((b) => { b.onclick = () => rowAction(b.dataset.a, b.dataset.id); });
    if (S.editing) renderForm();
  }

  function renderForm() {
    const e = S.editing;
    const box = el.querySelector('#kForm');
    const checks = (name, list, sel) => list.map(([k, n]) => `<label style="margin-right:10px;font-size:13px;"><input type="checkbox" name="${name}" value="${k}" ${sel.includes(k) ? 'checked' : ''}> ${n}</label>`).join('');
    const exampleKind = e.kind === 'example' || e.kind === 'correction';
    box.innerHTML = `<div class="aCard wide">
      <div class="aField"><label>Type</label><select id="fKind">${['fact', 'rule', 'example', 'correction'].map((s) => `<option ${e.kind === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <div class="aField"><label>Title</label><input id="fTitle" maxlength="160" style="width:100%" value="${esc(e.title || '')}"></div>
      <div class="aField"><label>${exampleKind ? 'Preferred behavior' : 'Content'}</label><textarea id="fBody" rows="3" maxlength="2000" style="width:100%">${esc(e.body || '')}</textarea></div>
      ${exampleKind ? `<div class="aField"><label>Undesirable response</label><textarea id="fBad" rows="2" maxlength="600" style="width:100%">${esc(e.bad_example || '')}</textarea></div>
        <div class="aField"><label>Desirable response</label><textarea id="fGood" rows="2" maxlength="600" style="width:100%">${esc(e.good_example || '')}</textarea></div>
        <div class="aField"><label>Why the first was wrong</label><textarea id="fWhy" rows="2" maxlength="600" style="width:100%">${esc(e.why || '')}</textarea></div>` : ''}
      <div class="aField"><label>Tags (comma separated)</label><input id="fTags" style="width:100%" value="${esc((e.tags || []).join(', '))}"></div>
      <div class="aField"><label>Models that may use it</label>${checks('fModels', MODELS, e.models || [])}</div>
      <div class="aField"><label>Call modes</label>${checks('fModes', MODES, e.modes || [])}</div>
      <div class="aField"><label><input type="checkbox" id="fAlways" ${e.always ? 'checked' : ''}> Always include (short rules only). Otherwise it is retrieved only when relevant to the call.</label></div>
      <div style="display:flex;gap:8px;"><button class="aBtn" id="fSave">Save as draft</button><button class="aBtn ghost" id="fCancel">Cancel</button></div>
      <div class="aHint">Examples and corrections shape future calls through instructions and retrieval. They do not train the model. Editing a published entry returns it to draft until you approve it again.</div></div>`;
    box.querySelector('#fKind').onchange = (ev) => { S.editing = readForm(); S.editing.kind = ev.target.value; renderForm(); };
    box.querySelector('#fCancel').onclick = () => { S.editing = null; box.innerHTML = ''; };
    box.querySelector('#fSave').onclick = async () => {
      try { await api('ai-knowledge-save', { method: 'POST', body: { item: readForm() } }); S.editing = null; S.msg = 'Saved as draft.'; await refreshOverview(); render(); } catch (err) { say(err.message); }
    };
  }
  function readForm() {
    const box = el.querySelector('#kForm');
    const val = (id) => box.querySelector(id)?.value || '';
    const checked = (n) => [...box.querySelectorAll(`input[name="${n}"]:checked`)].map((c) => c.value);
    return {
      id: S.editing?.id, kind: val('#fKind'), title: val('#fTitle'), body: val('#fBody'), bad_example: val('#fBad'), good_example: val('#fGood'), why: val('#fWhy'),
      tags: val('#fTags').split(',').map((t) => t.trim()).filter(Boolean), models: checked('fModels'), modes: checked('fModes'), always: box.querySelector('#fAlways').checked,
    };
  }
  async function rowAction(a, id) {
    try {
      if (a === 'edit') { S.editing = S.items.find((i) => i.id === id); renderForm(); el.querySelector('#kForm').scrollIntoView({ behavior: 'smooth' }); return; }
      if (a === 'delete') { if (!confirm('Delete this entry? Its earlier versions stay in the history.')) return; await api('ai-knowledge-delete', { method: 'POST', body: { id } }); }
      else if (a === 'history') {
        const { history } = await api('ai-knowledge-history', { qs: `&id=${id}` });
        el.querySelector(`#h_${id}`).innerHTML = history.map((h) => `<div class="m">${esc(when(h.changed_at))} by ${esc(h.changed_by || '')}: ${esc(h.snapshot.title)} (${esc(h.snapshot.status)}) <button class="aBtn ghost sm" data-r="${h.id}">Restore as draft</button></div>`).join('') || '<div class="m">No earlier versions.</div>';
        el.querySelectorAll(`#h_${id} [data-r]`).forEach((b) => { b.onclick = async () => { await api('ai-knowledge-restore', { method: 'POST', body: { id, historyId: Number(b.dataset.r) } }); S.msg = 'Restored as a draft.'; render(); }; });
        return;
      } else { await api('ai-knowledge-status', { method: 'POST', body: { id, status: a } }); }
      await refreshOverview(); render();
    } catch (e) { say(e.message); }
  }

  // ---------- test ----------
  function renderTest(pane) {
    pane.innerHTML = `<div class="aCard wide">
      <div class="aField"><label>Sample lines a person might say on a call (one per line, up to 6)</label><textarea id="tLines" rows="5" style="width:100%" placeholder="I don't think that's right.\nCan you call me back tomorrow?"></textarea></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;"><select id="tModel">${MODELS.map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select>
      <select id="tMode">${MODES.map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select>
      <button class="aBtn" id="tRun">Compare live and draft</button></div>
      <div class="aHint">Compares the published config with your unsaved Behavior tab values and drafts. Both models are tested as text through Luna, so this checks wording and rule-following, not audio, interruptions or GPT-Live voice latency. Judge scores are model-graded and approximate.</div>
      <div id="tOut"></div></div>`;
    el.querySelector('#tRun').onclick = async () => {
      const out = el.querySelector('#tOut'); out.innerHTML = '<div class="aHint">Running...</div>';
      try {
        const cfg = el.querySelector('#cfg_must') ? readConfig() : S.config;
        const r = await api('ai-test', { method: 'POST', body: { scenarios: el.querySelector('#tLines').value, model: el.querySelector('#tModel').value, mode: el.querySelector('#tMode').value, config: cfg } });
        const sc = (s) => (s ? `naturalness ${s.naturalness}, relevance ${s.relevance}, compliance ${s.compliance}` : 'no score');
        out.innerHTML = `<div class="aHint">${r.regressions} of ${r.results.length} lines flagged. ${esc(r.note)}</div>` + r.results.map((x) => `<div class="aRow"><div class="t">${esc(x.line)}</div>
          <div class="m">Current (${x.current.ms} ms; ${esc(sc(x.current.scores))}): ${esc(x.current.text)}</div>
          <div class="m">Proposed (${x.proposed.ms} ms; ${esc(sc(x.proposed.scores))}): ${esc(x.proposed.text)}</div>
          ${x.flags.length ? `<div class="m" style="color:#ffb199">Flags: ${esc(x.flags.join('; '))}</div>` : '<div class="m">No flags.</div>'}</div>`).join('');
      } catch (e) { out.innerHTML = `<div class="aHint">${esc(e.message)}</div>`; }
    };
  }

  // ---------- history ----------
  async function renderHistory(pane) {
    const [{ entries }] = await Promise.all([api('ai-audit')]);
    pane.innerHTML = `<div class="aCard wide"><div class="l">Config versions</div>${(S.overview.versions || []).map((v) => `<div class="aRow"><div class="t">Version ${v.version} (${esc(v.status)})</div>
        <div class="m">${esc(v.note || 'No note')} | saved by ${esc(v.created_by || '')} ${esc(when(v.created_at))}${v.published_at ? ` | published by ${esc(v.published_by || '')} ${esc(when(v.published_at))}` : ''}</div>
        ${v.status === 'archived' ? `<button class="aBtn ghost sm" data-rb="${v.version}">Roll back to this version</button>` : ''}</div>`).join('') || '<div class="aHint">No versions yet.</div>'}</div>
      <div class="aCard wide"><div class="l">Audit log</div>${entries.map((a) => `<div class="m">${esc(when(a.at))} | ${esc(a.actor_email || '')} | ${esc(a.action)} | ${esc(a.entity || '')} ${esc(a.entity_id || '')}</div>`).join('') || '<div class="aHint">Nothing yet.</div>'}</div>`;
    pane.querySelectorAll('[data-rb]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm(`Roll back to version ${b.dataset.rb}? New calls will use it.`)) return;
        try { await api('ai-config-rollback', { method: 'POST', body: { version: Number(b.dataset.rb) } }); await refreshOverview(); S.msg = 'Rolled back.'; render(); } catch (e) { say(e.message); }
      };
    });
  }

  el.innerHTML = '<div class="aHint">Loading...</div>';
  try { await refreshOverview(); render(); } catch (e) { el.innerHTML = `<div class="aHint">${esc(e.message)}</div>`; }
}
