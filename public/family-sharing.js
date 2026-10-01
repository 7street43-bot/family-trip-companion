(() => {
  'use strict';

  let mounted = false;
  let refreshing = false;

  function friendlyError(err) {
    const msg = String(err?.message || err || 'unknown_error');
    if (msg.includes('workspace owner required')) return '只有家庭擁有者可以建立邀請碼。';
    if (msg.includes('invite_token_invalid') || msg.includes('invalid input syntax for type uuid')) return '邀請碼格式不正確。';
    if (msg.includes('invite expired')) return '這組邀請碼已過期，請重新建立。';
    if (msg.includes('invite already used')) return '這組邀請碼已經使用過。';
    if (msg.includes('invite revoked')) return '這組邀請碼已失效。';
    if (msg.includes('invite invalid')) return '找不到這組邀請碼。';
    if (msg.includes('cloud_sync_conflict')) return '切換前發現同步衝突，已停止切換，資料沒有被覆蓋。';
    return `家庭共編操作失敗：${msg}`;
  }

  function setStatus(root, message, kind='') {
    const node = root?.querySelector('[data-family-status]');
    if (!node) return;
    node.textContent = message;
    node.dataset.kind = kind;
  }

  function sharingRoot() {
    return document.querySelector('[data-family-sharing-ui]');
  }

  async function refresh() {
    const root = sharingRoot();
    const api = window.TwinCloudSync;
    if (!root || !api || refreshing) return;
    refreshing = true;
    try {
      const status = await api.getStatus();
      const signedIn = !!status?.authenticated;
      root.querySelector('[data-family-auth-required]').hidden = signedIn;
      root.querySelector('[data-family-controls]').hidden = !signedIn;
      if (!signedIn) {
        setStatus(root, '先完成 Email 登入後，就能建立或加入家庭共編。');
        return;
      }

      await api.ensureWorkspace();
      const workspaces = await api.listWorkspaces();
      const select = root.querySelector('[data-family-workspace-select]');
      select.textContent = '';
      for (const ws of workspaces) {
        const option = document.createElement('option');
        option.value = ws.id;
        option.textContent = `${ws.name}｜${ws.role === 'owner' ? '擁有者' : '家人'}`;
        option.selected = !!ws.active;
        select.appendChild(option);
      }
      const active = workspaces.find(ws => ws.active) || workspaces[0] || null;
      root.dataset.role = active?.role || '';
      root.querySelector('[data-family-create-invite]').hidden = active?.role !== 'owner';
      setStatus(root, active ? `目前共編家庭：${active.name}` : '尚未建立家庭 Workspace。', 'success');
    } catch (err) {
      setStatus(root, friendlyError(err), 'error');
    } finally {
      refreshing = false;
    }
  }

  function mount() {
    if (mounted) return;
    const login = document.querySelector('[data-cloud-login]');
    if (!login) return;
    const block = login.closest('.setting-block') || login.parentElement;
    if (!block || block.querySelector('[data-family-sharing-ui]')) {
      mounted = true;
      return;
    }

    const root = document.createElement('div');
    root.dataset.familySharingUi = '1';
    root.style.marginTop = '18px';
    root.style.paddingTop = '16px';
    root.style.borderTop = '1px solid rgba(0,0,0,.08)';
    root.innerHTML = `
      <div style="font-weight:700;margin-bottom:6px">家庭共編</div>
      <div class="helper" data-family-status>先完成 Email 登入後，就能建立或加入家庭共編。</div>
      <div data-family-auth-required class="helper" style="margin-top:8px">同一個家庭 Workspace 內，手機與電腦會共用行程、收藏、外出包與日誌。</div>
      <div data-family-controls hidden style="margin-top:12px">
        <div class="field">
          <label>目前家庭</label>
          <select data-family-workspace-select></select>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 14px">
          <button type="button" class="btn secondary" data-family-switch>切換家庭</button>
          <button type="button" class="btn secondary" data-family-create-invite>建立 24 小時邀請碼</button>
        </div>
        <div data-family-invite-result hidden style="margin:0 0 14px">
          <div class="field">
            <label>邀請碼</label>
            <input data-family-invite-output type="text" readonly />
          </div>
          <button type="button" class="btn secondary" data-family-copy-invite>複製邀請碼</button>
        </div>
        <div class="field">
          <label>加入家人的家庭</label>
          <input data-family-join-token type="text" autocomplete="off" placeholder="貼上家人提供的邀請碼" />
        </div>
        <button type="button" class="btn primary" data-family-join>加入家庭</button>
        <div class="helper" style="margin-top:8px">加入前會先備份此裝置的本機資料，再切換成家庭雲端資料；不會直接混合兩份資料。</div>
      </div>`;
    block.appendChild(root);
    mounted = true;
    refresh();
  }

  document.addEventListener('click', async ev => {
    const root = sharingRoot();
    const api = window.TwinCloudSync;
    if (!root || !api) return;

    const createBtn = ev.target.closest?.('[data-family-create-invite]');
    if (createBtn) {
      createBtn.disabled = true;
      setStatus(root, '正在建立邀請碼…', 'pending');
      try {
        const result = await api.createFamilyInvite(24);
        const token = String(result?.token || '');
        if (!token) throw new Error('invite_token_missing');
        root.querySelector('[data-family-invite-output]').value = token;
        root.querySelector('[data-family-invite-result]').hidden = false;
        setStatus(root, '邀請碼已建立，24 小時內可使用一次。', 'success');
      } catch (err) {
        setStatus(root, friendlyError(err), 'error');
      } finally {
        createBtn.disabled = false;
      }
      return;
    }

    const copyBtn = ev.target.closest?.('[data-family-copy-invite]');
    if (copyBtn) {
      const value = root.querySelector('[data-family-invite-output]')?.value || '';
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        setStatus(root, '邀請碼已複製。', 'success');
      } catch (_) {
        const input = root.querySelector('[data-family-invite-output]');
        input?.select();
        setStatus(root, '已選取邀請碼，請手動複製。');
      }
      return;
    }

    const joinBtn = ev.target.closest?.('[data-family-join]');
    if (joinBtn) {
      const token = root.querySelector('[data-family-join-token]')?.value || '';
      joinBtn.disabled = true;
      setStatus(root, '正在加入家庭並安全切換資料…', 'pending');
      try {
        const result = await api.redeemFamilyInvite(token);
        setStatus(root, `已加入 ${result?.workspaceName || '家庭'}，即將重新載入。`, 'success');
        setTimeout(() => location.reload(), 350);
      } catch (err) {
        setStatus(root, friendlyError(err), 'error');
        joinBtn.disabled = false;
      }
      return;
    }

    const switchBtn = ev.target.closest?.('[data-family-switch]');
    if (switchBtn) {
      const target = root.querySelector('[data-family-workspace-select]')?.value || '';
      if (!target) return;
      switchBtn.disabled = true;
      setStatus(root, '正在同步目前資料並切換家庭…', 'pending');
      try {
        const result = await api.switchWorkspace(target, { remoteAuthoritative:true, reason:'manual_ui' });
        if (result?.status === 'already_active') {
          setStatus(root, '已經是目前家庭。', 'success');
          switchBtn.disabled = false;
        } else {
          setStatus(root, `已切換到 ${result?.workspaceName || '家庭'}，即將重新載入。`, 'success');
          setTimeout(() => location.reload(), 350);
        }
      } catch (err) {
        setStatus(root, friendlyError(err), 'error');
        switchBtn.disabled = false;
      }
    }
  });

  const observer = new MutationObserver(() => mount());
  observer.observe(document.documentElement, { childList:true, subtree:true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once:true });
  else mount();
})();
