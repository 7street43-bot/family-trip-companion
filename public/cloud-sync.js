(() => {
  'use strict';

  const STATE = {
    configured: false,
    config: null,
    client: null,
    workspaceId: null,
    lastChangeSeq: 0,
    initPromise: null,
    subscription: null,
    syncing: false,
    lastSyncAt: null,
    lastError: null
  };

  const CLIENT_MODULE = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
  const LOCAL_STORES = ['entities','packItems','packState','itineraries','settings'];
  const ALLOWED_STORES = new Set([...LOCAL_STORES,'journals']);
  const META_KEY = 'cloudSyncV1';
  const BACKUP_KEY = 'preCloudSyncBackup';

  async function fetchConfig() {
    const res = await fetch('/api/cloud-config', { cache:'no-store' });
    if (!res.ok) throw new Error(`cloud_config_http_${res.status}`);
    const data = await res.json();
    if (!data?.configured) return { configured:false };
    if (!data.url || !data.publishableKey || !data.siteOrigin) throw new Error('cloud_config_incomplete');
    return { configured:true, url:String(data.url), publishableKey:String(data.publishableKey), siteOrigin:String(data.siteOrigin).replace(/\/$/,'') };
  }

  async function init() {
    if (STATE.initPromise) return STATE.initPromise;
    STATE.initPromise = (async () => {
      const cfg = await fetchConfig();
      STATE.configured = !!cfg.configured;
      STATE.config = cfg;
      if (!STATE.configured) return { configured:false, authenticated:false };

      const mod = await import(CLIENT_MODULE);
      STATE.client = mod.createClient(cfg.url, cfg.publishableKey, {
        auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:true }
      });
      const { data, error } = await STATE.client.auth.getSession();
      if (error) throw error;
      await loadMeta();
      return { configured:true, authenticated:!!data?.session, user:data?.session?.user || null, siteOrigin:cfg.siteOrigin, originMatch:location.origin===cfg.siteOrigin };
    })().catch(err => {
      STATE.initPromise = null;
      STATE.lastError = err?.message || String(err);
      throw err;
    });
    return STATE.initPromise;
  }

  async function client() {
    await init();
    if (!STATE.configured || !STATE.client) throw new Error('cloud_sync_not_configured');
    return STATE.client;
  }

  async function getStatus() {
    let status;
    try { status = await init(); }
    catch (err) { return { configured:false, authenticated:false, workspaceId:null, error:err?.message||String(err) }; }
    if (!status.configured) return { configured:false, authenticated:false, workspaceId:null };
    const c = await client();
    const { data } = await c.auth.getSession();
    return {
      configured:true,
      authenticated:!!data?.session,
      user:data?.session?.user || null,
      workspaceId:STATE.workspaceId,
      lastChangeSeq:STATE.lastChangeSeq,
      lastSyncAt:STATE.lastSyncAt,
      syncing:STATE.syncing,
      error:STATE.lastError,
      siteOrigin:STATE.config?.siteOrigin || '',
      originMatch:!!STATE.config?.siteOrigin && location.origin===STATE.config.siteOrigin
    };
  }

  async function signInWithGoogle(redirectTo = null) {
    const c = await client();
    const siteOrigin=String(STATE.config?.siteOrigin||'').replace(/\/$/,'');
    if(!siteOrigin) throw new Error('cloud_site_origin_missing');
    if(location.origin!==siteOrigin) throw new Error(`cloud_site_origin_mismatch:${location.origin}`);
    const target=redirectTo || `${siteOrigin}${location.pathname}`;
    if(!String(target).startsWith(`${siteOrigin}/`) && String(target)!==siteOrigin) throw new Error('cloud_redirect_origin_rejected');
    const { data, error } = await c.auth.signInWithOAuth({
      provider:'google',
      options:{ redirectTo:target }
    });
    if (error) throw error;
    return data;
  }

  async function signOut() {
    const c = await client();
    if (STATE.subscription) {
      try { await c.removeChannel(STATE.subscription); } catch (_) {}
      STATE.subscription = null;
    }
    STATE.workspaceId = null;
    STATE.lastChangeSeq = 0;
    const { error } = await c.auth.signOut();
    if (error) throw error;
  }

  async function requireSession() {
    const c = await client();
    const { data, error } = await c.auth.getSession();
    if (error) throw error;
    if (!data?.session) throw new Error('cloud_sync_not_authenticated');
    return { c, session:data.session };
  }

  async function ensureWorkspace(name='我的家庭') {
    const { c } = await requireSession();
    const { data, error } = await c.rpc('ensure_personal_family_workspace', { workspace_name:name });
    if (error) throw error;
    STATE.workspaceId = String(data || '');
    if (!STATE.workspaceId) throw new Error('workspace_bootstrap_failed');
    return STATE.workspaceId;
  }

  function requireStore(storeName) {
    const s = String(storeName || '');
    if (!ALLOWED_STORES.has(s)) throw new Error(`invalid_sync_store:${s}`);
    return s;
  }

  async function pullSince(changeSeq=0, { storeName=null, limit=1000 }={}) {
    const { c } = await requireSession();
    const workspaceId = STATE.workspaceId || await ensureWorkspace();
    let q = c.from('family_sync_records')
      .select('workspace_id,store_name,record_id,payload,version,deleted_at,client_updated_at,updated_at,change_seq')
      .eq('workspace_id', workspaceId)
      .gt('change_seq', Number(changeSeq) || 0)
      .order('change_seq', { ascending:true })
      .limit(Math.max(1, Math.min(Number(limit) || 1000, 5000)));
    if (storeName) q = q.eq('store_name', requireStore(storeName));
    const { data, error } = await q;
    if (error) throw error;
    const rows = data || [];
    if (rows.length) STATE.lastChangeSeq = Math.max(STATE.lastChangeSeq, ...rows.map(x => Number(x.change_seq)||0));
    return rows;
  }

  async function pushRecord(storeName, recordId, payload, expectedVersion=0, opts={}) {
    const { c } = await requireSession();
    const workspaceId = STATE.workspaceId || await ensureWorkspace();
    const store = requireStore(storeName);
    const deleted = !!opts.deleted;
    const { data, error } = await c.rpc('family_sync_push', {
      p_workspace_id:workspaceId,
      p_store_name:store,
      p_record_id:String(recordId),
      p_expected_version:Number(expectedVersion)||0,
      p_payload:deleted ? null : payload,
      p_deleted:deleted,
      p_client_updated_at:opts.clientUpdatedAt || new Date().toISOString()
    });
    if (error) throw error;
    if (data?.changeSeq) STATE.lastChangeSeq = Math.max(STATE.lastChangeSeq, Number(data.changeSeq)||0);
    return data;
  }

  function canonical(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }

  async function digest(value) {
    const bytes = new TextEncoder().encode(canonical(value));
    const buf = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
  }

  function recordId(store, row) {
    if (store === 'settings') return String(row?.key || '');
    if (store === 'packState') return String(row?.itemId || '');
    return String(row?.id || '');
  }

  function metaKey(store, id) { return `${store}::${id}`; }

  async function loadMeta() {
    if (!window.TwinDB) return { cursor:0, records:{} };
    const row = await TwinDB.get('meta', META_KEY).catch(()=>null);
    const meta = row?.value && typeof row.value === 'object' ? row.value : { cursor:0, records:{} };
    meta.cursor = Number(meta.cursor)||0;
    meta.records = meta.records && typeof meta.records === 'object' ? meta.records : {};
    STATE.lastChangeSeq = Math.max(STATE.lastChangeSeq, meta.cursor);
    STATE.lastSyncAt = meta.lastSyncAt || null;
    if (meta.workspaceId) STATE.workspaceId = meta.workspaceId;
    return meta;
  }

  async function saveMeta(meta) {
    meta.cursor = Number(meta.cursor)||0;
    meta.workspaceId = STATE.workspaceId || meta.workspaceId || null;
    meta.lastSyncAt = new Date().toISOString();
    STATE.lastChangeSeq = Math.max(STATE.lastChangeSeq, meta.cursor);
    STATE.lastSyncAt = meta.lastSyncAt;
    await TwinDB.put('meta', { key:META_KEY, value:meta, savedAt:meta.lastSyncAt });
  }

  async function localRows() {
    const out = {};
    for (const store of LOCAL_STORES) out[store] = await TwinDB.getAll(store);
    return out;
  }

  async function backupLocalOnce() {
    const prior = await TwinDB.get('meta', BACKUP_KEY).catch(()=>null);
    if (prior?.value) return false;
    const value = await TwinDB.snapshot();
    await TwinDB.put('meta', { key:BACKUP_KEY, value, savedAt:new Date().toISOString() });
    return true;
  }

  async function applyRemoteRow(row, meta) {
    const store = String(row.store_name||'');
    if (!LOCAL_STORES.includes(store)) return;
    const id = String(row.record_id||'');
    if (!id) return;
    const key = metaKey(store,id);
    const m = meta.records[key] || {};
    const local = await TwinDB.get(store, id).catch(()=>null);
    const localHash = local ? await digest(local) : null;
    const knownHash = m.hash || null;
    const localChanged = knownHash !== null && localHash !== knownHash;

    if (localChanged && Number(row.version||0) > Number(m.version||0)) {
      throw new Error(`cloud_sync_conflict:${store}:${id}`);
    }

    if (row.deleted_at) {
      if (local) await TwinDB.remove(store,id);
      meta.records[key] = {
        version:Number(row.version)||0,
        hash:null,
        deleted:true,
        changeSeq:Number(row.change_seq)||0,
        updatedAt:row.updated_at||null
      };
    } else {
      const payload = row.payload;
      if (!payload || typeof payload !== 'object') throw new Error(`cloud_payload_invalid:${store}:${id}`);
      await TwinDB.put(store,payload);
      meta.records[key] = {
        version:Number(row.version)||0,
        hash:await digest(payload),
        deleted:false,
        changeSeq:Number(row.change_seq)||0,
        updatedAt:row.updated_at||null
      };
    }
    meta.cursor = Math.max(Number(meta.cursor)||0, Number(row.change_seq)||0);
  }

  async function bootstrap() {
    if (!window.TwinDB) throw new Error('local_db_unavailable');
    await requireSession();
    const workspaceId = await ensureWorkspace();
    let meta = await loadMeta();
    meta.workspaceId = workspaceId;
    if (meta.initialized) return { initialized:false, reason:'already_initialized' };

    await backupLocalOnce();
    const remote = await pullSince(0,{limit:5000});
    const local = await localRows();
    let pulled=0, pushed=0;

    if (remote.length) {
      for (const row of remote) { await applyRemoteRow(row,meta); pulled++; }
      const afterRemote = await localRows();
      for (const store of LOCAL_STORES) {
        const remoteIds = new Set(remote.filter(r=>r.store_name===store).map(r=>String(r.record_id)));
        for (const row of afterRemote[store]) {
          const id=recordId(store,row); if(!id || remoteIds.has(id)) continue;
          const res=await pushRecord(store,id,row,0,{clientUpdatedAt:row.updatedAt||row.savedAt||null});
          if(res?.status!=='applied') throw new Error(`cloud_bootstrap_push_${res?.status||'failed'}:${store}:${id}`);
          const key=metaKey(store,id);
          meta.records[key]={version:Number(res.version)||1,hash:await digest(row),deleted:false,changeSeq:Number(res.changeSeq)||0,updatedAt:res.updatedAt||null};
          meta.cursor=Math.max(meta.cursor,Number(res.changeSeq)||0); pushed++;
        }
      }
    } else {
      for (const store of LOCAL_STORES) {
        for (const row of local[store]) {
          const id=recordId(store,row); if(!id) continue;
          const res=await pushRecord(store,id,row,0,{clientUpdatedAt:row.updatedAt||row.savedAt||null});
          if(res?.status!=='applied') throw new Error(`cloud_bootstrap_push_${res?.status||'failed'}:${store}:${id}`);
          const key=metaKey(store,id);
          meta.records[key]={version:Number(res.version)||1,hash:await digest(row),deleted:false,changeSeq:Number(res.changeSeq)||0,updatedAt:res.updatedAt||null};
          meta.cursor=Math.max(meta.cursor,Number(res.changeSeq)||0); pushed++;
        }
      }
    }
    meta.initialized=true;
    await saveMeta(meta);
    return { initialized:true, remoteWasEmpty:!remote.length, pulled, pushed, workspaceId };
  }

  async function syncNow() {
    if (STATE.syncing) return { status:'busy' };
    STATE.syncing=true; STATE.lastError=null;
    try {
      await requireSession();
      STATE.workspaceId = STATE.workspaceId || await ensureWorkspace();
      let meta=await loadMeta();
      if(!meta.initialized) await bootstrap();
      meta=await loadMeta();
      let pulled=0,pushed=0,deleted=0;

      const remote=await pullSince(meta.cursor||0,{limit:5000});
      for(const row of remote){await applyRemoteRow(row,meta);pulled++;}

      const rows=await localRows();
      const present=new Set();
      for(const store of LOCAL_STORES){
        for(const row of rows[store]){
          const id=recordId(store,row);if(!id)continue;
          const k=metaKey(store,id);present.add(k);
          const h=await digest(row),m=meta.records[k];
          if(m && !m.deleted && h===m.hash)continue;
          const expected=Number(m?.version)||0;
          const res=await pushRecord(store,id,row,expected,{clientUpdatedAt:row.updatedAt||row.savedAt||null});
          if(res?.status==='conflict')throw new Error(`cloud_sync_conflict:${store}:${id}`);
          if(res?.status!=='applied')throw new Error(`cloud_sync_push_failed:${store}:${id}`);
          meta.records[k]={version:Number(res.version)||expected+1,hash:h,deleted:false,changeSeq:Number(res.changeSeq)||0,updatedAt:res.updatedAt||null};
          meta.cursor=Math.max(meta.cursor,Number(res.changeSeq)||0);pushed++;
        }
      }

      for(const [k,m] of Object.entries(meta.records)){
        if(m?.deleted||present.has(k))continue;
        const sep=k.indexOf('::');if(sep<1)continue;
        const store=k.slice(0,sep),id=k.slice(sep+2);
        if(!LOCAL_STORES.includes(store))continue;
        const res=await pushRecord(store,id,null,Number(m.version)||0,{deleted:true});
        if(res?.status==='conflict')throw new Error(`cloud_sync_delete_conflict:${store}:${id}`);
        if(res?.status!=='applied')throw new Error(`cloud_sync_delete_failed:${store}:${id}`);
        meta.records[k]={version:Number(res.version)||Number(m.version)+1,hash:null,deleted:true,changeSeq:Number(res.changeSeq)||0,updatedAt:res.updatedAt||null};
        meta.cursor=Math.max(meta.cursor,Number(res.changeSeq)||0);deleted++;
      }

      await saveMeta(meta);
      return {status:'ok',pulled,pushed,deleted,cursor:meta.cursor,lastSyncAt:meta.lastSyncAt};
    }catch(err){STATE.lastError=err?.message||String(err);throw err;}
    finally{STATE.syncing=false;}
  }

  async function cloudGate() {
    const status=await init();
    const results=[];
    results.push({id:'config',status:status.configured?'PASS':'FAIL',detail:status.configured?'Supabase config OK':'Cloud config 尚未設定'});
    if(!status.configured)return results;
    const originMatch=location.origin===String(status.siteOrigin||'');
    results.push({id:'site-origin',status:originMatch?'PASS':'FAIL',detail:originMatch?`正式 Site OK｜${location.origin}`:`目前 ${location.origin}｜應為 ${status.siteOrigin||'未設定'}`});
    if(!originMatch)return results;
    const s=await getStatus();
    results.push({id:'auth',status:s.authenticated?'PASS':'WAIT',detail:s.authenticated?`已登入 ${s.user?.email||''}`:'請先使用 Google 登入'});
    if(!s.authenticated)return results;
    const wid=await ensureWorkspace();
    results.push({id:'workspace',status:wid?'PASS':'FAIL',detail:wid?'Family Workspace OK':'Workspace 建立失敗'});
    const rows=await pullSince(0,{limit:1});
    results.push({id:'rls-read',status:'PASS',detail:`RLS read OK｜sample=${rows.length}`});
    return results;
  }

  async function subscribe(onChange) {
    if (typeof onChange !== 'function') throw new Error('onChange_required');
    const { c } = await requireSession();
    const workspaceId = STATE.workspaceId || await ensureWorkspace();
    if (STATE.subscription) { try { await c.removeChannel(STATE.subscription); } catch (_) {} }
    STATE.subscription = c.channel(`family-sync:${workspaceId}`)
      .on('postgres_changes', {event:'*',schema:'public',table:'family_sync_records',filter:`workspace_id=eq.${workspaceId}`}, payload=>onChange(payload))
      .subscribe();
    return STATE.subscription;
  }

  window.TwinCloudSync = {
    init,getStatus,signInWithGoogle,signOut,ensureWorkspace,pullSince,pushRecord,
    bootstrap,syncNow,cloudGate,subscribe,
    get configured(){return STATE.configured;},
    get workspaceId(){return STATE.workspaceId;}
  };
})();
