import { createJournalClient, JournalClientError } from './lib/journal-client.mjs';
import { createSupabaseJournalTransport } from './lib/journal-supabase-transport.mjs';

const CLIENT_MODULE = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

export function detectBrowserJournalSource(env = globalThis) {
  const width = Number(env?.innerWidth || 0);
  let finePointer = false;
  try { finePointer = !!env?.matchMedia?.('(pointer:fine)')?.matches; } catch (_) {}
  return finePointer && width >= 900 ? 'desktop' : 'mobile';
}

function originOf(env) {
  try { return String(env?.location?.origin || '').replace(/\/$/, ''); } catch (_) { return ''; }
}

export function createBrowserJournalBinding({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  loadSupabase = () => import(CLIENT_MODULE),
  env = globalThis
} = {}) {
  const state = {
    initPromise: null,
    configured: false,
    config: null,
    supabase: null,
    session: null,
    workspaceId: null,
    journalClient: null,
    source: null,
    lastError: null
  };

  async function fetchConfig() {
    if (typeof fetchImpl !== 'function') throw new JournalClientError('fetch unavailable', { code:'journal_browser_fetch_unavailable', category:'transport', retryable:true });
    const res = await fetchImpl('/api/cloud-config', { cache:'no-store' });
    if (!res?.ok) throw new JournalClientError(`cloud config HTTP ${res?.status || 0}`, { code:'journal_cloud_config_failed', category:'transport', retryable:true });
    const data = await res.json();
    if (!data?.configured || !data?.url || !data?.publishableKey || !data?.siteOrigin) {
      throw new JournalClientError('Journal cloud config incomplete', { code:'journal_cloud_config_incomplete', category:'server' });
    }
    return {
      url: String(data.url),
      publishableKey: String(data.publishableKey),
      siteOrigin: String(data.siteOrigin).replace(/\/$/, '')
    };
  }

  async function init() {
    if (state.initPromise) return state.initPromise;
    state.initPromise = (async () => {
      const cfg = await fetchConfig();
      state.configured = true;
      state.config = cfg;
      const mod = await loadSupabase();
      if (!mod?.createClient) throw new JournalClientError('Supabase browser client unavailable', { code:'journal_supabase_client_unavailable', category:'server' });
      state.supabase = mod.createClient(cfg.url, cfg.publishableKey, {
        auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:true }
      });
      const { data, error } = await state.supabase.auth.getSession();
      if (error) throw error;
      state.session = data?.session || null;
      state.source = detectBrowserJournalSource(env);
      const currentOrigin = originOf(env);
      return {
        configured:true,
        authenticated:!!state.session,
        user:state.session?.user || null,
        originMatch:!!currentOrigin && currentOrigin === cfg.siteOrigin,
        siteOrigin:cfg.siteOrigin,
        currentOrigin,
        source:state.source,
        workspaceId:state.workspaceId,
        error:null
      };
    })().catch(err => {
      state.lastError = err?.message || String(err);
      state.initPromise = null;
      throw err;
    });
    return state.initPromise;
  }

  async function refreshSession() {
    if (!state.supabase) await init();
    const { data, error } = await state.supabase.auth.getSession();
    if (error) throw error;
    state.session = data?.session || null;
    return state.session;
  }

  async function getStatus() {
    if (!state.configured || !state.config) {
      return { configured:false, authenticated:false, originMatch:false, source:detectBrowserJournalSource(env), workspaceId:null, error:state.lastError };
    }
    const session = state.supabase ? await refreshSession().catch(() => state.session) : state.session;
    const currentOrigin = originOf(env);
    return {
      configured:true,
      authenticated:!!session,
      user:session?.user || null,
      originMatch:!!currentOrigin && currentOrigin === state.config.siteOrigin,
      siteOrigin:state.config.siteOrigin,
      currentOrigin,
      source:detectBrowserJournalSource(env),
      workspaceId:state.workspaceId,
      error:state.lastError
    };
  }

  async function requireReady() {
    await init();
    const currentOrigin = originOf(env);
    if (!currentOrigin || currentOrigin !== state.config.siteOrigin) {
      throw new JournalClientError('Journal browser origin mismatch', {
        code:'journal_origin_mismatch', category:'access', details:{ currentOrigin, siteOrigin:state.config.siteOrigin }
      });
    }
    const session = await refreshSession();
    if (!session) throw new JournalClientError('Journal sign-in required', { code:'journal_not_authenticated', category:'auth' });
    return state.supabase;
  }

  async function ensureWorkspace(name = '我的家庭') {
    const supabase = await requireReady();
    if (state.workspaceId) return state.workspaceId;
    const { data, error } = await supabase.rpc('ensure_personal_family_workspace', { workspace_name:name });
    if (error) throw error;
    const id = String(data || '').trim();
    if (!id) throw new JournalClientError('Workspace bootstrap failed', { code:'journal_workspace_bootstrap_failed', category:'server' });
    state.workspaceId = id;
    return id;
  }

  async function getClient() {
    const supabase = await requireReady();
    const source = detectBrowserJournalSource(env);
    if (!state.journalClient || state.source !== source) {
      state.source = source;
      state.journalClient = createJournalClient({
        source,
        transport:createSupabaseJournalTransport(supabase),
        workspaceProvider:() => ensureWorkspace()
      });
    }
    return state.journalClient;
  }

  async function call(method, ...args) {
    try {
      const client = await getClient();
      if (typeof client[method] !== 'function') throw new JournalClientError(`Unknown Journal client method: ${method}`, { code:'journal_method_invalid', category:'validation' });
      return await client[method](...args);
    } catch (err) {
      state.lastError = err?.message || String(err);
      throw err;
    }
  }

  const api = {
    init,
    getStatus,
    ensureWorkspace,
    getClient,
    createEntry:(input, opts) => call('createEntry', input, opts),
    updateEntry:(id, version, patch, opts) => call('updateEntry', id, version, patch, opts),
    archiveEntry:(id, version, opts) => call('archiveEntry', id, version, opts),
    restoreEntry:(id, version, opts) => call('restoreEntry', id, version, opts),
    createBlock:(entryId, input, opts) => call('createBlock', entryId, input, opts),
    updateBlock:(entryId, input, opts) => call('updateBlock', entryId, input, opts),
    reorderBlock:(entryId, input, opts) => call('reorderBlock', entryId, input, opts),
    deleteBlock:(entryId, input, opts) => call('deleteBlock', entryId, input, opts),
    restoreBlock:(entryId, input, opts) => call('restoreBlock', entryId, input, opts),
    listEntries:(opts) => call('listEntries', opts),
    getEntry:(id, opts) => call('getEntry', id, opts)
  };
  return Object.freeze(api);
}

const defaultBinding = createBrowserJournalBinding();
if (typeof window !== 'undefined') window.TwinJournal = defaultBinding;
export default defaultBinding;
