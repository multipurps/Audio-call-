// Admin "Call Emysa": opens the normal Emysa call screen in training mode (/?trainer=1) and lists
// what she learned from your training calls. She saves lessons as draft memories on her own while you
// talk. Each one can be edited, deleted or published here (and in the Knowledge tab). Users only get a
// memory after you publish it.
const TAG = 'from-training-call';

export function stopTrainerCall() {}

export async function loadTrainerCall(el, { api, esc }) {
  let items = [];
  let editing = null;
  let msg = '';

  const when = (iso) => (iso ? new Date(iso).toLocaleString() : '');
  const say = (m) => { msg = m; const n = el.querySelector('#trMsg'); if (n) n.textContent = m; };

  async function refresh() {
    try { items = (await api('ai-knowledge-list', { qs: `&tag=${TAG}` })).items.filter((i) => i.status !== 'archived'); }
    catch (err) { el.innerHTML = `<div class="aHint">${esc(err.message)}</div>`; return false; }
    return true;
  }

  function row(i) {
    if (editing === i.id) {
      return `<div class="aCard wide" data-id="${esc(i.id)}">
        <input style="width:100%" data-f="title" value="${esc(i.title)}" maxlength="160">
        <textarea data-f="body" rows="3" style="width:100%;margin-top:8px">${esc(i.body || '')}</textarea>
        <div style="margin-top:8px;display:flex;gap:8px"><button class="aBtn" data-act="save">Save</button><button class="aBtn ghost" data-act="cancel">Cancel</button></div>
      </div>`;
    }
    const live = i.status === 'published';
    return `<div class="aCard wide" data-id="${esc(i.id)}">
      <div class="l">${esc(i.kind)} &middot; ${live ? 'live for users' : 'draft'} &middot; ${esc(when(i.created_at))}</div>
      <div class="v" style="font-size:16px">${esc(i.title)}</div>
      <div class="aHint" style="margin:6px 0">${esc(i.body || '')}</div>
      ${i.bad_example ? `<div class="aHint">Not: ${esc(i.bad_example)}</div>` : ''}${i.good_example ? `<div class="aHint">Instead: ${esc(i.good_example)}</div>` : ''}
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="aBtn ghost" data-act="edit">Edit</button>
        ${live ? '<button class="aBtn ghost" data-act="unpublish">Take off live</button>' : '<button class="aBtn" data-act="publish">Publish to all users</button>'}
        <button class="aBtn ghost" data-act="delete">Delete</button>
      </div>
    </div>`;
  }

  function draw() {
    const drafts = items.filter((i) => i.status === 'draft');
    el.innerHTML = `
      <div class="aCard wide">
        <div class="l">Call Emysa</div>
        <div class="v" style="font-size:18px">Train her by talking</div>
        <div class="aHint" style="margin:8px 0 12px">Opens the normal Emysa call screen with the raw Emysa on your draft guidance. She learns from what you tell her and saves it as draft memories below. No one's memory is used, and the call is never billed. Her new memories are used from your next training call. Users get a memory only after you publish it.</div>
        <a class="aBtn" href="/?trainer=1" target="_blank" rel="noopener" style="display:inline-block;text-decoration:none">Open call screen</a>
        <details style="margin-top:12px"><summary class="aHint" style="cursor:pointer">Advanced</summary>
          <div class="aHint" style="margin-top:8px">Both engines read the same memories. This only checks that a lesson also works on the custom-voice path.</div>
          <a class="aBtn ghost" href="/?trainer=1&engine=luna" target="_blank" rel="noopener" style="display:inline-block;text-decoration:none;margin-top:8px">Test on Luna (custom-voice path)</a>
        </details>
      </div>
      <div class="aCard wide">
        <div class="l">What she learned from your calls</div>
        <div class="aHint" id="trMsg">${esc(msg)}</div>
        <div style="margin:8px 0;display:flex;gap:8px;flex-wrap:wrap">
          <button class="aBtn ghost" data-act="reload">Refresh</button>
          ${drafts.length ? `<button class="aBtn" data-act="publishAll">Publish all ${drafts.length} drafts</button>` : ''}
        </div>
      </div>
      ${items.length ? items.map(row).join('') : '<div class="aHint">Nothing yet. Start a training call and teach her something.</div>'}`;
  }

  async function call(action, body) { return api(action, { method: 'POST', body }); }

  el.onclick = async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const id = btn.closest('[data-id]')?.dataset.id;
    try {
      if (act === 'reload') { await refresh(); draw(); return; }
      if (act === 'edit') { editing = id; draw(); return; }
      if (act === 'cancel') { editing = null; draw(); return; }
      if (act === 'save') {
        const box = btn.closest('[data-id]');
        const cur = items.find((i) => i.id === id);
        await call('ai-knowledge-save', { item: { ...cur, title: box.querySelector('[data-f=title]').value, body: box.querySelector('[data-f=body]').value } });
        editing = null; await refresh(); draw(); say('Saved. It is a draft until you publish it.'); return;
      }
      if (act === 'publish' || act === 'unpublish') {
        await call('ai-knowledge-status', { id, status: act === 'publish' ? 'published' : 'draft' });
        await refresh(); draw(); say(act === 'publish' ? 'Published. New calls get it within about 30 seconds.' : 'Taken off live.'); return;
      }
      if (act === 'delete') {
        if (!confirm('Delete this memory?')) return;
        await call('ai-knowledge-delete', { id });
        await refresh(); draw(); say('Deleted.'); return;
      }
      if (act === 'publishAll') {
        const drafts = items.filter((i) => i.status === 'draft');
        if (!confirm(`Publish ${drafts.length} memories to all users?`)) return;
        for (const d of drafts) await call('ai-knowledge-status', { id: d.id, status: 'published' });
        await refresh(); draw(); say('Published.'); return;
      }
    } catch (err) { say(err.message || 'Something went wrong.'); }
  };

  if (await refresh()) draw();
}
