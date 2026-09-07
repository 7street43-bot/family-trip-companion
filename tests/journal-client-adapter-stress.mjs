import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createJournalClient } from '../shared/journal-client.mjs';

const WID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const EID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function transport(mode = 'applied') {
  let calls = 0;
  return {
    get calls() { return calls; },
    async rpc(name, args) {
      calls++;
      if (mode === 'conflict') return { status: 'conflict', reason: 'version_mismatch', serverVersion: 2 };
      if (mode === 'replayed') return { status: 'replayed', targetType: 'entry', targetId: EID, version: 2, operation: 'update' };
      return { status: 'applied', targetType: 'entry', targetId: EID, version: 1, operation: name === 'journal_create' ? 'create' : 'update' };
    },
    async query() { return []; }
  };
}

function makeClient(source, t) {
  return createJournalClient({ source, transport: t, workspaceProvider: async () => WID });
}

async function timed(name, fn) {
  const start = performance.now();
  await fn();
  const ms = performance.now() - start;
  console.log(`${name}: ${ms.toFixed(1)}ms`);
  return ms;
}

const appliedTransport = transport('applied');
const clients = ['mobile', 'desktop', 'gpt'].map(s => makeClient(s, appliedTransport));

await timed('15000 mixed create mutations', async () => {
  const jobs = [];
  for (let i = 0; i < 15000; i++) {
    const c = clients[i % clients.length];
    jobs.push(c.createEntry({ entryDate: '2026-09-07', title: `entry-${i}` }).then(r => {
      assert.equal(r.ok, true);
      assert.equal(r.status, 'applied');
      assert.match(r.mutationId, /^[0-9a-f-]{36}$/i);
    }));
  }
  await Promise.all(jobs);
});
assert.equal(appliedTransport.calls, 15000);

const conflictTransport = transport('conflict');
const conflictClient = makeClient('desktop', conflictTransport);
await timed('10000 conflict normalizations', async () => {
  const jobs = Array.from({ length: 10000 }, (_, i) => conflictClient.updateEntry(EID, 1, { title: `conflict-${i}` }).then(r => {
    assert.equal(r.ok, false);
    assert.equal(r.status, 'conflict');
    assert.equal(r.conflict.reason, 'version_mismatch');
    assert.equal(r.conflict.serverVersion, 2);
  }));
  await Promise.all(jobs);
});
assert.equal(conflictTransport.calls, 10000);

const replayTransport = transport('replayed');
const replayClient = makeClient('gpt', replayTransport);
const SAME_MUTATION = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
await timed('10000 same-mutation replay responses', async () => {
  const jobs = Array.from({ length: 10000 }, () => replayClient.updateEntry(EID, 1, { title: 'same' }, { mutationId: SAME_MUTATION }).then(r => {
    assert.equal(r.ok, true);
    assert.equal(r.status, 'replayed');
    assert.equal(r.mutationId, SAME_MUTATION);
  }));
  await Promise.all(jobs);
});
assert.equal(replayTransport.calls, 10000);

await timed('10000 generated mutation-id uniqueness', async () => {
  const t = transport('applied');
  const c = makeClient('mobile', t);
  const results = await Promise.all(Array.from({ length: 10000 }, (_, i) => c.createEntry({ entryDate: '2026-09-07', title: `uuid-${i}` })));
  const ids = new Set(results.map(x => x.mutationId));
  assert.equal(ids.size, 10000);
});

console.log('J1D CLIENT ADAPTER STRESS = PASS');
