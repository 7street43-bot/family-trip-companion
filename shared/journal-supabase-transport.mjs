const TABLES = new Set(['journal_entries', 'journal_blocks', 'journal_media', 'journal_revisions']);
const OPS = new Set(['eq', 'is', 'gte', 'lte']);

function invalid(message) {
  const error = new Error(message);
  error.code = 'JOURNAL_TRANSPORT_INVALID';
  return error;
}

export function createSupabaseJournalTransport(supabaseClient) {
  if (!supabaseClient || typeof supabaseClient.rpc !== 'function' || typeof supabaseClient.from !== 'function') {
    throw invalid('A Supabase client with rpc() and from() is required');
  }

  async function rpc(name, args) {
    if (!['journal_create', 'journal_update', 'journal_archive', 'journal_block_mutate'].includes(String(name || ''))) {
      throw invalid(`Journal RPC not allowed: ${name}`);
    }
    return supabaseClient.rpc(name, args || {});
  }

  async function query(spec = {}) {
    const table = String(spec.table || '');
    if (!TABLES.has(table)) throw invalid(`Journal table not allowed: ${table}`);
    const workspaceId = String(spec.workspaceId || '').trim();
    if (!workspaceId) throw invalid('workspaceId is required');

    let q = supabaseClient.from(table).select('*').eq('workspace_id', workspaceId);
    for (const filter of spec.filters || []) {
      const column = String(filter?.column || '');
      const op = String(filter?.op || '');
      if (!column || !OPS.has(op)) throw invalid('Invalid journal query filter');
      q = q[op](column, filter.value);
    }
    for (const order of spec.order || []) {
      const column = String(order?.column || '');
      if (!column) throw invalid('Invalid journal query order');
      q = q.order(column, { ascending: !!order.ascending });
    }
    const limit = Math.max(1, Math.min(Number(spec.limit) || 100, 1000));
    q = q.limit(limit);
    return q;
  }

  return Object.freeze({ rpc, query });
}
