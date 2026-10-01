(() => {
  'use strict';

  const CLIENT_MODULE = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
  let authClientPromise = null;

  function normalizeEmail(value='') {
    return String(value).trim().toLowerCase();
  }

  function validEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  async function fetchCloudConfig() {
    const res = await fetch('/api/cloud-config', { cache:'no-store' });
    if (!res.ok) throw new Error(`cloud_config_http_${res.status}`);
    const cfg = await res.json();
    if (!cfg?.configured || !cfg.url || !cfg.publishableKey || !cfg.siteOrigin) {
      throw new Error('cloud_sync_not_configured');
    }
    return {
      url:String(cfg.url),
      publishableKey:String(cfg.publishableKey),
      siteOrigin:String(cfg.siteOrigin).replace(/\/$/,'')
    };
  }

  async function authClient() {
    if (!authClientPromise) {
      authClientPromise = (async () => {
        const cfg = await fetchCloudConfig();
        const mod = await import(CLIENT_MODULE);
        const client = mod.createClient(cfg.url, cfg.publishableKey, {
          auth: { persistSession:false, autoRefreshToken:false, detectSessionInUrl:false }
        });
        return { client, cfg };
      })().catch(err => {
        authClientPromise = null;
        throw err;
      });
    }
    return authClientPromise;
  }

  async function sendMagicLink(rawEmail) {
    const email = normalizeEmail(rawEmail);
    if (!validEmail(email)) throw new Error('email_invalid');

    const { client, cfg } = await authClient();
    if (location.origin !== cfg.siteOrigin) {
      throw new Error(`cloud_site_origin_mismatch:${location.origin}`);
    }

    const target = `${cfg.siteOrigin}${location.pathname || '/'}`;
    const { error } = await client.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: target,
        shouldCreateUser: true
      }
    });
    if (error) throw error;
    return { email };
  }

  function statusNode(root) {
    return root?.querySelector('[data-email-login-status]') || null;
  }

  function setStatus(root, message, kind='') {
    const node = statusNode(root);
    if (!node) return;
    node.textContent = message;
    node.dataset.kind = kind;
  }

  function friendlyError(err) {
    const msg = String(err?.message || err || 'unknown_error');
    if (msg === 'email_invalid') return '請輸入正確的 Email。';
    if (msg.startsWith('cloud_site_origin_mismatch:')) return 'Email 登入只允許正式站網址；Preview 不會連正式 Auth。';
    if (/not authorized/i.test(msg)) return '目前寄信服務尚未開放這個 Email；正式家人登入前需完成 Custom SMTP。';
    if (/rate limit/i.test(msg)) return '登入信寄送太頻繁，請稍後再試。';
    if (/signup.*disabled|signups.*not allowed/i.test(msg)) return '目前尚未開放建立新的 Email 帳號。';
    return `Email 登入失敗：${msg}`;
  }

  function patchCloudGateCopy() {
    const api = window.TwinCloudSync;
    if (!api || api.__emailAuthGatePatched || typeof api.cloudGate !== 'function') return;
    const original = api.cloudGate.bind(api);
    api.cloudGate = async (...args) => {
      const rows = await original(...args);
      return (rows || []).map(row => row?.id === 'auth' && row?.status === 'WAIT'
        ? { ...row, detail:'請先使用 Email 登入' }
        : row);
    };
    Object.defineProperty(api, '__emailAuthGatePatched', { value:true });
  }

  function patchCloudSyncUi() {
    patchCloudGateCopy();
    const button = document.querySelector('[data-cloud-login]');
    if (!button) return;
    const block = button.closest('.setting-block');
    if (!block) return;

    const intro = block.querySelector('p');
    if (intro && !intro.dataset.emailAuthCopy) {
      intro.textContent = '同一個 Email 帳號可讓手機與電腦使用同一份收藏、行程、主題與外出包。IndexedDB 仍保留做離線快取。';
      intro.dataset.emailAuthCopy = '1';
    }

    button.textContent = '寄送 Email 登入連結';
    button.setAttribute('aria-label','寄送 Email 登入連結');

    if (!block.querySelector('[data-email-login-ui]')) {
      const ui = document.createElement('div');
      ui.dataset.emailLoginUi = '1';
      ui.innerHTML = `
        <div class="field">
          <label for="cloudEmailLogin">Email</label>
          <input id="cloudEmailLogin" type="email" inputmode="email" autocomplete="email" placeholder="name@example.com" />
        </div>
        <div class="helper" data-email-login-status style="margin:8px 0 10px">輸入 Email 後寄送一次性登入連結；點信件中的連結即可登入。</div>`;
      const grid = button.closest('.form-grid');
      if (grid) block.insertBefore(ui, grid);
      else button.before(ui);
    }
  }

  document.addEventListener('click', async ev => {
    const button = ev.target?.closest?.('[data-cloud-login]');
    if (!button) return;

    ev.preventDefault();
    ev.stopImmediatePropagation();

    const block = button.closest('.setting-block');
    const input = block?.querySelector('#cloudEmailLogin');
    const email = normalizeEmail(input?.value || '');
    if (!validEmail(email)) {
      setStatus(block, '請輸入正確的 Email。', 'error');
      input?.focus();
      return;
    }

    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = '正在寄送…';
    setStatus(block, '正在寄送登入連結…', 'pending');
    try {
      const result = await sendMagicLink(email);
      setStatus(block, `登入連結已寄到 ${result.email}，請開啟信件完成登入。`, 'success');
      button.textContent = '重新寄送登入連結';
    } catch (err) {
      setStatus(block, friendlyError(err), 'error');
      button.textContent = originalText || '寄送 Email 登入連結';
    } finally {
      button.disabled = false;
    }
  }, true);

  const observer = new MutationObserver(() => patchCloudSyncUi());
  observer.observe(document.documentElement, { childList:true, subtree:true });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', patchCloudSyncUi, { once:true });
  } else {
    patchCloudSyncUi();
  }

  window.TwinEmailAuth = { sendMagicLink };
})();
