import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const statusEl = document.getElementById('status');
const loginBox = document.getElementById('loginBox');
const consentBox = document.getElementById('consentBox');
const emailEl = document.getElementById('email');
const sendLinkBtn = document.getElementById('sendLink');
const approveBtn = document.getElementById('approve');
const denyBtn = document.getElementById('deny');
const clientDetail = document.getElementById('clientDetail');

function setStatus(message, kind='') {
  statusEl.textContent = message;
  statusEl.className = `status ${kind}`.trim();
}

function escapeHtml(value='') {
  return String(value).replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
}

async function config() {
  const res = await fetch('/api/cloud-config', {cache:'no-store'});
  if (!res.ok) throw new Error(`cloud_config_http_${res.status}`);
  const data = await res.json();
  if (!data?.configured || !data.url || !data.publishableKey || !data.siteOrigin) throw new Error('cloud_sync_not_configured');
  const siteOrigin = String(data.siteOrigin).replace(/\/$/,'');
  if (location.origin !== siteOrigin) throw new Error('oauth_consent_requires_production_origin');
  return { url:String(data.url), key:String(data.publishableKey), siteOrigin };
}

const authorizationId = new URL(location.href).searchParams.get('authorization_id') || '';
let supabase = null;
let authDetails = null;

async function load() {
  if (!authorizationId) {
    setStatus('缺少 authorization_id，無法處理授權要求。','error');
    return;
  }
  try {
    const cfg = await config();
    supabase = createClient(cfg.url, cfg.key, {auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
    const {data:{session},error} = await supabase.auth.getSession();
    if (error) throw error;
    if (!session) {
      loginBox.hidden = false;
      setStatus('請先使用 Email 登入，再確認是否授權 ChatGPT。');
      return;
    }
    await loadAuthorization();
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg === 'oauth_consent_requires_production_origin') {
      setStatus('OAuth 授權頁目前只允許正式站執行；Preview 僅做程式驗證。','error');
    } else setStatus(`授權頁載入失敗：${msg}`,'error');
  }
}

async function loadAuthorization() {
  setStatus('正在讀取授權內容…');
  const {data,error} = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
  if (error) throw error;
  if (!data) throw new Error('authorization_request_not_found');
  if (!('authorization_id' in data) && data.redirect_url) {
    location.assign(data.redirect_url);
    return;
  }
  authDetails = data;
  const scopes = String(data.scope || 'email').trim().split(/\s+/).filter(Boolean);
  clientDetail.innerHTML = `<strong>${escapeHtml(data.client?.name || 'ChatGPT')}</strong><br>`+
    `<span class="muted">要求權限：${escapeHtml(scopes.join('、') || 'email')}</span><br>`+
    `<span class="muted">回傳位置：${escapeHtml(data.redirect_uri || '')}</span>`;
  consentBox.hidden = false;
  loginBox.hidden = true;
  setStatus('請確認是否允許此應用以你的身份存取旅遊日誌。');
}

sendLinkBtn.addEventListener('click', async () => {
  const email = String(emailEl.value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setStatus('請輸入正確的 Email。','error');
    return;
  }
  sendLinkBtn.disabled = true;
  try {
    const target = location.href;
    const {error} = await supabase.auth.signInWithOtp({email,options:{emailRedirectTo:target,shouldCreateUser:true}});
    if (error) throw error;
    setStatus(`登入連結已寄到 ${email}，請從信件回到此授權頁。`,'ok');
  } catch (err) {
    setStatus(`寄送失敗：${String(err?.message || err)}`,'error');
  } finally {
    sendLinkBtn.disabled = false;
  }
});

async function decide(approved) {
  if (!supabase || !authDetails) return;
  approveBtn.disabled = true;
  denyBtn.disabled = true;
  try {
    const call = approved ? supabase.auth.oauth.approveAuthorization.bind(supabase.auth.oauth) : supabase.auth.oauth.denyAuthorization.bind(supabase.auth.oauth);
    const {data,error} = await call(authorizationId);
    if (error) throw error;
    if (!data?.redirect_url) throw new Error('oauth_redirect_missing');
    location.assign(data.redirect_url);
  } catch (err) {
    setStatus(`授權處理失敗：${String(err?.message || err)}`,'error');
    approveBtn.disabled = false;
    denyBtn.disabled = false;
  }
}

approveBtn.addEventListener('click',()=>decide(true));
denyBtn.addEventListener('click',()=>decide(false));
load();
