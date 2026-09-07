const SOURCES = new Set(['mobile', 'desktop', 'gpt']);
const MUTATION_STATUSES = new Set(['applied', 'replayed', 'conflict']);

export class JournalClientError extends Error {
  constructor(message, { code = 'journal_error', category = 'server', retryable = false, details = null, mutationId = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'JournalClientError';
    this.code = code;
    this.category = category;
    this.retryable = !!retryable;
    this.details = details;
    this.mutationId = mutationId;
  }
}

function ensureObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JournalClientError(`${name} must be an object`, { code: `invalid_${name}`, category: 'validation' });
  return value;
}

function ensureString(value, name, { allowEmpty = false } = {}) {
  const s = String(value ?? '');
  if (!allowEmpty && !s.trim()) throw new JournalClientError(`${name} is required`, { code: `invalid_${name}`, category: 'validation' });
  return s;
}

function ensureVersion(value, { create = false } = {}) {
  const n = Number(value);
  const valid = Number.isSafeInteger(n) && (create ? n === 0 : n >= 1);
  if (!valid) throw new JournalClientError(create ? 'expectedVersion must be 0 for create' : 'expectedVersion must be a positive integer', { code: 'invalid_expected_version', category: 'validation' });
  return n;
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (!globalThis.crypto?.getRandomValues) throw new JournalClientError('secure UUID generation unavailable', { code: 'uuid_unavailable', category: 'client' });
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function errorInfo(error) {
  if (!error) return { message: 'Unknown journal error', code: null, details: null };
  if (error instanceof JournalClientError) return { message: error.message, code: error.code, details: error.details };
  return {
    message: String(error.message || error.error_description || error.error || error),
    code: error.code == null ? null : String(error.code),
    details: error.details ?? error.hint ?? null
  };
}

export function normalizeJournalError(error, mutationId = null) {
  if (error instanceof JournalClientError) {
    if (mutationId && !error.mutationId) error.mutationId = mutationId;
    return error;
  }
  const info = errorInfo(error);
  const text = `${info.message} ${info.code || ''}`.toLowerCase();
  let category = 'server';
  let code = info.code || 'journal_server_error';
  let retryable = false;

  if (/not authenticated|jwt|pgrst301|auth.*session|cloud_sync_not_authenticated/.test(text)) {
    category = 'auth'; code = 'journal_not_authenticated';
  } else if (/workspace access denied|permission denied|42501|not authorized|forbidden/.test(text)) {
    category = 'access'; code = 'journal_access_denied';
  } else if (/22023|invalid .*|required|must be|forbidden fields|cannot be null/.test(text)) {
    category = 'validation'; code = 'journal_validation_failed';
  } else if (/network|fetch|timeout|timed out|econn|enotfound|failed to fetch|load failed/.test(text)) {
    category = 'transport'; code = 'journal_transport_error'; retryable = true;
  }

  return new JournalClientError(info.message, { code, category, retryable, details: info.details, mutationId, cause: error });
}

function unwrapTransportResult(result) {
  if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'error')) {
    if (result.error) throw result.error;
    return result.data;
  }
  return result;
}

function normalizeMutation(data, mutationId) {
  if (!data || typeof data !== 'object') throw new JournalClientError('Journal mutation returned an invalid response', { code: 'journal_protocol_invalid', category: 'protocol', mutationId });
  const status = String(data.status || '');
  if (!MUTATION_STATUSES.has(status)) throw new JournalClientError(`Unknown journal mutation status: ${status || '(empty)'}`, { code: 'journal_protocol_status', category: 'protocol', details: data, mutationId });

  const base = {
    ok: status === 'applied' || status === 'replayed',
    status,
    mutationId,
    targetType: data.targetType ?? null,
    targetId: data.targetId ?? null,
    version: data.version == null ? null : Number(data.version),
    operation: data.operation ?? null
  };
  if (status === 'conflict') {
    return {
      ...base,
      conflict: {
        reason: String(data.reason || 'unknown_conflict'),
        serverVersion: data.serverVersion == null ? null : Number(data.serverVersion)
      }
    };
  }
  return base;
}

export function createJournalClient({ source, transport, workspaceProvider, mutationIdFactory = uuid } = {}) {
  const actorSource = String(source || '').toLowerCase();
  if (!SOURCES.has(actorSource)) throw new JournalClientError('source must be mobile, desktop, or gpt', { code: 'invalid_source', category: 'validation' });
  if (!transport || typeof transport.rpc !== 'function' || typeof transport.query !== 'function') throw new JournalClientError('transport.rpc and transport.query are required', { code: 'invalid_transport', category: 'validation' });
  if (typeof workspaceProvider !== 'function') throw new JournalClientError('workspaceProvider is required', { code: 'invalid_workspace_provider', category: 'validation' });

  async function workspaceId() {
    const id = ensureString(await workspaceProvider(), 'workspaceId');
    return id;
  }

  async function mutate(rpc, args, suppliedMutationId = null) {
    const mutationId = suppliedMutationId ? ensureString(suppliedMutationId, 'mutationId') : mutationIdFactory();
    try {
      const data = unwrapTransportResult(await transport.rpc(rpc, { ...args, p_source: actorSource, p_mutation_id: mutationId }));
      return normalizeMutation(data, mutationId);
    } catch (error) {
      throw normalizeJournalError(error, mutationId);
    }
  }

  async function query(spec) {
    try { return unwrapTransportResult(await transport.query(spec)) || []; }
    catch (error) { throw normalizeJournalError(error); }
  }

  async function createEntry(input = {}, opts = {}) {
    ensureObject(input, 'entry');
    const wid = await workspaceId();
    const entryDate = ensureString(input.entryDate, 'entryDate');
    return mutate('journal_create', {
      p_workspace_id: wid,
      p_entry_date: entryDate,
      p_timezone: String(input.timezone || 'Asia/Taipei'),
      p_title: input.title ?? null,
      p_summary: input.summary ?? null,
      p_tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
      p_participants: Array.isArray(input.participants) ? input.participants.map(String) : [],
      p_trip_ref: input.tripRef ?? null
    }, opts.mutationId);
  }

  async function updateEntry(entryId, expectedVersion, patch, opts = {}) {
    const wid = await workspaceId();
    ensureObject(patch, 'patch');
    if (!Object.keys(patch).length) throw new JournalClientError('patch must not be empty', { code: 'empty_patch', category: 'validation' });
    const mapped = {};
    const keys = { entryDate: 'entry_date', timezone: 'timezone', title: 'title', summary: 'summary', tags: 'tags', participants: 'participants', tripRef: 'trip_ref' };
    for (const [k, db] of Object.entries(keys)) if (Object.prototype.hasOwnProperty.call(patch, k)) mapped[db] = patch[k];
    if (!Object.keys(mapped).length) throw new JournalClientError('patch contains no supported fields', { code: 'unsupported_patch', category: 'validation' });
    return mutate('journal_update', { p_workspace_id: wid, p_entry_id: ensureString(entryId, 'entryId'), p_expected_version: ensureVersion(expectedVersion), p_patch: mapped }, opts.mutationId);
  }

  async function setEntryArchived(entryId, expectedVersion, archived, opts = {}) {
    const wid = await workspaceId();
    return mutate('journal_archive', { p_workspace_id: wid, p_entry_id: ensureString(entryId, 'entryId'), p_expected_version: ensureVersion(expectedVersion), p_archived: !!archived }, opts.mutationId);
  }

  async function mutateBlock(entryId, operation, input = {}, opts = {}) {
    const wid = await workspaceId();
    ensureObject(input, 'block');
    const op = ensureString(operation, 'operation').toLowerCase();
    if (!['create', 'update', 'reorder', 'delete', 'restore'].includes(op)) throw new JournalClientError('unsupported block operation', { code: 'invalid_block_operation', category: 'validation' });
    const expectedVersion = ensureVersion(input.expectedVersion ?? (op === 'create' ? 0 : NaN), { create: op === 'create' });
    return mutate('journal_block_mutate', {
      p_workspace_id: wid,
      p_entry_id: ensureString(entryId, 'entryId'),
      p_operation: op,
      p_block_id: input.blockId ?? null,
      p_expected_version: expectedVersion,
      p_block_type: input.blockType ?? null,
      p_sort_order: input.sortOrder ?? null,
      p_content: input.content && typeof input.content === 'object' && !Array.isArray(input.content) ? input.content : {}
    }, opts.mutationId);
  }

  async function listEntries({ from = null, to = null, tripRef = null, includeArchived = false, limit = 100 } = {}) {
    const wid = await workspaceId();
    const filters = [];
    if (!includeArchived) filters.push({ column: 'deleted_at', op: 'is', value: null });
    if (from) filters.push({ column: 'entry_date', op: 'gte', value: from });
    if (to) filters.push({ column: 'entry_date', op: 'lte', value: to });
    if (tripRef != null) filters.push({ column: 'trip_ref', op: 'eq', value: tripRef });
    return query({ table: 'journal_entries', workspaceId: wid, filters, order: [{ column: 'entry_date', ascending: false }, { column: 'updated_at', ascending: false }], limit: Math.max(1, Math.min(Number(limit) || 100, 500)) });
  }

  async function getEntry(entryId, { includeArchived = true, includeRevisions = false } = {}) {
    const wid = await workspaceId();
    const id = ensureString(entryId, 'entryId');
    const entryFilters = [{ column: 'id', op: 'eq', value: id }];
    if (!includeArchived) entryFilters.push({ column: 'deleted_at', op: 'is', value: null });
    const [entries, blocks, media, revisions] = await Promise.all([
      query({ table: 'journal_entries', workspaceId: wid, filters: entryFilters, limit: 1 }),
      query({ table: 'journal_blocks', workspaceId: wid, filters: [{ column: 'entry_id', op: 'eq', value: id }], order: [{ column: 'sort_order', ascending: true }, { column: 'created_at', ascending: true }], limit: 1000 }),
      query({ table: 'journal_media', workspaceId: wid, filters: [{ column: 'entry_id', op: 'eq', value: id }], order: [{ column: 'sort_order', ascending: true }, { column: 'created_at', ascending: true }], limit: 1000 }),
      includeRevisions ? query({ table: 'journal_revisions', workspaceId: wid, filters: [{ column: 'entry_id', op: 'eq', value: id }], order: [{ column: 'created_at', ascending: false }], limit: 500 }) : Promise.resolve([])
    ]);
    if (!entries.length) return null;
    return { entry: entries[0], blocks, media, revisions };
  }

  return Object.freeze({
    source: actorSource,
    createEntry,
    updateEntry,
    archiveEntry: (id, version, opts) => setEntryArchived(id, version, true, opts),
    restoreEntry: (id, version, opts) => setEntryArchived(id, version, false, opts),
    createBlock: (entryId, input, opts) => mutateBlock(entryId, 'create', input, opts),
    updateBlock: (entryId, input, opts) => mutateBlock(entryId, 'update', input, opts),
    reorderBlock: (entryId, input, opts) => mutateBlock(entryId, 'reorder', input, opts),
    deleteBlock: (entryId, input, opts) => mutateBlock(entryId, 'delete', input, opts),
    restoreBlock: (entryId, input, opts) => mutateBlock(entryId, 'restore', input, opts),
    listEntries,
    getEntry
  });
}
