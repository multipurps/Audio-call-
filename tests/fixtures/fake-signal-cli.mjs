// Test double for `signal-cli daemon --tcp host:port`: speaks the JSON-RPC subset the bridge uses.
import net from 'node:net';
import fs from 'node:fs';
const args = process.argv.slice(2);
const tcp = args[args.indexOf('--tcp') + 1];
const port = Number(tcp.split(':')[1]);
const LOG = process.env.FAKE_RPC_LOG;
let accounts = [];
let nextCall = 1000;
const live = new Map(); // callId -> account
const log = (o) => LOG && fs.appendFileSync(LOG, JSON.stringify(o) + '\n');
const subs = new Set();
const emit = (ev) => { for (const s of subs) s.write(JSON.stringify({ jsonrpc: '2.0', method: 'callEvent', params: { subscription: 1, result: ev } }) + '\n'); };
const DEV = (id) => ({ inputDeviceName: `signal_input_${id}`, outputDeviceName: `signal_output_${id}` });

net.createServer((s) => {
  let buf = '';
  s.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) handle(s, JSON.parse(line)); }
  });
  s.on('close', () => subs.delete(s));
}).listen(port, '127.0.0.1');

function reply(s, id, result) { s.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function fail(s, id, message) { s.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -1, message } }) + '\n'); }

function handle(s, req) {
  const { id, method, params = {} } = req;
  log({ method, params });
  switch (method) {
    case 'subscribeCallEvents': subs.add(s); return reply(s, id, 1);
    case 'listAccounts': return reply(s, id, accounts.map((number) => ({ number })));
    case 'startLink': return reply(s, id, { deviceLinkUri: 'sgnl://linkdevice?uuid=FAKE&pub_key=KEY' });
    case 'finishLink': return setTimeout(() => { accounts.push('+2348012345678'); reply(s, id, { number: '+2348012345678', aci: 'aci-1' }); }, 1200);
    case 'deleteLocalAccountData': accounts = accounts.filter((n) => n !== params.account); return reply(s, id, {});
    case 'listCalls': return reply(s, id, [...live].filter(([, a]) => a === params.account).map(([callId]) => ({ callId: Number(callId), state: 'RINGING_INCOMING' })));
    case 'rejectCall': live.delete(String(params.callId)); return reply(s, id, {});
    case 'hangupCall': {
      reply(s, id, {});
      return setTimeout(() => { live.delete(String(params.callId)); emit({ callId: params.callId, state: 'ENDED', isOutgoing: true, reason: 'ringrtc_hangup' }); }, 50);
    }
    case 'startCall': {
      const callId = nextCall++;
      const to = params.recipient?.[0];
      live.set(String(callId), params.account);
      const base = { callId, number: to, isOutgoing: true };
      if (to === '+earlyend') { emit({ ...base, state: 'ENDED', reason: 'internal_error' }); return reply(s, id, { callId, state: 'RINGING_OUTGOING' }); }
      reply(s, id, { callId, state: 'RINGING_OUTGOING', ...base });
      setTimeout(() => emit({ ...base, state: 'RINGING_OUTGOING' }), 30);
      if (to === '+answer') setTimeout(() => emit({ ...base, state: 'CONNECTED', ...DEV(callId) }), 150);
      if (to === '+reject') setTimeout(() => emit({ ...base, state: 'ENDED', reason: 'rejected' }), 150);
      return;
    }
    case 'testIncoming': { // test hook: simulate someone calling the linked account
      live.set('777', accounts[0]); emit({ callId: 777, state: 'RINGING_INCOMING', isOutgoing: false, number: '+1555' }); return reply(s, id, {});
    }
    default: return fail(s, id, `unknown method ${method}`);
  }
}
