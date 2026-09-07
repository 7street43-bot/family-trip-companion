import test from 'node:test';
import assert from 'node:assert/strict';
import { createJournalClient, JournalClientError, normalizeJournalError } from '../shared/journal-client.mjs';
import { createSupabaseJournalTransport } from '../shared/journal-supabase-transport.mjs';

const WID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const EID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const BID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const MID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

function fakeTransport({ rpcResult = { status: 'applied', targetType: 'entry', targetId: EID, version: 1, operation: 'create' }, queryResult = [] } = {}) {
  const calls = [];
  return {
    calls,
    async rpc(name, args) { calls.push({ type: 'rpc', name, args }); return structuredClone(rpcResult); },
    async query(spec) { calls.push({ type: 'query', spec }); return structuredClone(queryResult); }
  };
}

function client(source, transport, mutationId = MID) {
  return createJournalClient({ source, transport, workspaceProvider: async () => WID, mutationIdFactory: () => mutationId });
}

test('mobile/desktop/gpt share the same command contract while source is fixed per client', async () => {
  for (const source of ['mobile', 'desktop', 'gpt']) {
    const t = fakeTransport();
    const c = client(source, t);
    const r = await c.createEntry({ entryDate: '2026-09-07', title: 'test' });
    assert.equal(r.ok, true);
    assert.equal(r.status, 'applied');
    assert.equal(t.calls[0].name, 'journal_create');
    assert.equal(t.calls[0].args.p_source, source);
    assert.equal(t.calls[0].args.p_mutation_id, MID);
    assert.equal(t.calls[0].args.p_workspace_id, WID);
  }
});

test('create maps client field names to RPC arguments', async () => {
  const t = fakeTransport();
  const c = client('mobile', t);
  await c.createEntry({ entryDate: '2026-09-07', timezone: 'Asia/Taipei', title: '六福村', summary: '摘要', tags: ['動物園'], participants: ['曜澄'], tripRef: 'trip-1' });
  const a = t.calls[0].args;
  assert.equal(a.p_entry_date, '2026-09-07');
  assert.equal(a.p_title, '六福村');
  assert.deepEqual(a.p_tags, ['動物園']);
  assert.deepEqual(a.p_participants, ['曜澄']);
  assert.equal(a.p_trip_ref, 'trip-1');
});

test('update requires expectedVersion and maps supported patch fields only', async () => {
  const t = fakeTransport({ rpcResult: { status: 'applied', targetType: 'entry', targetId: EID, version: 3, operation: 'update' } });
  const c = client('desktop', t);
  await assert.rejects(() => c.updateEntry(EID, 0, { title: 'x' }), e => e instanceof JournalClientError && e.code === 'invalid_expected_version');
  await assert.rejects(() => c.updateEntry(EID, 2, { forbidden: true }), e => e instanceof JournalClientError && e.code === 'unsupported_patch');
  const r = await c.updateEntry(EID, 2, { entryDate: '2026-09-08', title: '更新' });
  assert.equal(r.version, 3);
  assert.deepEqual(t.calls.at(-1).args.p_patch, { entry_date: '2026-09-08', title: '更新' });
});

test('conflict is normal control flow, not an exception', async () => {
  const t = fakeTransport({ rpcResult: { status: 'conflict', reason: 'version_mismatch', serverVersion: 9 } });
  const c = client('gpt', t);
  const r = await c.updateEntry(EID, 8, { title: 'x' }, { mutationId: MID });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'conflict');
  assert.equal(r.conflict.reason, 'version_mismatch');
  assert.equal(r.conflict.serverVersion, 9);
  assert.equal(r.mutationId, MID);
});

test('replayed mutation is successful idempotent control flow', async () => {
  const t = fakeTransport({ rpcResult: { status: 'replayed', targetType: 'entry', targetId: EID, version: 2, operation: 'update' } });
  const c = client('mobile', t);
  const r = await c.updateEntry(EID, 1, { title: 'same' }, { mutationId: MID });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'replayed');
  assert.equal(r.mutationId, MID);
});

test('block operations map to one journal_block_mutate RPC', async () => {
  const t = fakeTransport({ rpcResult: { status: 'applied', targetType: 'block', targetId: BID, version: 1, operation: 'create' } });
  const c = client('mobile', t);
  await c.createBlock(EID, { blockType: 'text', sortOrder: 10, content: { text: 'hello' } });
  assert.equal(t.calls[0].name, 'journal_block_mutate');
  assert.equal(t.calls[0].args.p_operation, 'create');
  assert.equal(t.calls[0].args.p_expected_version, 0);
  assert.equal(t.calls[0].args.p_block_type, 'text');
});

test('archive and restore use journal_archive with explicit boolean', async () => {
  const t = fakeTransport({ rpcResult: { status: 'applied', targetType: 'entry', targetId: EID, version: 2, operation: 'delete' } });
  const c = client('desktop', t);
  await c.archiveEntry(EID, 1);
  assert.equal(t.calls[0].args.p_archived, true);
  t.calls.length = 0;
  await c.restoreEntry(EID, 2);
  assert.equal(t.calls[0].args.p_archived, false);
});

test('listEntries and getEntry keep workspace scope in every query', async () => {
  const t = fakeTransport({ queryResult: [] });
  const c = client('desktop', t);
  await c.listEntries({ from: '2026-01-01', to: '2026-12-31', limit: 20 });
  assert.equal(t.calls[0].spec.workspaceId, WID);
  assert.equal(t.calls[0].spec.table, 'journal_entries');
  assert.ok(t.calls[0].spec.filters.some(f => f.column === 'deleted_at' && f.op === 'is'));
  t.calls.length = 0;
  const result = await c.getEntry(EID, { includeRevisions: true });
  assert.equal(result, null);
  assert.equal(t.calls.length, 4);
  assert.ok(t.calls.every(x => x.spec.workspaceId === WID));
});

test('transport/auth/access/validation errors are normalized consistently', () => {
  const cases = [
    [new Error('Failed to fetch'), 'transport', true],
    [Object.assign(new Error('not authenticated'), { code: 'PGRST301' }), 'auth', false],
    [Object.assign(new Error('workspace access denied'), { code: '42501' }), 'access', false],
    [Object.assign(new Error('invalid expected_version'), { code: '22023' }), 'validation', false]
  ];
  for (const [err, category, retryable] of cases) {
    const n = normalizeJournalError(err, MID);
    assert.equal(n.category, category);
    assert.equal(n.retryable, retryable);
    assert.equal(n.mutationId, MID);
  }
});

test('unknown protocol status fails closed', async () => {
  const t = fakeTransport({ rpcResult: { status: 'mystery' } });
  const c = client('mobile', t);
  await assert.rejects(() => c.createEntry({ entryDate: '2026-09-07' }), e => e instanceof JournalClientError && e.category === 'protocol');
});

test('invalid source and transport fail before any I/O', () => {
  assert.throws(() => createJournalClient({ source: 'admin', transport: {}, workspaceProvider: async () => WID }), JournalClientError);
  assert.throws(() => createJournalClient({ source: 'mobile', transport: {}, workspaceProvider: async () => WID }), JournalClientError);
});

test('Supabase transport allowlists RPCs and journal tables', async () => {
  const rpcCalls = [];
  const queryCalls = [];
  const builder = {
    select() { return this; }, eq(...x) { queryCalls.push(['eq', ...x]); return this; }, is(...x) { queryCalls.push(['is', ...x]); return this; }, gte(...x) { queryCalls.push(['gte', ...x]); return this; }, lte(...x) { queryCalls.push(['lte', ...x]); return this; }, order(...x) { queryCalls.push(['order', ...x]); return this; }, limit(...x) { queryCalls.push(['limit', ...x]); return Promise.resolve({ data: [], error: null }); }
  };
  const supabase = { rpc: async (name, args) => { rpcCalls.push([name, args]); return { data: { status: 'applied' }, error: null }; }, from: () => builder };
  const t = createSupabaseJournalTransport(supabase);
  await t.rpc('journal_create', { a: 1 });
  assert.equal(rpcCalls[0][0], 'journal_create');
  await assert.rejects(() => t.rpc('family_sync_push', {}));
  await t.query({ table: 'journal_entries', workspaceId: WID, filters: [{ column: 'deleted_at', op: 'is', value: null }], limit: 10 });
  await assert.rejects(() => t.query({ table: 'family_sync_records', workspaceId: WID }));
  assert.ok(queryCalls.some(x => x[0] === 'eq' && x[1] === 'workspace_id' && x[2] === WID));
});
