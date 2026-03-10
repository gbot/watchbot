// ─── STATE ────────────────────────────────────────────────────────────────────
let trackers    = [];
let editingId   = null;
let currentUser = null;
let evtSource   = null;
let confirmResolver   = null;
let confirmKeyHandler = null;

// Tracker filter (client-side)
let trackerFilter    = '';
let showChangedOnly  = false;
let showActiveOnly   = false;
let showAIOnly       = false;

// Admin panel — search & pagination state
const ADMIN_PAGE_SIZE      = 25;
let adminUsersSearchVal    = '';
let adminUsersPage         = 0;
let adminTrackersSearchVal = '';
let adminTrackersPage      = 0;
let adminTrackersSelected  = new Set();
let adminUsersSelected     = new Set();
let _adminCache            = { users: null, trackers: null, userMap: null };

// ─── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      currentUser = await res.json();
      showApp();
    } else {
      showAuthOverlay('login');
    }
  } catch {
    showAuthOverlay('login');
  }
}

// ─── AUTH UI ──────────────────────────────────────────────────────────────────
function showAuthOverlay(tab = 'login') {
  const overlay = document.getElementById('authOverlay');
  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open', 'auth-visible');
  switchAuthTab(tab);
  setTimeout(() => {
    const el = document.getElementById(tab === 'login' ? 'loginUsername' : 'registerUsername');
    if (el) el.focus();
  }, 100);
}

function hideAuthOverlay() {
  const overlay = document.getElementById('authOverlay');
  overlay.classList.remove('show');
  overlay.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open', 'auth-visible');
}

function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === tab)
  );
  document.getElementById('loginForm').style.display    = tab === 'login'    ? '' : 'none';
  document.getElementById('registerForm').style.display = tab === 'register' ? '' : 'none';
  document.getElementById('authError').textContent = '';
}

function showApp() {
  hideAuthOverlay();
  document.getElementById('userDisplay').textContent = currentUser.username;
  document.getElementById('userArea').style.display  = 'flex';
  const adminBtn = document.getElementById('adminPanelBtn');
  const banner   = document.getElementById('impersonationBanner');
  if (currentUser.impersonatedBy) {
    document.getElementById('impersonationTarget').textContent = currentUser.username;
    banner.style.display = 'flex';
    adminBtn.style.display = 'none'; // hide admin button while impersonating
  } else {
    banner.style.display = 'none';
    adminBtn.style.display = currentUser.role === 'superadmin' ? 'flex' : 'none';
  }
  if (currentUser.notificationsEnabled && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  // Sync filter state with whatever the browser restored on reload
  showChangedOnly = document.getElementById('showChangedOnlyChk')?.checked ?? false;
  showActiveOnly  = document.getElementById('showActiveOnlyChk')?.checked  ?? false;
  showAIOnly      = document.getElementById('showAIOnlyChk')?.checked      ?? false;
  trackerFilter   = (document.getElementById('trackerSearch')?.value ?? '').trim().toLowerCase();
  connectSSE();
}

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errorEl  = document.getElementById('authError');
  errorEl.textContent = '';
  try {
    const res  = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) { errorEl.textContent = data.error || 'Login failed'; return; }
    currentUser = data;
    showApp();
  } catch {
    errorEl.textContent = 'Connection error. Is the server running?';
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const username = document.getElementById('registerUsername').value.trim();
  const email    = document.getElementById('registerEmail').value.trim();
  const password = document.getElementById('registerPassword').value;
  const confirm  = document.getElementById('registerConfirm').value;
  const errorEl  = document.getElementById('authError');
  errorEl.textContent = '';
  if (password !== confirm) { errorEl.textContent = 'Passwords do not match'; return; }
  try {
    const res  = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password })
    });
    const data = await res.json();
    if (!res.ok) { errorEl.textContent = data.error || 'Registration failed'; return; }
    currentUser = data;
    showApp();
    showSnackbar(`Welcome to Watchbot, ${currentUser.username}!`);
  } catch {
    errorEl.textContent = 'Connection error. Is the server running?';
  }
}

async function handleLogout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  if (evtSource) { evtSource.close(); evtSource = null; }
  currentUser = null;
  trackers    = [];
  renderTrackers();
  updateBadge();
  document.getElementById('userArea').style.display = 'none';
  document.getElementById('impersonationBanner').style.display = 'none';
  showAuthOverlay('login');
}

// ─── ADMIN PANEL ──────────────────────────────────────────────────────────────
let adminCurrentTab = 'users';

async function openAdminPanel() {
  // Clear cache and reset search/page/selection state every time the panel opens
  _adminCache            = { users: null, trackers: null, userMap: null };
  adminUsersSearchVal    = '';
  adminUsersPage         = 0;
  adminTrackersSearchVal = '';
  adminTrackersPage      = 0;
  adminTrackersSelected  = new Set();
  adminUsersSelected     = new Set();
  const usEl = document.getElementById('adminUsersSearchInput');
  if (usEl) usEl.value = '';
  const trEl = document.getElementById('adminTrackersSearchInput');
  if (trEl) trEl.value = '';
  const overlay = document.getElementById('adminOverlay');
  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  switchAdminTab('users');
}

function closeAdminPanel() {
  const overlay = document.getElementById('adminOverlay');
  overlay.classList.remove('show');
  overlay.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
}

function switchAdminTab(tab) {
  adminCurrentTab = tab;
  document.querySelectorAll('.admin-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === tab)
  );
  document.getElementById('adminUsersTab').style.display    = tab === 'users'    ? '' : 'none';
  document.getElementById('adminTrackersTab').style.display = tab === 'trackers' ? '' : 'none';
  // Reset to page 0 each time a tab is (re-)selected
  if (tab === 'users') adminUsersPage = 0;
  else adminTrackersPage = 0;
  loadAdminTab(tab);
}

async function loadAdminTab(tab, forceRefresh = true) {
  if (tab === 'users') {
    if (forceRefresh || !_adminCache.users) {
      const res = await fetch('/api/admin/users');
      if (!res.ok) return;
      _adminCache.users = await res.json();
    }
    renderAdminUsersTable(_adminCache.users);
  } else {
    if (forceRefresh || !_adminCache.trackers) {
      const tRes = await fetch('/api/admin/trackers');
      if (!tRes.ok) return;
      _adminCache.trackers = await tRes.json();
      if (!_adminCache.users) {
        const uRes = await fetch('/api/admin/users');
        _adminCache.users = uRes.ok ? await uRes.json() : [];
      }
      _adminCache.userMap = Object.fromEntries(_adminCache.users.map(u => [u.id, u.username]));
    }
    renderAdminTrackersTable(_adminCache.trackers, _adminCache.userMap || {});
  }
}

function renderAdminUsersTable(users) {
  const q        = adminUsersSearchVal;
  const filtered = q
    ? users.filter(u =>
        u.username.toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q))
    : users;

  const totalPages = Math.max(1, Math.ceil(filtered.length / ADMIN_PAGE_SIZE));
  adminUsersPage   = Math.min(adminUsersPage, totalPages - 1);
  const page = filtered.slice(adminUsersPage * ADMIN_PAGE_SIZE, (adminUsersPage + 1) * ADMIN_PAGE_SIZE);

  const tbody = document.getElementById('adminUsersBody');
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="admin-empty">${q ? 'No users match your search.' : 'No users found.'}</td></tr>`;
  } else {
    tbody.innerHTML = page.map(u => `
      <tr>
        <td>${u.id === currentUser.id ? '' : `<input type="checkbox" data-usel="${u.id}" ${adminUsersSelected.has(u.id) ? 'checked' : ''} onchange="adminUserSelectToggle('${u.id}', this.checked)" style="cursor:pointer;accent-color:var(--primary)">`}</td>
        <td><strong>${escHtml(u.username)}</strong></td>
        <td>${u.email ? escHtml(u.email) : '<span style="color:var(--on-surface-light)">—</span>'}</td>
        <td><span class="admin-role-badge admin-role-${u.role === 'superadmin' ? 'superadmin' : 'user'}">${u.role === 'superadmin' ? 'Super Admin' : 'User'}</span></td>
        <td>${u.trackerCount}</td>
        <td>${u.id === currentUser.id ? '—' : `<input type="number" min="0" value="${u.trackerLimit ?? ''}" placeholder="∞"
          style="width:56px;padding:3px 6px;border:1px solid var(--divider);border-radius:6px;font-size:12px;background:var(--surface)"
          onchange="adminSetTrackerLimit('${u.id}', this.value)" title="Max trackers (blank = unlimited)" />`}</td>
        <td>${u.id === currentUser.id ? '' : `<label class="toggle-switch" title="${u.disabled ? 'Enable' : 'Disable'} account">
          <input type="checkbox" ${u.disabled ? '' : 'checked'} onchange="adminToggleDisabled('${u.id}', !this.checked)">
          <span class="toggle-track"></span>
        </label>`}</td>
        <td style="color:var(--on-surface-medium);font-size:12px">${new Date(u.createdAt).toLocaleDateString()}</td>
        <td>${u.id === currentUser.id ? '' : `
          <div class="btn-group">
            <button class="btn-icon" style="color:var(--on-surface-medium)" title="Edit user" onclick="openEditUser('${u.id}','${escHtml(u.username)}','${escHtml(u.email||'')}','${u.role}','${u.trackerLimit??''}')">
              <span class="material-icons" style="font-size:18px">edit</span>
            </button>
            <button class="btn-icon" style="color:var(--primary)" title="Impersonate user" onclick="adminImpersonate('${u.id}','${escHtml(u.username)}')">
              <span class="material-icons" style="font-size:18px">theater_comedy</span>
            </button>
            <button class="btn-icon" style="color:var(--error)" title="Delete user" onclick="adminDeleteUser('${u.id}','${escHtml(u.username)}')">
              <span class="material-icons" style="font-size:18px">person_remove</span>
            </button>
          </div>`}</td>
      </tr>`).join('');
  }
  _syncAdminUsersSelectAll();
  _updateAdminUsersBulkBar();
  renderAdminPagination('adminUsersPagination', adminUsersPage, totalPages, filtered.length, 'users');
}

// ─── USER BULK SELECT ─────────────────────────────────────────────────────────
function _getAdminUsersPageIds() {
  if (!_adminCache.users) return [];
  const q = adminUsersSearchVal;
  const filtered = q
    ? _adminCache.users.filter(u =>
        u.username.toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q))
    : _adminCache.users;
  const clampedPage = Math.min(adminUsersPage, Math.max(0, Math.ceil(filtered.length / ADMIN_PAGE_SIZE) - 1));
  return filtered
    .slice(clampedPage * ADMIN_PAGE_SIZE, (clampedPage + 1) * ADMIN_PAGE_SIZE)
    .filter(u => u.id !== currentUser.id)   // never include yourself
    .map(u => u.id);
}

function adminUserSelectToggle(id, checked) {
  if (checked) adminUsersSelected.add(id);
  else adminUsersSelected.delete(id);
  _syncAdminUsersSelectAll();
  _updateAdminUsersBulkBar();
}

function adminUserSelectAllPage(checked) {
  const pageIds = _getAdminUsersPageIds();
  pageIds.forEach(id => checked ? adminUsersSelected.add(id) : adminUsersSelected.delete(id));
  document.querySelectorAll('#adminUsersBody input[data-usel]').forEach(cb => { cb.checked = checked; });
  _syncAdminUsersSelectAll();
  _updateAdminUsersBulkBar();
}

function adminUserClearSelection() {
  adminUsersSelected.clear();
  document.querySelectorAll('#adminUsersBody input[data-usel]').forEach(cb => { cb.checked = false; });
  _syncAdminUsersSelectAll();
  _updateAdminUsersBulkBar();
}

function _syncAdminUsersSelectAll() {
  const cb = document.getElementById('adminUsersSelectAllOnPage');
  if (!cb) return;
  const pageIds = _getAdminUsersPageIds();
  const allSel  = pageIds.length > 0 && pageIds.every(id => adminUsersSelected.has(id));
  const someSel = pageIds.some(id => adminUsersSelected.has(id));
  cb.checked       = allSel;
  cb.indeterminate = !allSel && someSel;
}

function _updateAdminUsersBulkBar() {
  const count      = adminUsersSelected.size;
  const countEl    = document.getElementById('adminUsrSelCount');
  const enableBtn  = document.getElementById('adminUsrBulkEnableBtn');
  const disableBtn = document.getElementById('adminUsrBulkDisableBtn');
  const deleteBtn  = document.getElementById('adminUsrBulkDeleteBtn');
  const clearBtn   = document.getElementById('adminUsrClearSelBtn');
  if (countEl)    countEl.textContent        = count > 0 ? `${count} user${count !== 1 ? 's' : ''} selected` : '';
  if (enableBtn)  enableBtn.disabled         = count === 0;
  if (disableBtn) disableBtn.disabled        = count === 0;
  if (deleteBtn)  deleteBtn.disabled         = count === 0;
  if (clearBtn)   clearBtn.style.visibility  = count > 0 ? 'visible' : 'hidden';
}

async function adminBulkDeleteUsers() {
  const count = adminUsersSelected.size;
  if (count === 0) return;
  const ok = await openDeleteConfirmDialog(
    `${count} user${count !== 1 ? 's' : ''} and all their trackers`,
    `Delete ${count} user${count !== 1 ? 's' : ''}?`
  );
  if (!ok) return;
  const ids = [...adminUsersSelected];
  adminUsersSelected.clear();
  let failed = 0;
  await Promise.all(ids.map(async id => {
    const res = await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
    if (!res.ok) failed++;
  }));
  if (failed > 0) showSnackbar(`${failed} deletion${failed !== 1 ? 's' : ''} failed.`, 'error');
  else showSnackbar(`${ids.length} user${ids.length !== 1 ? 's' : ''} deleted.`);
  _adminCache.users    = null;
  _adminCache.trackers = null; // trackers owned by deleted users are gone too
  loadAdminTab('users');
}

async function adminBulkToggleUsers(disable) {
  const count = adminUsersSelected.size;
  if (count === 0) return;
  const ids = [...adminUsersSelected];
  let failed = 0;
  await Promise.all(ids.map(async id => {
    const res = await fetch(`/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: disable }),
    });
    if (!res.ok) failed++;
  }));
  if (failed > 0) showSnackbar(`${failed} update${failed !== 1 ? 's' : ''} failed.`, 'error');
  else showSnackbar(`${ids.length} user${ids.length !== 1 ? 's' : ''} ${disable ? 'disabled' : 'enabled'}.`);
  _adminCache.users = null;
  loadAdminTab('users');
}

function renderAdminTrackersTable(all, userMap) {
  const q        = adminTrackersSearchVal;
  const filtered = q
    ? all.filter(t =>
        (t.label || t.url).toLowerCase().includes(q) ||
        (t.url   || '').toLowerCase().includes(q)    ||
        (userMap[t.userId] || '').toLowerCase().includes(q))
    : all;

  const totalPages  = Math.max(1, Math.ceil(filtered.length / ADMIN_PAGE_SIZE));
  adminTrackersPage = Math.min(adminTrackersPage, totalPages - 1);
  const page = filtered.slice(adminTrackersPage * ADMIN_PAGE_SIZE, (adminTrackersPage + 1) * ADMIN_PAGE_SIZE);

  const tbody = document.getElementById('adminTrackersBody');
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="admin-empty">${q ? 'No trackers match your search.' : 'No trackers found.'}</td></tr>`;
  } else {
    tbody.innerHTML = page.map(t => `
      <tr>
        <td><input type="checkbox" data-sel="${t.id}" ${adminTrackersSelected.has(t.id) ? 'checked' : ''} onchange="adminTrackerSelectToggle('${t.id}', this.checked)" style="cursor:pointer;accent-color:var(--primary)"></td>
        <td>${escHtml(t.label || t.url)}</td>
        <td><span class="admin-url" title="${escHtml(t.url)}">${escHtml(t.url)}</span></td>
        <td style="font-size:12px;color:var(--on-surface-medium)">${escHtml(userMap[t.userId] || t.userId)}</td>
        <td style="font-size:12px;color:var(--on-surface-medium);white-space:nowrap">${intervalText(t.interval)}</td>
        <td><span class="chip chip-${t.status === 'changed' ? 'changed' : t.status === 'error' ? 'error' : t.active ? 'ok' : 'paused'}" style="font-size:11px">${t.active ? t.status : 'paused'}</span></td>
        <td style="text-align:center">${t.changeCount || 0}</td>
        <td><label class="toggle-switch" title="${t.active ? 'Disable' : 'Enable'} tracker">
          <input type="checkbox" ${t.active ? 'checked' : ''} onchange="adminToggleTracker('${t.id}', this.checked)">
          <span class="toggle-track"></span>
        </label></td>
        <td><button class="btn-icon" style="color:var(--error)" title="Delete tracker" onclick="adminDeleteTracker('${t.id}','${escHtml(t.label || t.url)}')"><span class="material-icons" style="font-size:18px">delete_outline</span></button></td>
      </tr>`).join('');
  }
  _syncAdminTrackersSelectAll();
  _updateAdminTrackersBulkBar();
  renderAdminPagination('adminTrackersPagination', adminTrackersPage, totalPages, filtered.length, 'trackers');
}

// ─── TRACKER BULK SELECT ──────────────────────────────────────────────────────
function _getAdminTrackersPageIds() {
  if (!_adminCache.trackers) return [];
  const q = adminTrackersSearchVal;
  const filtered = q
    ? _adminCache.trackers.filter(t =>
        (t.label || t.url).toLowerCase().includes(q) ||
        (t.url   || '').toLowerCase().includes(q)    ||
        (_adminCache.userMap?.[t.userId] || '').toLowerCase().includes(q))
    : _adminCache.trackers;
  const clampedPage = Math.min(adminTrackersPage, Math.max(0, Math.ceil(filtered.length / ADMIN_PAGE_SIZE) - 1));
  return filtered.slice(clampedPage * ADMIN_PAGE_SIZE, (clampedPage + 1) * ADMIN_PAGE_SIZE).map(t => t.id);
}

function adminTrackerSelectToggle(id, checked) {
  if (checked) adminTrackersSelected.add(id);
  else adminTrackersSelected.delete(id);
  _syncAdminTrackersSelectAll();
  _updateAdminTrackersBulkBar();
}

function adminTrackerSelectAllPage(checked) {
  const pageIds = _getAdminTrackersPageIds();
  pageIds.forEach(id => checked ? adminTrackersSelected.add(id) : adminTrackersSelected.delete(id));
  document.querySelectorAll('#adminTrackersBody input[data-sel]').forEach(cb => { cb.checked = checked; });
  _syncAdminTrackersSelectAll();
  _updateAdminTrackersBulkBar();
}

function adminTrackerClearSelection() {
  adminTrackersSelected.clear();
  document.querySelectorAll('#adminTrackersBody input[data-sel]').forEach(cb => { cb.checked = false; });
  _syncAdminTrackersSelectAll();
  _updateAdminTrackersBulkBar();
}

function _syncAdminTrackersSelectAll() {
  const cb = document.getElementById('adminSelectAllOnPage');
  if (!cb) return;
  const pageIds = _getAdminTrackersPageIds();
  const allSel  = pageIds.length > 0 && pageIds.every(id => adminTrackersSelected.has(id));
  const someSel = pageIds.some(id => adminTrackersSelected.has(id));
  cb.checked       = allSel;
  cb.indeterminate = !allSel && someSel;
}

function _updateAdminTrackersBulkBar() {
  const count      = adminTrackersSelected.size;
  const countEl    = document.getElementById('adminTrkSelCount');
  const enableBtn  = document.getElementById('adminTrkBulkEnableBtn');
  const disableBtn = document.getElementById('adminTrkBulkDisableBtn');
  const deleteBtn  = document.getElementById('adminTrkBulkDeleteBtn');
  const clearBtn   = document.getElementById('adminTrkClearSelBtn');
  if (countEl)    countEl.textContent        = count > 0 ? `${count} tracker${count !== 1 ? 's' : ''} selected` : '';
  if (enableBtn)  enableBtn.disabled         = count === 0;
  if (disableBtn) disableBtn.disabled        = count === 0;
  if (deleteBtn)  deleteBtn.disabled         = count === 0;
  if (clearBtn)   clearBtn.style.visibility  = count > 0 ? 'visible' : 'hidden';
}

async function adminBulkDeleteTrackers() {
  const count = adminTrackersSelected.size;
  if (count === 0) return;
  const ok = await openDeleteConfirmDialog(`${count} tracker${count !== 1 ? 's' : ''}`, `Delete ${count} tracker${count !== 1 ? 's' : ''}?`);
  if (!ok) return;
  const ids = [...adminTrackersSelected];
  adminTrackersSelected.clear();
  let failed = 0;
  await Promise.all(ids.map(async id => {
    const res = await fetch(`/api/admin/trackers/${id}`, { method: 'DELETE' });
    if (!res.ok) failed++;
  }));
  if (failed > 0) showSnackbar(`${failed} deletion${failed !== 1 ? 's' : ''} failed.`, 'error');
  else showSnackbar(`${ids.length} tracker${ids.length !== 1 ? 's' : ''} deleted.`);
  _adminCache.trackers = null;
  loadAdminTab('trackers');
}

async function adminBulkToggleTrackers(active) {
  const count = adminTrackersSelected.size;
  if (count === 0) return;
  const ids = [...adminTrackersSelected];
  let failed = 0;
  await Promise.all(ids.map(async id => {
    const res = await fetch(`/api/admin/trackers/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active }),
    });
    if (!res.ok) failed++;
  }));
  if (failed > 0) showSnackbar(`${failed} update${failed !== 1 ? 's' : ''} failed.`, 'error');
  else showSnackbar(`${ids.length} tracker${ids.length !== 1 ? 's' : ''} ${active ? 'enabled' : 'disabled'}.`);
  _adminCache.trackers = null;
  loadAdminTab('trackers');
}

function renderAdminPagination(containerId, page, totalPages, total, tab) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (totalPages <= 1) {
    el.innerHTML = total > 0 ? `<span>${total} result${total !== 1 ? 's' : ''}</span>` : '';
    return;
  }
  const start = page * ADMIN_PAGE_SIZE + 1;
  const end   = Math.min((page + 1) * ADMIN_PAGE_SIZE, total);
  el.innerHTML = `
    <span>${start}–${end} of ${total}</span>
    <div style="display:flex;align-items:center;gap:4px">
      <button class="btn btn-text" style="padding:4px 8px" onclick="adminChangePage('${tab}',${page - 1})" ${page === 0 ? 'disabled' : ''}>
        <span class="material-icons" style="font-size:20px">chevron_left</span>
      </button>
      <span style="font-size:13px">Page ${page + 1} / ${totalPages}</span>
      <button class="btn btn-text" style="padding:4px 8px" onclick="adminChangePage('${tab}',${page + 1})" ${page >= totalPages - 1 ? 'disabled' : ''}>
        <span class="material-icons" style="font-size:20px">chevron_right</span>
      </button>
    </div>`;
}

function adminChangePage(tab, page) {
  if (tab === 'users') adminUsersPage = page;
  else adminTrackersPage = page;
  loadAdminTab(tab, false); // use cached data — no new fetch
}

function setAdminUsersSearch(val) {
  adminUsersSearchVal = val.trim().toLowerCase();
  adminUsersPage = 0;
  if (_adminCache.users) renderAdminUsersTable(_adminCache.users);
}

function setAdminTrackersSearch(val) {
  adminTrackersSearchVal = val.trim().toLowerCase();
  adminTrackersPage = 0;
  if (_adminCache.trackers) renderAdminTrackersTable(_adminCache.trackers, _adminCache.userMap || {});
}

async function adminAddUser() {
  const username = document.getElementById('adminNewUsername').value.trim();
  const email    = document.getElementById('adminNewEmail').value.trim();
  const password = document.getElementById('adminNewPassword').value;
  const role     = document.getElementById('adminNewRole').value;
  const msgEl    = document.getElementById('adminAddUserMsg');
  msgEl.textContent = '';
  msgEl.className   = 'profile-msg';

  if (!username || !email || !password) {
    msgEl.textContent = 'Username, email, and password are required.';
    msgEl.classList.add('error');
    return;
  }

  const res  = await fetch('/api/admin/users', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ username, email, password, role }),
  });
  const data = await res.json();
  if (!res.ok) {
    msgEl.textContent = data.error || 'Failed to create user.';
    msgEl.classList.add('error');
  } else {
    msgEl.textContent = `User "${data.username}" created.`;
    msgEl.classList.add('success');
    document.getElementById('adminNewUsername').value = '';
    document.getElementById('adminNewEmail').value = '';
    document.getElementById('adminNewPassword').value = '';
    document.getElementById('adminNewRole').value = 'user';
    loadAdminTab('users');
  }
}

async function adminDeleteUser(id, username) {
  const ok = await openDeleteConfirmDialog(`user "${username}" and all their trackers`, 'Delete user?');
  if (!ok) return;
  const res = await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
  if (res.ok) {
    adminUsersSelected.delete(id);
    _adminCache.users = null;
    showSnackbar(`User ${username} deleted.`);
    loadAdminTab('users');
  } else { const d = await res.json(); showSnackbar(d.error || 'Delete failed', 'error'); }
}

async function adminImpersonate(id, username) {
  const res = await fetch(`/api/admin/impersonate/${id}`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) { showSnackbar(data.error || 'Failed to impersonate', 'error'); return; }
  currentUser = data;
  closeAdminPanel();
  if (evtSource) { evtSource.close(); evtSource = null; }
  trackers = [];
  renderTrackers();
  showApp();
}

async function stopImpersonating() {
  const res = await fetch('/api/admin/stop-impersonate', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) { showSnackbar(data.error || 'Failed to restore session', 'error'); return; }
  currentUser = data;
  if (evtSource) { evtSource.close(); evtSource = null; }
  trackers = [];
  renderTrackers();
  showApp();
}

// ─── EDIT USER ───────────────────────────────────────────────────────────────
let editUserId = null;

function openEditUser(id, username, email, role, limit) {
  editUserId = id;
  document.getElementById('editUserSubtitle').textContent = username;
  document.getElementById('editUserEmail').value = email;
  document.getElementById('editUserRole').value = role;
  document.getElementById('editUserLimit').value = limit;
  document.getElementById('editUserMsg').textContent = '';
  document.getElementById('editUserMsg').className = 'profile-msg';
  const overlay = document.getElementById('editUserOverlay');
  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  document.getElementById('editUserEmail').focus();
}

function closeEditUser() {
  const overlay = document.getElementById('editUserOverlay');
  overlay.classList.remove('show');
  overlay.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
  editUserId = null;
}

async function saveEditUser() {
  if (!editUserId) return;
  const email = document.getElementById('editUserEmail').value.trim();
  const role  = document.getElementById('editUserRole').value;
  const limitRaw = document.getElementById('editUserLimit').value;
  const trackerLimit = limitRaw === '' ? null : parseInt(limitRaw);
  const msgEl = document.getElementById('editUserMsg');
  msgEl.textContent = '';
  msgEl.className = 'profile-msg';

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    msgEl.textContent = 'Please enter a valid email address.';
    msgEl.classList.add('error');
    return;
  }

  const res = await fetch(`/api/admin/users/${editUserId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email || null, role, trackerLimit }),
  });
  const data = await res.json();
  if (!res.ok) {
    msgEl.textContent = data.error || 'Failed to save changes.';
    msgEl.classList.add('error');
  } else {
    showSnackbar('User updated.');
    closeEditUser();
    loadAdminTab('users');
  }
}

async function adminToggleDisabled(id, disable) {
  const res = await fetch(`/api/admin/users/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ disabled: disable }),
  });
  if (res.ok) {
    showSnackbar(disable ? 'Account disabled.' : 'Account enabled.');
    loadAdminTab('users');
  } else {
    const d = await res.json();
    showSnackbar(d.error || 'Update failed', 'error');
    loadAdminTab('users'); // revert toggle in UI
  }
}

async function adminSetTrackerLimit(id, value) {
  const limit = value === '' ? null : parseInt(value);
  const res = await fetch(`/api/admin/users/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trackerLimit: limit }),
  });
  if (res.ok) showSnackbar('Tracker limit updated.');
  else { const d = await res.json(); showSnackbar(d.error || 'Update failed', 'error'); }
}

async function adminToggleTracker(id, active) {
  const res = await fetch(`/api/admin/trackers/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active }),
  });
  if (res.ok) {
    showSnackbar(active ? 'Tracker enabled.' : 'Tracker disabled.');
    loadAdminTab('trackers');
  } else {
    const d = await res.json();
    showSnackbar(d.error || 'Update failed', 'error');
    loadAdminTab('trackers'); // revert toggle in UI
  }
}

async function adminDeleteTracker(id, label) {
  const ok = await openDeleteConfirmDialog(`tracker "${label}"`, 'Delete tracker?');
  if (!ok) return;
  const res = await fetch(`/api/admin/trackers/${id}`, { method: 'DELETE' });
  if (res.ok) {
    adminTrackersSelected.delete(id);
    _adminCache.trackers = null;
    showSnackbar('Tracker deleted.');
    loadAdminTab('trackers');
  } else { const d = await res.json(); showSnackbar(d.error || 'Delete failed', 'error'); }
}

// ─── PROFILE ──────────────────────────────────────────────────────────────────
async function openProfile() {
  document.getElementById('profileEmailMsg').textContent = '';
  document.getElementById('profilePwMsg').textContent    = '';
  document.getElementById('profileEmailMsg').className   = 'profile-msg';
  document.getElementById('profilePwMsg').className      = 'profile-msg';
  document.getElementById('profileCurrentPw').value = '';
  document.getElementById('profileNewPw').value      = '';
  document.getElementById('profileConfirmPw').value  = '';
  document.getElementById('profileDeletePw').value   = '';
  if (document.getElementById('profileDeleteMsg')) {
    document.getElementById('profileDeleteMsg').textContent = '';
    document.getElementById('profileDeleteMsg').className   = 'profile-msg';
  }
  document.getElementById('profileUsernameDisplay').textContent = currentUser?.username || '';

  try {
    const res = await fetch('/api/auth/profile');
    if (res.ok) {
      const profile = await res.json();
      document.getElementById('profileEmail').value = profile.email || '';
      document.getElementById('profileNotifications').checked = profile.notificationsEnabled !== false;
    }
  } catch {}

  const overlay = document.getElementById('profileOverlay');
  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  setTimeout(() => document.getElementById('profileEmail').focus(), 100);
}

function closeProfile() {
  const overlay = document.getElementById('profileOverlay');
  overlay.classList.remove('show');
  overlay.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
}

async function saveProfileEmail() {
  const email = document.getElementById('profileEmail').value.trim();
  const msgEl = document.getElementById('profileEmailMsg');
  msgEl.textContent = '';
  msgEl.className   = 'profile-msg';
  try {
    const res  = await fetch('/api/auth/profile', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email }),
    });
    const data = await res.json();
    if (!res.ok) {
      msgEl.textContent = data.error || 'Failed to save email';
      msgEl.classList.add('error');
    } else {
      msgEl.textContent = 'Email saved.';
      msgEl.classList.add('success');
    }
  } catch {
    msgEl.textContent = 'Connection error.';
    msgEl.classList.add('error');
  }
}

async function saveProfilePassword() {
  const currentPw = document.getElementById('profileCurrentPw').value;
  const newPw     = document.getElementById('profileNewPw').value;
  const confirmPw = document.getElementById('profileConfirmPw').value;
  const msgEl     = document.getElementById('profilePwMsg');
  msgEl.textContent = '';
  msgEl.className   = 'profile-msg';

  if (!currentPw || !newPw || !confirmPw) {
    msgEl.textContent = 'All password fields are required.';
    msgEl.classList.add('error');
    return;
  }
  if (newPw !== confirmPw) {
    msgEl.textContent = 'New passwords do not match.';
    msgEl.classList.add('error');
    return;
  }
  if (newPw.length < 6) {
    msgEl.textContent = 'New password must be at least 6 characters.';
    msgEl.classList.add('error');
    return;
  }

  try {
    const res  = await fetch('/api/auth/profile', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
    });
    const data = await res.json();
    if (!res.ok) {
      msgEl.textContent = data.error || 'Failed to change password';
      msgEl.classList.add('error');
    } else {
      msgEl.textContent = 'Password changed successfully.';
      msgEl.classList.add('success');
      document.getElementById('profileCurrentPw').value = '';
      document.getElementById('profileNewPw').value     = '';
      document.getElementById('profileConfirmPw').value  = '';
    }
  } catch {
    msgEl.textContent = 'Connection error.';
    msgEl.classList.add('error');
  }
}

function sendTestNotification() {
  if (Notification.permission === 'granted') {
    showBrowserNotification('Watchbot: Notifications working!', 'Browser notifications are enabled and working correctly.', '/');
  } else if (Notification.permission === 'denied') {
    showSnackbar('Notifications are blocked in your browser settings.', 'error');
  } else {
    Notification.requestPermission().then(p => {
      if (p === 'granted') sendTestNotification();
    });
  }
}

async function saveProfileNotifications(enabled) {
  try {
    await fetch('/api/auth/profile', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ notificationsEnabled: enabled }),
    });
    if (currentUser) currentUser.notificationsEnabled = enabled;
    if (enabled && Notification.permission !== 'granted' && Notification.permission !== 'denied') {
      Notification.requestPermission();
    }
  } catch {}
}

async function deleteAccount() {
  const pw    = document.getElementById('profileDeletePw').value;
  const msgEl = document.getElementById('profileDeleteMsg');
  msgEl.textContent = '';
  msgEl.className   = 'profile-msg';
  if (!pw) {
    msgEl.textContent = 'Please enter your password to confirm.';
    msgEl.classList.add('error');
    return;
  }
  const ok = await openDeleteConfirmDialog('your account and all your trackers', 'Delete account?');
  if (!ok) return;
  try {
    const res  = await fetch('/api/auth/profile', {
      method:  'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ password: pw }),
    });
    const data = await res.json();
    if (!res.ok) {
      msgEl.textContent = data.error || 'Failed to delete account';
      msgEl.classList.add('error');
    } else {
      closeProfile();
      if (evtSource) { evtSource.close(); evtSource = null; }
      currentUser = null;
      trackers    = [];
      renderTrackers();
      updateBadge();
      document.getElementById('userArea').style.display = 'none';
      showAuthOverlay('login');
    }
  } catch {
    msgEl.textContent = 'Connection error.';
    msgEl.classList.add('error');
  }
}

// ─── SSE ──────────────────────────────────────────────────────────────────────
function connectSSE() {
  if (evtSource) evtSource.close();
  evtSource = new EventSource('/api/events');
  evtSource.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'force_logout') {
      if (evtSource) { evtSource.close(); evtSource = null; }
      currentUser = null;
      trackers    = [];
      renderTrackers();
      updateBadge();
      document.getElementById('userArea').style.display = 'none';
      showAuthOverlay('login');
      return;
    }
    if (data.type === 'init' || data.type === 'update') {
      const prevStatuses = Object.fromEntries(trackers.map(t => [t.id, t.status]));
      if (data.type === 'init') {
        // Full replace on initial load
        trackers = data.trackers;
      } else {
        // Merge update by id, preserving client's current order
        const incoming = new Map(data.trackers.map(t => [t.id, t]));
        trackers = trackers
          .filter(t => incoming.has(t.id))
          .map(t => ({ ...t, ...incoming.get(t.id) }));
        // Prepend any newly added trackers (server always unshifts new ones to front)
        const existingIds = new Set(trackers.map(t => t.id));
        data.trackers.forEach(t => { if (!existingIds.has(t.id)) trackers.unshift(t); });
      }
      renderTrackers();
      updateBadge();
      if (data.type === 'update') {
        trackers.forEach(t => {
          if (t.status === 'changed' && prevStatuses[t.id] !== 'changed') {
            showSnackbar(`🔔 Change detected: ${t.label}`);
            triggerBrowserNotification(t.label, t.url);
          }
        });
      }
    }
  };
  evtSource.onerror = () => {
    setTimeout(() => { if (currentUser) connectSSE(); }, 5000);
  };
}

// ─── EDIT ─────────────────────────────────────────────────────────────────────
function toggleEdit(id) {
  editingId = (editingId === id) ? null : id;
  renderTrackers();
}

async function saveEdit(id) {
  const t = trackers.find(t => t.id === id);
  if (!t) return;
  const newLabel    = document.getElementById(`edit-label-${id}`).value.trim();
  const newInterval = parseInt(document.getElementById(`edit-interval-${id}`).value);
  const newAi       = document.getElementById(`edit-ai-${id}`).checked;
  const body = {};
  if (newLabel && newLabel !== t.label) body.label = newLabel;
  if (newInterval && newInterval !== t.interval) body.interval = newInterval;
  body.aiSummary = newAi;
  try {
    const res = await fetch(`/api/trackers/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) { showSnackbar('Failed to save changes', 'error'); return; }
    editingId = null;
    showSnackbar('✓ Changes saved.');
  } catch {
    showSnackbar('Connection error', 'error');
  }
}

// ─── ADD TRACKER ─────────────────────────────────────────────────────────────
async function addTracker() {
  const url      = document.getElementById('urlInput').value.trim();
  const label    = document.getElementById('labelInput').value.trim();
  const interval  = parseInt(document.getElementById('intervalSelect').value);
  const aiSummary = document.getElementById('addAiSummary').checked;
  if (!url) { showSnackbar('Please enter a URL.', 'error'); return; }
  try { new URL(url); } catch { showSnackbar('Please enter a valid URL.', 'error'); return; }
  try {
    const res = await fetch('/api/trackers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, label, interval, aiSummary })
    });
    if (!res.ok) { const d = await res.json(); showSnackbar(d.error || 'Failed to add', 'error'); return; }
    document.getElementById('urlInput').value   = '';
    document.getElementById('labelInput').value = '';
    document.getElementById('addAiSummary').checked = false;
  } catch {
    showSnackbar('Connection error', 'error');
  }
}

// ─── REMOVE TRACKER ──────────────────────────────────────────────────────────
async function removeTracker(id) {
  const t = trackers.find(t => t.id === id);
  if (!t) return;
  const shouldDelete = await openDeleteConfirmDialog(`tracker "${t.label}"`, 'Delete tracker?'); 
  if (!shouldDelete) return;
  try {
    const res = await fetch(`/api/trackers/${id}`, { method: 'DELETE' });
    if (!res.ok) { showSnackbar('Failed to delete tracker', 'error'); }
  } catch {
    showSnackbar('Connection error', 'error');
  }
}

// ─── TOGGLE ACTIVE ────────────────────────────────────────────────────────────
async function toggleTracker(id) {
  const t = trackers.find(t => t.id === id);
  if (!t) return;
  // Optimistic update
  t.active = !t.active;
  renderTrackers();
  updateBadge();
  try {
    await fetch(`/api/trackers/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: t.active })
    });
  } catch {
    t.active = !t.active; // revert
    renderTrackers();
    updateBadge();
    showSnackbar('Connection error', 'error');
  }
}

// ─── CHECK ────────────────────────────────────────────────────────────────────
async function checkTracker(id) {
  const t = trackers.find(t => t.id === id);
  if (t) { t.status = 'checking'; renderTrackers(); }
  try {
    await fetch(`/api/trackers/${id}/check`, { method: 'POST' });
  } catch {
    showSnackbar('Connection error', 'error');
  }
}

async function checkAll() {
  const btn = document.getElementById('checkAllBtn');
  btn.disabled = true;
  btn.title = 'Checking…';
  btn.innerHTML = '<span class="material-icons" style="font-size:20px;animation:spin 0.7s linear infinite;display:inline-block">refresh</span>';
  try {
    await Promise.all(
      trackers.filter(t => t.active).map(t => fetch(`/api/trackers/${t.id}/check`, { method: 'POST' }))
    );
  } finally {
    btn.disabled = false;
    btn.title = 'Check all now';
    btn.innerHTML = '<span class="material-icons" style="font-size:20px">refresh</span>';
  }
}

// ─── BULK ACTIVE CONTROLS ─────────────────────────────────────────────────────
async function setAllActive(active) {
  const targets = trackers.filter(t => t.active !== active);
  if (!targets.length) return;
  targets.forEach(t => { t.active = active; });
  renderTrackers();
  updateBadge();
  try {
    await Promise.all(targets.map(t =>
      fetch(`/api/trackers/${t.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active })
      })
    ));
  } catch {
    showSnackbar('Connection error', 'error');
  }
}

async function invertAll() {
  if (!trackers.length) return;
  trackers.forEach(t => { t.active = !t.active; });
  renderTrackers();
  updateBadge();
  try {
    await Promise.all(trackers.map(t =>
      fetch(`/api/trackers/${t.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: t.active })
      })
    ));
  } catch {
    showSnackbar('Connection error', 'error');
  }
}

// ─── DISMISS ──────────────────────────────────────────────────────────────────
function toggleDiffPanel(id, btn) {
  const panel = document.getElementById(`diff-panel-${id}`);
  if (!panel) return;
  const isOpen = panel.classList.toggle('open');
  btn.textContent = isOpen ? 'Hide changes' : 'Show changes';
}

async function dismissChange(id) {
  try {
    await fetch(`/api/trackers/${id}/dismiss`, { method: 'POST' });
  } catch {
    showSnackbar('Connection error', 'error');
  }
}

// ─── RENDER ───────────────────────────────────────────────────────────────────
function renderTrackers() {
  const list = document.getElementById('trackerList');

  const filtered = trackers.filter(t => {
    if (showChangedOnly && t.status !== 'changed') return false;
    if (showActiveOnly  && !t.active)              return false;
    if (showAIOnly      && t.aiSummary === false)   return false;
    if (trackerFilter &&
        !(t.label || '').toLowerCase().includes(trackerFilter) &&
        !(t.url   || '').toLowerCase().includes(trackerFilter)) return false;
    return true;
  });

  // Update the filter count badge
  const countEl = document.getElementById('trackerFilterCount');
  if (countEl) {
    if (trackers.length === 0) {
      countEl.textContent = '';
    } else if (trackerFilter || showChangedOnly || showActiveOnly || showAIOnly) {
      countEl.textContent = `${filtered.length} of ${trackers.length} shown`;
    } else {
      countEl.textContent = `${trackers.length} tracker${trackers.length !== 1 ? 's' : ''}`;
    }
  }

  if (trackers.length === 0) {
    list.innerHTML = `
      <div class="card empty-state">
        <span class="material-icons">travel_explore</span>
        <h3>Nothing tracked yet</h3>
        <p>Add a URL above to start watching for changes.</p>
      </div>`;
    return;
  }

  if (filtered.length === 0) {
    list.innerHTML = `
      <div class="card empty-state">
        <span class="material-icons">search_off</span>
        <h3>No trackers match</h3>
        <p>Try a different search term or <button class="btn btn-text" style="padding:2px 6px;font-size:14px;vertical-align:baseline" onclick="document.getElementById('trackerSearch').value='';setTrackerFilter('')">clear the filter</button>.</p>
      </div>`;
    return;
  }

  // Remember which diff panels are open so we can restore them after re-render
  const openDiffPanels = new Set(
    [...list.querySelectorAll('.diff-panel.open')].map(el => el.id)
  );

  list.innerHTML = '';
  filtered.forEach(t => {
    const el = document.createElement('div');
    el.className = `tracker-item ${t.active ? '' : 'tracker-item-paused'}`.trim();
    el.dataset.id = t.id;
    el.draggable = false;
    el.innerHTML = trackerHTML(t);
    list.appendChild(el);
  });

  // Restore open diff panels
  openDiffPanels.forEach(panelId => {
    const panel = document.getElementById(panelId);
    if (panel) {
      panel.classList.add('open');
      const btn = panel.previousElementSibling?.querySelector('[onclick^="toggleDiffPanel"]');
      if (btn) btn.textContent = 'Hide changes';
    }
  });

  if (trackerFilter) {
    // Visually disable drag handles while a filter is active — reordering a
    // filtered subset would produce confusing results in the full list.
    list.querySelectorAll('.drag-handle').forEach(h => {
      h.style.opacity = '0.3';
      h.style.cursor  = 'default';
      h.title         = 'Clear the filter to reorder trackers';
    });
  } else {
    initDragAndDrop(list);
  }

  updateBadge();
}

// ─── TRACKER FILTER ───────────────────────────────────────────────────────────
function setTrackerFilter(val) {
  trackerFilter = val.trim().toLowerCase();
  renderTrackers();
}

function setShowChangedOnly(checked) {
  showChangedOnly = checked;
  renderTrackers();
}

function setShowActiveOnly(checked) {
  showActiveOnly = checked;
  renderTrackers();
}

function setShowAIOnly(checked) {
  showAIOnly = checked;
  renderTrackers();
}

// ─── DRAG AND DROP ───────────────────────────────────────────────────────────
let dragSrcId   = null;


function initDragAndDrop(list) {
  list.querySelectorAll('.tracker-item').forEach(item => {
    const handle = item.querySelector('.drag-handle');
    if (handle) {
      handle.addEventListener('mousedown', () => { item.draggable = true; });
    }
    item.addEventListener('dragstart', onDragStart);
    item.addEventListener('dragend',   onDragEnd);
    item.addEventListener('dragover',  onDragOver);
    item.addEventListener('dragleave', onDragLeave);
    item.addEventListener('drop',      onDrop);
  });
}

function onDragStart(e) {
  dragSrcId = this.dataset.id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragSrcId);
  setTimeout(() => this.classList.add('drag-dragging'), 0);
}

function onDragEnd() {
  this.draggable = false;
  this.classList.remove('drag-dragging');
  document.querySelectorAll('.tracker-item').forEach(el => el.classList.remove('drag-over'));
  dragSrcId = null;
}

function onDragOver(e) {
  if (!dragSrcId || this.dataset.id === dragSrcId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.tracker-item').forEach(el => el.classList.remove('drag-over'));
  this.classList.add('drag-over');
}

function onDragLeave() {
  this.classList.remove('drag-over');
}

async function onDrop(e) {
  e.preventDefault();
  if (!dragSrcId || this.dataset.id === dragSrcId) return;
  this.classList.remove('drag-over');

  const fromIdx = trackers.findIndex(t => t.id === dragSrcId);
  const toIdx   = trackers.findIndex(t => t.id === this.dataset.id);
  if (fromIdx === -1 || toIdx === -1) return;

  // Reorder in memory and re-render immediately (optimistic)
  const [moved] = trackers.splice(fromIdx, 1);
  trackers.splice(toIdx, 0, moved);
  renderTrackers();

  await persistOrder();
}

async function persistOrder() {
  try {
    await fetch('/api/trackers/reorder', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: trackers.map(t => t.id) })
    });
  } catch {
    showSnackbar('Could not save order', 'error');
  }
}

function trackerHTML(t) {
  const statusClass = !t.active             ? 'status-pending' :
                      t.status === 'checking' ? 'status-pending' :
                      t.status === 'changed'  ? 'status-changed' :
                      t.status === 'error'    ? 'status-error'   :
                      t.status === 'ok'       ? 'status-ok'      : 'status-pending';

  const chipClass = !t.active            ? 'chip-paused'  :
                    t.status === 'changed' ? 'chip-changed' :
                    t.status === 'error'   ? 'chip-error'   :
                    t.status === 'ok'      ? 'chip-ok'      : '';

  const chipLabel = !t.active             ? 'Paused' :
                    t.status === 'changed'  ? `${t.changeCount} change${t.changeCount !== 1 ? 's' : ''}` :
                    t.status === 'checking' ? 'Checking…' :
                    t.status === 'error'    ? 'Error' :
                    t.status === 'ok'       ? 'No changes' : 'Pending';

  const lastCheck    = t.lastCheck ? 'Last: ' + new Date(t.lastCheck).toLocaleTimeString() : 'Never checked';
  const timeAgoStr   = t.lastCheck ? timeAgo(t.lastCheck) : '';
  const intervalLabel = intervalText(t.interval);

  let changeBanner = '';
  if ((t.status === 'changed' || t.status === 'error') && t.changeSummary) {
    const hasSnippet = t.status === 'changed' && t.changeSnippet;
    changeBanner = `
      <div class="tracker-change-banner">
        <span class="material-icons">${t.status === 'error' ? 'error_outline' : 'info_outline'}</span>
        <span class="diff-summary">${escHtml(t.changeSummary)}</span>
        ${hasSnippet ? `<button class="btn btn-text" style="padding:4px 10px;font-size:12px;white-space:nowrap" onclick="toggleDiffPanel('${t.id}',this)">Show changes</button>` : ''}
        ${t.status === 'changed' ? `<button class="btn btn-text" style="padding:4px 10px;font-size:12px" onclick="dismissChange('${t.id}')">Dismiss</button>` : ''}
      </div>
      ${hasSnippet ? `
      <div class="diff-panel" id="diff-panel-${t.id}">
        <div class="diff-panel-inner">
          <div class="diff-block diff-removed">
            <div class="diff-block-label">Before</div>${escHtml(t.changeSnippet.removed)}
          </div>
          <div class="diff-block diff-added">
            <div class="diff-block-label">After</div>${escHtml(t.changeSnippet.added)}
          </div>
        </div>
      </div>` : ''}`;
  }

  return `
    <div class="tracker-main">
      <span class="drag-handle material-icons" title="Drag to reorder">drag_indicator</span>
      <span class="tracker-status ${statusClass}"></span>
      <div class="tracker-info">
        <div class="tracker-name">${escHtml(t.label)}</div>
        <div class="tracker-url">${escHtml(t.url)}</div>
      </div>
      <span class="chip ${chipClass}" style="margin-right:8px">${chipLabel}</span>
      <div class="tracker-meta">
        <div class="tracker-interval"><span class="material-icons">schedule</span>${intervalLabel}</div>
        <div class="tracker-last-check">${lastCheck}</div>
        ${timeAgoStr ? `<div class="tracker-time-ago" data-ts="${t.lastCheck}">${timeAgoStr}</div>` : ''}
        <div title="${t.aiSummary !== false ? 'AI summary enabled' : 'AI summary disabled'}" style="display:flex;align-items:center;gap:3px;font-size:11px;${t.aiSummary !== false ? 'color:var(--primary);opacity:0.75' : 'color:var(--on-surface-medium);opacity:0.45'}">
          <span class="material-icons" style="font-size:13px">${t.aiSummary !== false ? 'auto_awesome' : 'auto_awesome'}</span>AI
        </div>
      </div>
      <div class="tracker-actions">
        <label class="toggle" title="${t.active ? 'Pause' : 'Resume'} tracker">
          <input type="checkbox" ${t.active ? 'checked' : ''} onchange="toggleTracker('${t.id}')">
          <span class="toggle-slider"></span>
        </label>
        <a class="btn-icon material-icons" href="${escHtml(t.url)}" target="_blank" rel="noopener noreferrer" title="Open URL in new tab" style="text-decoration:none">open_in_new</a>
        <button class="btn-icon material-icons" onclick="toggleEdit('${t.id}')" title="Edit">edit</button>
        <button class="btn-icon material-icons" onclick="checkTracker('${t.id}')" title="Check now" ${t.status === 'checking' ? 'disabled' : ''}>refresh</button>
        <button class="btn-icon material-icons" style="color:var(--error)" onclick="removeTracker('${t.id}')" title="Remove">delete_outline</button>
      </div>
    </div>
    ${editingId === t.id ? `
    <div class="tracker-edit-panel">
      <div class="tracker-edit-row">
        <div class="field">
          <label>Label</label>
          <input type="text" id="edit-label-${t.id}" value="${escHtml(t.label)}" placeholder="Label" />
        </div>
        <div class="field">
          <label>Check every</label>
          <select id="edit-interval-${t.id}">
            <option value="10000"   ${t.interval===10000   ?'selected':''}>10 seconds</option>
            <option value="30000"   ${t.interval===30000   ?'selected':''}>30 seconds</option>
            <option value="60000"   ${t.interval===60000   ?'selected':''}>1 minute</option>
            <option value="300000"  ${t.interval===300000  ?'selected':''}>5 minutes</option>
            <option value="600000"  ${t.interval===600000  ?'selected':''}>10 minutes</option>
            <option value="1800000" ${t.interval===1800000 ?'selected':''}>30 minutes</option>
            <option value="3600000" ${t.interval===3600000 ?'selected':''}>1 hour</option>
            <option value="14400000"${t.interval===14400000?'selected':''}>4 hours</option>
            <option value="21600000"${t.interval===21600000?'selected':''}>6 hours</option>
            <option value="43200000"${t.interval===43200000?'selected':''}>12 hours</option>
            <option value="86400000" ${t.interval===86400000 ?'selected':''}>24 hours</option>
            <option value="259200000"${t.interval===259200000?'selected':''}>3 days</option>
            <option value="604800000"${t.interval===604800000?'selected':''}>7 days</option>
          </select>
        </div>
        <label class="ai-checkbox-row" title="When disabled, changes are still detected but no AI summary is generated">
          <input type="checkbox" id="edit-ai-${t.id}" ${t.aiSummary !== false ? 'checked' : ''} />
          AI summary
        </label>
      </div>
      <button class="btn btn-primary" style="height:36px;padding:0 16px;font-size:13px" onclick="saveEdit('${t.id}')">Save</button>
      <button class="btn btn-text"    style="height:36px;padding:0 12px;font-size:13px" onclick="toggleEdit(null)">Cancel</button>
    </div>` : ''}
    ${changeBanner}`;
}

function updateBadge() {
  const active = trackers.filter(t => t.active).length;
  document.getElementById('activeCount').textContent = `${active} active`;
}

// ─── NOTIFICATIONS ────────────────────────────────────────────────────────────
async function showBrowserNotification(title, body, url) {
  if ('serviceWorker' in navigator && Notification.permission === 'granted') {
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, { body, data: { url } });
      return;
    } catch {}
  }
  try { new Notification(title, { body, icon: '/icon.svg' }); } catch {}
}

function triggerBrowserNotification(label, url) {
  if (!currentUser?.notificationsEnabled) return;
  if (Notification.permission === 'granted') {
    showBrowserNotification('Watchbot: Change detected', `${label}\n${url}`, url);
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission();
  }
}

// ─── AI RESOURCE FINDER ───────────────────────────────────────────────────────
let aiSuggestions        = [];
let _trackerOptResolver  = null;
let _trackerOptEscHandler = null;

const AI_CATEGORY_CLASS = {
  'News':     'ai-cat-news',
  'Official': 'ai-cat-official',
  'Social':   'ai-cat-social',
  'Data/API': 'ai-cat-data',
  'Blog':     'ai-cat-blog',
  'Forum':    'ai-cat-forum',
  'Video':    'ai-cat-video',
  'Other':    'ai-cat-other',
};

async function searchAIResources() {
  const query = document.getElementById('aiSearchInput').value.trim();
  if (!query) { showSnackbar('Enter a topic to search for.', 'error'); return; }

  const btn   = document.getElementById('aiSearchBtn');
  const panel = document.getElementById('aiResultsPanel');
  const list  = document.getElementById('aiSuggestionsList');

  btn.disabled = true;
  btn.innerHTML = '<span class="material-icons" style="font-size:18px;animation:spin 0.7s linear infinite;display:inline-block">refresh</span> Searching…';

  panel.style.display = '';
  document.getElementById('aiResultsTitle').textContent = '';
  document.getElementById('aiAddSelectedBtn').disabled = true;
  document.getElementById('aiAddSelectedLabel').textContent = 'Add Selected';
  list.innerHTML = '<div class="ai-finder-loading"><span class="material-icons spin-icon">refresh</span> AI is discovering resources for "<strong>' + escHtml(query) + '</strong>"…</div>';

  try {
    const res  = await fetch('/api/ai/find-resources', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query })
    });
    const data = await res.json();
    if (!res.ok) {
      showSnackbar(data.error || 'Search failed', 'error');
      panel.style.display = 'none';
      return;
    }
    aiSuggestions = (data.suggestions || []).map(s => ({ ...s, selected: false }));
    _renderAISuggestions(query);
  } catch {
    showSnackbar('Connection error', 'error');
    panel.style.display = 'none';
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="material-icons" style="font-size:18px">auto_awesome</span> Find Resources';
  }
}

function _renderAISuggestions(query) {
  const list  = document.getElementById('aiSuggestionsList');
  const title = document.getElementById('aiResultsTitle');

  if (!aiSuggestions.length) {
    title.textContent = 'No results found';
    list.innerHTML = '<div class="ai-finder-empty">No suggestions found for this topic. Try a different search term.</div>';
    return;
  }

  title.textContent = `${aiSuggestions.length} suggestion${aiSuggestions.length !== 1 ? 's' : ''} for "${escHtml(query)}"`;

  list.innerHTML = aiSuggestions.map((s, i) => {
    const catClass = AI_CATEGORY_CLASS[s.category] || 'ai-cat-other';
    return `
    <div class="ai-suggestion-item${s.selected ? ' selected' : ''}" data-ai-idx="${i}" onclick="_aiToggle(${i})">
      <input type="checkbox" class="ai-suggestion-checkbox" ${s.selected ? 'checked' : ''}
        onclick="event.stopPropagation();_aiToggle(${i})" />
      <div class="ai-suggestion-body">
        <div class="ai-suggestion-label">${escHtml(s.label)}</div>
        <a class="ai-suggestion-url" href="${escHtml(s.url)}" target="_blank" rel="noopener noreferrer"
          onclick="event.stopPropagation()">${escHtml(s.url)}</a>
        <div class="ai-suggestion-desc">${escHtml(s.description)}</div>
      </div>
      <span class="ai-category-badge ${catClass}">${escHtml(s.category)}</span>
    </div>`;
  }).join('');

  _updateAIAddBtn();
}

function _aiToggle(index) {
  if (index < 0 || index >= aiSuggestions.length) return;
  aiSuggestions[index].selected = !aiSuggestions[index].selected;
  const item = document.querySelector(`.ai-suggestion-item[data-ai-idx="${index}"]`);
  if (item) {
    item.classList.toggle('selected', aiSuggestions[index].selected);
    const cb = item.querySelector('.ai-suggestion-checkbox');
    if (cb) cb.checked = aiSuggestions[index].selected;
  }
  _updateAIAddBtn();
}

function aiSelectAll(selected) {
  aiSuggestions.forEach(s => s.selected = selected);
  document.querySelectorAll('.ai-suggestion-item').forEach(item => {
    item.classList.toggle('selected', selected);
    const cb = item.querySelector('.ai-suggestion-checkbox');
    if (cb) cb.checked = selected;
  });
  _updateAIAddBtn();
}

function _updateAIAddBtn() {
  const count = aiSuggestions.filter(s => s.selected).length;
  const btn   = document.getElementById('aiAddSelectedBtn');
  const label = document.getElementById('aiAddSelectedLabel');
  if (btn)   btn.disabled = count === 0;
  if (label) label.textContent = count > 0 ? `Add ${count} Selected` : 'Add Selected';
}

function openAddSelectedModal() {
  const selected = aiSuggestions.filter(s => s.selected);
  if (!selected.length) return;

  const modal        = document.getElementById('trackerOptionsModal');
  const msgEl        = document.getElementById('toModalMessage');
  const confirmLabel = document.getElementById('toConfirmLabel');
  if (!modal) return;

  msgEl.textContent        = `Configure options for ${selected.length} resource${selected.length !== 1 ? 's' : ''}.`;
  confirmLabel.textContent = `Add ${selected.length} Tracker${selected.length !== 1 ? 's' : ''}`;

  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');

  modal.onclick = (e) => { if (e.target === modal) closeTrackerOptionsModal(false); };
  _trackerOptEscHandler = (e) => { if (e.key === 'Escape') closeTrackerOptionsModal(false); };
  document.addEventListener('keydown', _trackerOptEscHandler);

  return new Promise(resolve => {
    _trackerOptResolver = resolve;
    setTimeout(() => document.getElementById('toIntervalSelect')?.focus(), 80);
  }).then(async (confirmed) => {
    if (confirmed) await _addSelectedTrackers(selected);
  });
}

function closeTrackerOptionsModal(confirmed) {
  const modal = document.getElementById('trackerOptionsModal');
  if (modal) {
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    modal.onclick = null;
  }
  document.body.classList.remove('modal-open');
  if (_trackerOptEscHandler) {
    document.removeEventListener('keydown', _trackerOptEscHandler);
    _trackerOptEscHandler = null;
  }
  if (_trackerOptResolver) {
    const resolve    = _trackerOptResolver;
    _trackerOptResolver = null;
    resolve(confirmed);
  }
}

async function _addSelectedTrackers(selected) {
  const interval  = parseInt(document.getElementById('toIntervalSelect').value) || 30000;
  const aiSummary = document.getElementById('toAiSummary').checked;

  let added = 0, failed = 0;

  for (const s of selected) {
    try {
      const res = await fetch('/api/trackers', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ url: s.url, label: s.label, interval, aiSummary })
      });
      if (res.ok) {
        added++;
        const idx = aiSuggestions.findIndex(x => x === s);
        if (idx >= 0) aiSuggestions[idx].selected = false;
      } else {
        const d = await res.json().catch(() => ({}));
        if (d.error) showSnackbar(d.error, 'error');
        failed++;
      }
    } catch { failed++; }
  }

  const query = document.getElementById('aiSearchInput').value.trim();
  _renderAISuggestions(query);

  if (added > 0 && failed === 0)
    showSnackbar(`Added ${added} tracker${added !== 1 ? 's' : ''} successfully!`);
  else if (added > 0)
    showSnackbar(`Added ${added} tracker${added !== 1 ? 's' : ''}; ${failed} failed.`, 'error');
  else
    showSnackbar(`Failed to add tracker${failed !== 1 ? 's' : ''}.`, 'error');
}

let snackTimer;
function showSnackbar(msg, type) {
  const bar  = document.getElementById('snackbar');
  const icon = bar.querySelector('.material-icons');
  icon.textContent = type === 'error' ? 'error_outline' : 'notifications';
  document.getElementById('snackbarText').textContent = msg;
  bar.classList.add('show');
  clearTimeout(snackTimer);
  snackTimer = setTimeout(hideSnackbar, 5000);
}
function hideSnackbar() {
  document.getElementById('snackbar').classList.remove('show');
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function intervalText(ms) {
  if (ms < 60000)    return `${ms/1000}s`;
  if (ms < 3600000)  return `${ms/60000}m`;
  if (ms < 86400000) return `${ms/3600000}h`;
  return `${ms/86400000}d`;
}

function timeAgo(isoString) {
  const secs = Math.floor((Date.now() - new Date(isoString)) / 1000);
  if (secs < 5)    return 'just now';
  if (secs < 60)   return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60)   return `${mins} min${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)    return `${hrs} hr${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// Refresh all relative timestamps every 30 seconds
setInterval(() => {
  document.querySelectorAll('.tracker-time-ago[data-ts]').forEach(el => {
    el.textContent = timeAgo(el.dataset.ts);
  });
}, 30000);

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── CONFIRM MODAL ────────────────────────────────────────────────────────────
function openDeleteConfirmDialog(label, title) {
  const modal     = document.getElementById('confirmModal');
  const message   = document.getElementById('confirmMessage');
  const titleEl   = document.getElementById('confirmTitle');
  const cancelBtn = document.getElementById('confirmCancelBtn');
  const deleteBtn = document.getElementById('confirmDeleteBtn');
  if (!modal || !message || !cancelBtn || !deleteBtn) return Promise.resolve(false);
  if (confirmResolver) closeConfirmDialog(false);
  if (titleEl) titleEl.textContent = title || 'Delete?';
  message.textContent = `Delete ${label}? This cannot be undone.`;
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  return new Promise(resolve => {
    confirmResolver = resolve;
    cancelBtn.onclick = () => closeConfirmDialog(false);
    deleteBtn.onclick = () => closeConfirmDialog(true);
    modal.onclick = (e) => { if (e.target === modal) closeConfirmDialog(false); };
    confirmKeyHandler = (e) => { if (e.key === 'Escape') closeConfirmDialog(false); };
    document.addEventListener('keydown', confirmKeyHandler);
    setTimeout(() => cancelBtn.focus(), 0);
  });
}

function closeConfirmDialog(confirmed) {
  const modal = document.getElementById('confirmModal');
  if (modal) {
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    modal.onclick = null;
  }
  document.body.classList.remove('modal-open');
  if (confirmKeyHandler) {
    document.removeEventListener('keydown', confirmKeyHandler);
    confirmKeyHandler = null;
  }
  if (confirmResolver) {
    const resolve = confirmResolver;
    confirmResolver = null;
    resolve(confirmed);
  }
}

// ─── GLOBAL ESCAPE KEY ────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.getElementById('trackerOptionsModal')?.classList.contains('show')) {
    closeTrackerOptionsModal(false); return;
  }
  if (document.getElementById('editUserOverlay')?.classList.contains('show')) {
    closeEditUser(); return;
  }
  if (document.getElementById('adminOverlay')?.classList.contains('show')) {
    closeAdminPanel(); return;
  }
  if (document.getElementById('profileOverlay')?.classList.contains('show')) {
    closeProfile(); return;
  }
});

// ─── BOOT ─────────────────────────────────────────────────────────────────────
init();
