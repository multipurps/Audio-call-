// Admin "Call Emysa": a live call with the raw Emysa users will get, running on your DRAFT
// guidance, with the live transcript. Mark an Emysa line as wrong or good to turn it into a
// correction or example. Nothing is trained automatically and nothing reaches users until you
// publish it. The transcript is never turned into global knowledge by itself.
import { floatToPcm16k, decodeAppCallFrame, describeAppCallMessage, describeAppCallClose, describeMicError } from '../lib/appCallAudio.js';
import { primeAudioSession, createCallOutput, watchLifecycle, pickOutputMode, micNeedsRestart } from '../lib/appCallOutput.js';

let active = null; // the one live training call, if any

export function stopTrainerCall() {
  const call = active;
  active = null;
  if (!call) return;
  clearInterval(call.timer);
  try { call.unwatch?.(); } catch {}
  try { call.ws?.close(); } catch {}
  for (const src of call.sources) { try { src.stop(); } catch {} }
  try { call.micNode?.disconnect(); call.source?.disconnect(); } catch {}
  try { call.stream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { call.output?.dispose(); } catch {}
  try { call.ctx?.close(); } catch {}
}

export function loadTrainerCall(el, { api, esc, supabase }) {
  stopTrainerCall();
  const S = { lines: [], muted: false, state: 'idle', engine: 'live', msg: '', form: null };

  el.innerHTML = `
    <div class="aCard wide">
      <div class="l">Call Emysa</div>
      <div class="v" id="tcState">Not in a call</div>
      <div class="aHint">You are talking to the raw Emysa that users get, with no one's memory or settings, using your latest draft guidance and draft knowledge. Calls here are never billed and get no summary. Mark a line as wrong or good to teach it. That saves a draft, which the next training call hears immediately. Users only get it after you publish it in the Knowledge tab.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;align-items:center;">
        <select id="tcEngine"><option value="live">GPT-Live (default voices)</option><option value="luna">Luna (custom-voice path, default voice)</option></select>
        <button class="aBtn" id="tcStart">Start call</button>
        <button class="aBtn ghost" id="tcMute" disabled>Mute</button>
        <button class="aBtn ghost" id="tcEnd" disabled>End call</button>
      </div>
      <div class="aHint" id="tcMsg"></div>
    </div>
    <div class="aCard wide"><div class="l">Transcript</div>
      <div id="tcLines" style="max-height:46vh;overflow:auto;margin-top:8px;"><div class="aHint">The conversation appears here as you talk.</div></div>
    </div>
    <div id="tcForm"></div>`;

  const $ = (id) => el.querySelector(id);
  const setState = (text, state) => { S.state = state || S.state; $('#tcState').textContent = text; };
  const say = (m) => { $('#tcMsg').textContent = m || ''; };
  const buttons = (inCall) => { $('#tcStart').disabled = inCall; $('#tcEnd').disabled = !inCall; $('#tcMute').disabled = !inCall; $('#tcEngine').disabled = inCall; };

  function addLine(speaker, text) {
    const ai = speaker === 'ai' || speaker === 'assistant';
    const idx = S.lines.push({ ai, text }) - 1;
    const box = $('#tcLines');
    box.querySelector('.aHint')?.remove();
    const row = document.createElement('div');
    row.style.cssText = `display:flex;flex-direction:column;align-items:${ai ? 'flex-start' : 'flex-end'};margin:8px 0;`;
    row.innerHTML = `<div class="aRow" style="max-width:88%;margin:0;"><div class="m">${ai ? 'Emysa' : 'You'}</div><div class="t" style="font-weight:500;word-break:normal;">${esc(text)}</div></div>
      ${ai ? `<div style="display:flex;gap:6px;margin-top:4px;"><button class="aBtn ghost sm" data-k="correction" data-i="${idx}">Wrong</button><button class="aBtn ghost sm" data-k="example" data-i="${idx}">Good</button></div>` : ''}`;
    box.appendChild(row);
    box.scrollTop = box.scrollHeight;
    row.querySelectorAll('[data-k]').forEach((b) => { b.onclick = () => openForm(b.dataset.k, Number(b.dataset.i)); });
  }

  function openForm(kind, idx) {
    const emysa = S.lines[idx]?.text || '';
    let said = '';
    for (let i = idx - 1; i >= 0; i--) if (!S.lines[i].ai) { said = S.lines[i].text; break; }
    const wrong = kind === 'correction';
    const checks = (name, list) => list.map(([k, n]) => `<label style="margin-right:10px;font-size:13px;"><input type="checkbox" name="${name}" value="${k}" checked> ${n}</label>`).join('');
    $('#tcForm').innerHTML = `<div class="aCard wide"><div class="l">${wrong ? 'Teach: this was wrong' : 'Teach: keep doing this'}</div>
      <div class="aField"><label>What was said to Emysa</label><textarea id="fSaid" rows="2" style="width:100%">${esc(said)}</textarea></div>
      <div class="aField"><label>${wrong ? 'What Emysa said (undesirable)' : 'What Emysa said (desirable)'}</label><textarea id="fEmysa" rows="2" style="width:100%">${esc(emysa)}</textarea></div>
      ${wrong ? `<div class="aField"><label>What it should say or do instead</label><textarea id="fGood" rows="2" style="width:100%"></textarea></div>` : ''}
      <div class="aField"><label>${wrong ? 'Why it was wrong' : 'Why this works'}</label><textarea id="fWhy" rows="2" style="width:100%"></textarea></div>
      <div class="aField"><label>Tags (comma separated)</label><input id="fTags" style="width:100%"></div>
      <div class="aField"><label>Models</label>${checks('fModels', [['live', 'GPT-Live'], ['luna', 'Luna']])}</div>
      <div class="aField"><label>Call modes</label>${checks('fModes', [['phone', 'Phone'], ['app', 'In-app'], ['social', 'WhatsApp, Telegram, Signal']])}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;"><button class="aBtn" id="fDraft">Save as draft</button><button class="aBtn ghost" id="fPublish">Save and publish to all users</button><button class="aBtn ghost" id="fCancel">Cancel</button></div>
      <div class="aHint">This adds guidance retrieved into future calls. It does not train the model.</div></div>`;
    const collect = () => {
      const f = $('#tcForm');
      const val = (id) => f.querySelector(id)?.value || '';
      const checked = (n) => [...f.querySelectorAll(`input[name="${n}"]:checked`)].map((c) => c.value);
      const saidText = val('#fSaid').trim();
      return {
        kind, title: (saidText ? `When they say: ${saidText}` : 'Training correction').slice(0, 160),
        body: wrong ? (val('#fGood').trim() ? `Preferred: ${val('#fGood').trim()}` : '') : val('#fWhy'),
        bad_example: wrong ? val('#fEmysa') : '', good_example: wrong ? val('#fGood') : val('#fEmysa'), why: val('#fWhy'),
        tags: val('#fTags').split(',').map((t) => t.trim()).filter(Boolean), models: checked('fModels'), modes: checked('fModes'),
      };
    };
    const save = async (publish) => {
      try {
        const { item } = await api('ai-knowledge-save', { method: 'POST', body: { item: collect() } });
        if (publish) await api('ai-knowledge-status', { method: 'POST', body: { id: item.id, status: 'published' } });
        $('#tcForm').innerHTML = '';
        say(publish ? 'Published. New calls for every user will use it.' : 'Saved as a draft. Your next training call will use it.');
      } catch (e) { say(e.message); }
    };
    $('#fDraft').onclick = () => save(false);
    $('#fPublish').onclick = () => { if (confirm('Publish this to every user\'s new calls?')) save(true); };
    $('#fCancel').onclick = () => { $('#tcForm').innerHTML = ''; };
    $('#tcForm').scrollIntoView({ behavior: 'smooth' });
  }

  async function start() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx || !navigator.mediaDevices?.getUserMedia || !window.WebSocket) { say('This device cannot do live voice calls.'); return; }
    S.engine = $('#tcEngine').value;
    setState('Connecting...', 'connecting'); buttons(true); say('');
    // Everything below runs inside the tap: iOS refuses audio otherwise.
    primeAudioSession(navigator);
    const ctx = new AudioCtx();
    const output = createCallOutput({ ctx, doc: document, nav: navigator, mode: pickOutputMode(localStorage), log: () => {} });
    void output.start('tap');
    const fail = (text) => { stopTrainerCall(); setState('Not in a call', 'idle'); buttons(false); say(text); };
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }); }
    catch (err) { output.dispose(); ctx.close().catch(() => {}); setState('Not in a call', 'idle'); buttons(false); say(describeMicError(err)); return; }
    let started;
    try { started = await api('ai-train-call-start', { method: 'POST', body: { engine: S.engine } }); }
    catch (err) { stream.getTracks().forEach((t) => t.stop()); output.dispose(); ctx.close().catch(() => {}); setState('Not in a call', 'idle'); buttons(false); say(err.message); return; }

    let ws;
    try { ws = new WebSocket(started.url); } catch { stream.getTracks().forEach((t) => t.stop()); output.dispose(); ctx.close().catch(() => {}); setState('Not in a call', 'idle'); buttons(false); say('The call could not start. Check PUBLIC_ASSISTANT_WS_URL.'); return; }
    ws.binaryType = 'arraybuffer';
    const call = { ws, stream, ctx, out: output.input, output, callId: started.callId, opened: false, explained: false, ended: false, sources: new Set(), nextTime: 0, rendered: 0, jitter: 0.2, timer: null, source: null, micNode: null };
    active = call;
    S.lines = []; $('#tcLines').innerHTML = '<div class="aHint">The conversation appears here as you talk.</div>';

    const sendPcm = (floats) => {
      if (S.muted || ws.readyState !== WebSocket.OPEN) return;
      const pcm = floatToPcm16k(floats, ctx.sampleRate);
      if (pcm.length) ws.send(pcm.buffer);
    };
    call.source = ctx.createMediaStreamSource(stream);
    const startMic = async () => {
      try {
        if (!ctx.audioWorklet) throw new Error('no worklet');
        const code = "class P extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('mic-tap',P)";
        const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
        await ctx.audioWorklet.addModule(url); URL.revokeObjectURL(url);
        const node = new AudioWorkletNode(ctx, 'mic-tap');
        let acc = []; let n = 0; const need = Math.round(ctx.sampleRate * 0.02);
        node.port.onmessage = (e) => {
          acc.push(e.data); n += e.data.length;
          if (n >= need) { const merged = new Float32Array(n); let o = 0; for (const c of acc) { merged.set(c, o); o += c.length; } acc = []; n = 0; sendPcm(merged); }
        };
        call.source.connect(node); output.silentSink(node); call.micNode = node;
      } catch {
        const node = ctx.createScriptProcessor(1024, 1, 1);
        node.onaudioprocess = (e) => sendPcm(new Float32Array(e.inputBuffer.getChannelData(0)));
        call.source.connect(node); output.silentSink(node); call.micNode = node;
      }
    };
    call.unwatch = watchLifecycle({ doc: document, win: window, ctx, output, onRecovered: () => {
      if (active === call && micNeedsRestart(call.stream)) {
        navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }).then((fresh) => {
          if (active !== call) { fresh.getTracks().forEach((t) => t.stop()); return; }
          try { call.source?.disconnect(); } catch {}
          call.stream = fresh; call.source = ctx.createMediaStreamSource(fresh); if (call.micNode) call.source.connect(call.micNode);
        }).catch(() => {});
      }
    } });

    const play = ({ rate, samples }) => {
      const audio = ctx.createBuffer(1, samples.length, rate);
      const ch = audio.getChannelData(0);
      for (let i = 0; i < samples.length; i++) ch[i] = samples[i] / 32768;
      const src = ctx.createBufferSource(); src.buffer = audio; src.connect(call.out);
      const now = ctx.currentTime;
      if (!call.nextTime) call.nextTime = now + call.jitter;
      else if (call.nextTime < now) { if (now - call.nextTime < 1.0) call.jitter = Math.min(0.6, call.jitter + 0.1); call.nextTime = now + call.jitter; }
      if (call.nextTime > now + 2.5) return;
      src.start(call.nextTime); call.nextTime += audio.duration; call.sources.add(src);
      if (active === call) setState('Emysa is speaking', 'speaking');
      src.onended = () => { call.sources.delete(src); if (!call.sources.size && active === call) setState('Listening', 'listening'); };
    };
    const clearPlayback = () => { for (const s of call.sources) { try { s.stop(); } catch {} } call.sources.clear(); call.nextTime = 0; };

    const pollTranscript = async () => {
      if (active !== call) return;
      try {
        const { data } = await supabase.from('calls').select('transcript').eq('id', call.callId).maybeSingle();
        const lines = Array.isArray(data?.transcript) ? data.transcript : [];
        for (; call.rendered < lines.length; call.rendered++) {
          const l = lines[call.rendered]; const text = l?.content || l?.text || '';
          if (text) addLine(l?.speaker || l?.role, text);
        }
      } catch {}
    };

    ws.onopen = () => { call.opened = true; };
    ws.onmessage = (event) => {
      if (active !== call) return;
      if (typeof event.data === 'string') {
        let msg = null; try { msg = JSON.parse(event.data); } catch {}
        if (msg?.type === 'interrupt') { clearPlayback(); return; }
        const info = describeAppCallMessage(msg);
        if (!info) return;
        if (info.kind === 'error') { call.explained = true; fail(info.text); return; }
        if (info.kind === 'ended') { call.ended = true; pollTranscript().finally(() => { stopTrainerCall(); setState('Call ended', 'idle'); buttons(false); }); return; }
        if (msg.type === 'ready') { call.opened = true; startMic(); setState('Listening', 'listening'); call.timer = setInterval(pollTranscript, 1200); }
        return;
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const frame = decodeAppCallFrame(event.data);
      if (frame) play(frame);
    };
    const onGone = (event) => {
      if (active !== call) return;
      const text = describeAppCallClose({ opened: call.opened, code: event?.code, explained: call.explained, ended: call.ended });
      if (text) fail(text); else { stopTrainerCall(); setState('Call ended', 'idle'); buttons(false); }
    };
    ws.onclose = onGone; ws.onerror = onGone;
  }

  $('#tcStart').onclick = start;
  $('#tcMute').onclick = () => { S.muted = !S.muted; $('#tcMute').textContent = S.muted ? 'Unmute' : 'Mute'; };
  $('#tcEnd').onclick = () => { stopTrainerCall(); setState('Call ended', 'idle'); buttons(false); };
}
