import test from 'node:test';
import assert from 'node:assert/strict';
import { isEndCallRequest } from '../lib/callHangup.js';

test('explicit end-call phrasings are recognised', () => {
  for (const t of ['End the call', 'end call', 'hang up', 'Please hang up now', 'stop the call', 'cancel the call.', 'drop it', 'Hang up!']) {
    assert.equal(isEndCallRequest(t), true, t);
  }
});

test('sentences that merely mention calls or hanging up do not end anything', () => {
  for (const t of ['he hung up on me', "don't hang up yet", 'call him again', 'wait, do not end the call', 'how do I end a call with Sam and then message her later today', 'not yet end the call', '']) {
    assert.equal(isEndCallRequest(t), false, t);
  }
});
