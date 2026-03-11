// ─── STATE ────────────────────────────────────────────────────────────────────
let trackers    = [];
let editingId   = null;
let currentUser = null;
let evtSource   = null;
let confirmResolver   = null;
let confirmKeyHandler = null;

// ─── TOOLTIP ENGINE ──────────────────────────────────────────────────────────
// Single floating element driven by event delegation — works for all elements
// including those added dynamically after page load. Elements should use
// data-tip="…" instead of title="…" to get the styled tooltip.
(function () {
  const el = document.createElement('div');
  el.id = 'wbTooltip';
  document.body.appendChild(el);

  let showTimer, hideTimer;
  const OFFSET = 10; // px gap between cursor and tooltip box

  function show(text, x, y) {
    clearTimeout(hideTimer);
    el.textContent = text;
    // Temporarily make visible off-screen to measure size
    el.style.left = '-9999px'; el.style.top = '-9999px';
    el.classList.add('visible');
    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    // Position: default below-right, flip if it would clip viewport edge
    let lx = x + OFFSET;
    let ly = y + OFFSET;
    if (lx + tw > window.innerWidth  - 8) lx = x - tw - OFFSET;
    if (ly + th > window.innerHeight - 8) ly = y - th - OFFSET;
    el.style.left = lx + 'px';
    el.style.top  = ly + 'px';
  }

  function hide() {
    clearTimeout(showTimer);
    el.classList.remove('visible');
  }

  // Find closest ancestor (or self) with data-tip
  function tipTarget(node) {
    while (node && node !== document.body) {
      if (node.dataset?.tip) return node;
      node = node.parentElement;
    }
    return null;
  }

  document.addEventListener('mouseover', e => {
    const target = tipTarget(e.target);
    if (!target) return;
    clearTimeout(hideTimer);
    showTimer = setTimeout(() => show(target.dataset.tip, e.clientX, e.clientY), 350);
  });

  document.addEventListener('mousemove', e => {
    if (!el.classList.contains('visible')) return;
    const tw = el.offsetWidth, th = el.offsetHeight;
    let lx = e.clientX + OFFSET;
    let ly = e.clientY + OFFSET;
    if (lx + tw > window.innerWidth  - 8) lx = e.clientX - tw - OFFSET;
    if (ly + th > window.innerHeight - 8) ly = e.clientY - th - OFFSET;
    el.style.left = lx + 'px';
    el.style.top  = ly + 'px';
  });

  document.addEventListener('mouseout', e => {
    const target = tipTarget(e.target);
    if (!target) return;
    clearTimeout(showTimer);
    hideTimer = setTimeout(hide, 80);
  });

  // Hide on scroll or any click
  document.addEventListener('scroll', hide, true);
  document.addEventListener('mousedown', hide);
})();

// Tracker filter (client-side)
let trackerFilter    = '';
let showChangedOnly  = false;
let showActiveOnly   = false;
let showAIOnly       = false;
let showFlaggedOnly  = false;
let _tcFlagFilter    = new Set();   // per-tracker "show flagged only" filter

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
  // Load public site settings (drives registration visibility, maintenance mode)
  try {
    const sr = await fetch('/api/settings');
    if (sr.ok) siteSettings = await sr.json();
  } catch {}

  // Check session
  let meRes;
  try { meRes = await fetch('/api/auth/me'); } catch {}

  if (meRes?.ok) {
    currentUser = await meRes.json();
    if (siteSettings.maintenanceMode && currentUser.role !== 'admin') {
      // Logged-in non-admin hit maintenance — log them out silently then show overlay
      await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
      currentUser = null;
      showMaintenanceOverlay();
    } else {
      showApp();
    }
  } else if (meRes?.status === 503) {
    // Server is in maintenance mode and rejected the session
    showMaintenanceOverlay();
  } else {
    // Not logged in — but still check if site is in maintenance before showing login
    if (siteSettings.maintenanceMode) {
      showMaintenanceOverlay();
    } else {
      showAuthOverlay('login');
    }
  }
}

let _maintPollTimer = null;

function showMaintenanceOverlay() {
  // Close any SSE connection first
  if (evtSource) { evtSource.close(); evtSource = null; }
  // Hide auth overlay / app just in case
  hideAuthOverlay();
  document.getElementById('userArea').style.display = 'none';

  const overlay = document.getElementById('maintenanceOverlay');
  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open', 'maintenance-active');

  // Poll every 20 seconds — auto-dismiss when maintenance ends
  clearInterval(_maintPollTimer);
  let pollCount = 0;
  _maintPollTimer = setInterval(async () => {
    pollCount++;
    const el = document.getElementById('maintChecking');
    try {
      const sr = await fetch('/api/settings');
      if (!sr.ok) return;
      const s = await sr.json();
      if (!s.maintenanceMode) {
        hideMaintenanceOverlay();
        siteSettings = s;
        showAuthOverlay('login');
      } else if (el) {
        el.textContent = `Checking for updates… (${pollCount})`;
      }
    } catch {}
  }, 20000);
}

function hideMaintenanceOverlay() {
  clearInterval(_maintPollTimer);
  _maintPollTimer = null;
  const overlay = document.getElementById('maintenanceOverlay');
  overlay.classList.remove('show');
  overlay.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open', 'maintenance-active');
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
  // If registration is disabled, force to login and hide the tab button
  const regTabBtn = document.querySelector('.auth-tab[data-tab="register"]');
  if (regTabBtn) regTabBtn.style.display = siteSettings.allowRegistration ? '' : 'none';
  if (!siteSettings.allowRegistration && tab === 'register') tab = 'login';
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
    adminBtn.style.display = currentUser.role === 'admin' ? 'flex' : 'none';
  }
  if (currentUser.notificationsEnabled && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  // Apply panel visibility prefs from the user object (populated by /api/auth/me)
  applyPanelPrefs(currentUser);
  // Restore cached AI finder results if any
  _aiCacheRestore();
  // Sync filter state with whatever the browser restored on reload
  showChangedOnly = document.getElementById('showChangedOnlyChk')?.checked ?? false;
  showActiveOnly  = document.getElementById('showActiveOnlyChk')?.checked  ?? false;
  showAIOnly      = document.getElementById('showAIOnlyChk')?.checked      ?? false;
  showFlaggedOnly = document.getElementById('showFlaggedOnlyChk')?.checked ?? false;
  trackerFilter   = (document.getElementById('trackerSearch')?.value ?? '').trim().toLowerCase();
  connectSSE();
}

function applyPanelPrefs(prefs) {
  const aiCard  = document.getElementById('aiFinderCard');
  const addCard = document.getElementById('addTrackerCard');
  if (aiCard)  aiCard.style.display  = prefs?.hideAiFinder   ? 'none' : '';
  if (addCard) addCard.style.display = prefs?.hideAddTracker ? 'none' : '';
  const maxH = prefs?.changesMaxHeight > 0 ? `${prefs.changesMaxHeight}px` : '';
  document.documentElement.style.setProperty('--changes-max-height', maxH || 'none');
  // Restore collapsed state from localStorage — suppress animation during initial restore
  const _CARD_COLLAPSE_KEY = 'watchdog_card_collapsed';
  let collapsed = [];
  try { collapsed = JSON.parse(localStorage.getItem(_CARD_COLLAPSE_KEY)) || []; } catch {}
  ['aiFinderCard', 'addTrackerCard'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    // Add no-transition sentinel so CSS transition doesn't fire on page load
    el.classList.add('no-transition');
    el.classList.toggle('card-collapsed', collapsed.includes(id));
    // Remove sentinel after layout has settled
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('no-transition')));
  });
}

function toggleCardCollapse(cardId) {
  const card = document.getElementById(cardId);
  if (!card) return;
  card.classList.toggle('card-collapsed');
  // Persist
  const _CARD_COLLAPSE_KEY = 'watchdog_card_collapsed';
  const collapsed = ['aiFinderCard', 'addTrackerCard'].filter(id => {
    const el = document.getElementById(id);
    return el?.classList.contains('card-collapsed');
  });
  try { localStorage.setItem(_CARD_COLLAPSE_KEY, JSON.stringify(collapsed)); } catch {}
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
  _adminCache            = { users: null, trackers: null, userMap: null, settings: null };
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
  document.getElementById('adminSettingsTab').style.display = tab === 'settings' ? '' : 'none';
  // Reset to page 0 each time a tab is (re-)selected
  if (tab === 'users') adminUsersPage = 0;
  else if (tab === 'trackers') adminTrackersPage = 0;
  loadAdminTab(tab);
}

async function loadAdminTab(tab, forceRefresh = true) {
  if (tab === 'settings') {
    if (forceRefresh || !_adminCache.settings) {
      const res = await fetch('/api/admin/settings');
      if (!res.ok) return;
      _adminCache.settings = await res.json();
    }
    renderAdminSettingsTab(_adminCache.settings);
    return;
  }
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

function renderAdminSettingsTab(s) {
  const el = document.getElementById('adminSettingsTab');
  if (!el) return;
  el.innerHTML = `
    <div style="max-width:560px">
      <h4 style="font-size:13px;font-weight:700;color:var(--on-surface-medium);text-transform:uppercase;letter-spacing:0.6px;margin:0 0 18px">Site Settings</h4>

      <div style="display:flex;flex-direction:column;gap:18px">

        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding-bottom:16px;border-bottom:1px solid var(--divider)">
          <div>
            <div style="font-size:14px;font-weight:600">User registration</div>
            <div style="font-size:12px;color:var(--on-surface-medium);margin-top:3px">Allow new users to create accounts from the login screen.</div>
          </div>
          <label class="toggle" style="flex-shrink:0;margin-top:2px" data-tip="${s.allowRegistration ? 'Disable registration' : 'Enable registration'}">
            <input type="checkbox" ${s.allowRegistration ? 'checked' : ''} onchange="saveAdminSetting('allowRegistration', this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding-bottom:16px;border-bottom:1px solid var(--divider)">
          <div>
            <div style="font-size:14px;font-weight:600">AI summaries</div>
            <div style="font-size:12px;color:var(--on-surface-medium);margin-top:3px">Master switch for all Anthropic AI API calls. Disabling saves API costs site-wide.</div>
          </div>
          <label class="toggle" style="flex-shrink:0;margin-top:2px" data-tip="${s.aiEnabled ? 'Disable AI' : 'Enable AI'}">
            <input type="checkbox" ${s.aiEnabled ? 'checked' : ''} onchange="saveAdminSetting('aiEnabled', this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding-bottom:16px;border-bottom:1px solid var(--divider)">
          <div>
            <div style="font-size:14px;font-weight:600">Maintenance mode</div>
            <div style="font-size:12px;color:var(--on-surface-medium);margin-top:3px">Blocks all non-admin users from the app. Admins are unaffected.</div>
          </div>
          <label class="toggle" style="flex-shrink:0;margin-top:2px" data-tip="${s.maintenanceMode ? 'Disable maintenance mode' : 'Enable maintenance mode'}">
            <input type="checkbox" ${s.maintenanceMode ? 'checked' : ''} onchange="saveAdminSetting('maintenanceMode', this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding-bottom:16px;border-bottom:1px solid var(--divider)">
          <div style="flex:1">
            <div style="font-size:14px;font-weight:600">Default WatchBot limit</div>
            <div style="font-size:12px;color:var(--on-surface-medium);margin-top:3px">Max WatchBots per user when no per-user override is set. <strong>0</strong> = unlimited.</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
            <input type="number" id="adminDefaultTrackerLimit" min="0" step="1" value="${s.defaultTrackerLimit}"
              style="width:70px;padding:6px 8px;border:1px solid var(--divider);border-radius:8px;font-size:13px;background:var(--surface);color:var(--on-surface);text-align:right"
              onchange="saveAdminSetting('defaultTrackerLimit', parseInt(this.value) || 0)" />
          </div>
        </div>

        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px">
          <div style="flex:1">
            <div style="font-size:14px;font-weight:600">Change history retention cap</div>
            <div style="font-size:12px;color:var(--on-surface-medium);margin-top:3px">Max unflagged change entries kept across all trackers. Oldest entries are pruned automatically. Flagged changes are never pruned. Minimum <strong>10</strong>.</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
            <input type="number" id="adminHistoryRetentionCap" min="10" step="10" value="${s.historyRetentionCap}"
              style="width:70px;padding:6px 8px;border:1px solid var(--divider);border-radius:8px;font-size:13px;background:var(--surface);color:var(--on-surface);text-align:right"
              onchange="saveAdminSetting('historyRetentionCap', Math.max(10, parseInt(this.value) || 500))" />
          </div>
        </div>

      </div>
    </div>
  `;
}

async function saveAdminSetting(key, value) {
  try {
    const res = await fetch('/api/admin/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value })
    });
    if (!res.ok) throw new Error();
    if (_adminCache.settings) _adminCache.settings[key] = value;
    // Keep public siteSettings in sync for registration/maintenance
    if (key === 'allowRegistration') siteSettings.allowRegistration = value;
    if (key === 'maintenanceMode')   siteSettings.maintenanceMode   = value;
    showSnackbar('Setting saved');
  } catch {
    showSnackbar('Failed to save setting', 'error');
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
        <td><span class="admin-role-badge admin-role-${u.role === 'admin' ? 'admin' : 'user'}">${u.role === 'admin' ? 'Admin' : 'User'}</span></td>
        <td>${u.trackerCount}</td>
        <td>${u.id === currentUser.id ? '—' : `<input type="number" min="0" value="${u.trackerLimit ?? ''}" placeholder="∞"
          style="width:56px;padding:3px 6px;border:1px solid var(--divider);border-radius:6px;font-size:12px;background:var(--surface)"
          onchange="adminSetTrackerLimit('${u.id}', this.value)" title="Max WatchBots (0 or blank = unlimited)" />`}</td>
        <td>${u.id === currentUser.id ? '' : `<label class="toggle-switch" data-tip="${u.disabled ? 'Enable' : 'Disable'} account">
          <input type="checkbox" ${u.disabled ? '' : 'checked'} onchange="adminToggleDisabled('${u.id}', !this.checked)">
          <span class="toggle-track"></span>
        </label>`}</td>
        <td style="color:var(--on-surface-medium);font-size:12px">${new Date(u.createdAt).toLocaleDateString()}</td>
        <td>${u.id === currentUser.id ? '' : `
          <div class="btn-group">
            <button class="btn-icon" style="color:var(--on-surface-medium)" data-tip="Edit user" onclick="openEditUser('${u.id}','${escHtml(u.username)}','${escHtml(u.email||'')}','${u.role}')">
              <span class="material-icons" style="font-size:18px">edit</span>
            </button>
            <button class="btn-icon" style="color:var(--primary)" data-tip="Impersonate user" onclick="adminImpersonate('${u.id}','${escHtml(u.username)}')">
              <span class="material-icons" style="font-size:18px">theater_comedy</span>
            </button>
            <button class="btn-icon" style="color:var(--error)" data-tip="Delete user" onclick="adminDeleteUser('${u.id}','${escHtml(u.username)}')">
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
    `${count} user${count !== 1 ? 's' : ''} and all their WatchBots`,
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
    tbody.innerHTML = `<tr><td colspan="9" class="admin-empty">${q ? 'No WatchBots match your search.' : 'No WatchBots found.'}</td></tr>`;
  } else {
    tbody.innerHTML = page.map(t => `
      <tr>
        <td><input type="checkbox" data-sel="${t.id}" ${adminTrackersSelected.has(t.id) ? 'checked' : ''} onchange="adminTrackerSelectToggle('${t.id}', this.checked)" style="cursor:pointer;accent-color:var(--primary)"></td>
        <td>${escHtml(t.label || t.url)}</td>
        <td><span class="admin-url" data-tip="${escHtml(t.url)}">${escHtml(t.url)}</span></td>
        <td style="font-size:12px;color:var(--on-surface-medium)">${escHtml(userMap[t.userId] || t.userId)}</td>
        <td style="font-size:12px;color:var(--on-surface-medium);white-space:nowrap">${intervalText(t.interval)}</td>
        <td><span class="chip chip-${t.status === 'changed' ? 'changed' : t.status === 'error' ? 'error' : t.active ? 'ok' : 'paused'}" style="font-size:11px">${t.active ? t.status : 'paused'}</span></td>
        <td style="text-align:center">${t.changeCount || 0}</td>
        <td><label class="toggle-switch" data-tip="${t.active ? 'Disable' : 'Enable'} WatchBot">
          <input type="checkbox" ${t.active ? 'checked' : ''} onchange="adminToggleTracker('${t.id}', this.checked)">
          <span class="toggle-track"></span>
        </label></td>
        <td><button class="btn-icon" style="color:var(--error)" data-tip="Delete WatchBot" onclick="adminDeleteTracker('${t.id}','${escHtml(t.label || t.url)}')"><span class="material-icons" style="font-size:18px">delete_outline</span></button></td>
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
  if (countEl)    countEl.textContent        = count > 0 ? `${count} WatchBot${count !== 1 ? 's' : ''} selected` : '';
  if (enableBtn)  enableBtn.disabled         = count === 0;
  if (disableBtn) disableBtn.disabled        = count === 0;
  if (deleteBtn)  deleteBtn.disabled         = count === 0;
  if (clearBtn)   clearBtn.style.visibility  = count > 0 ? 'visible' : 'hidden';
}

async function adminBulkDeleteTrackers() {
  const count = adminTrackersSelected.size;
  if (count === 0) return;
  const ok = await openDeleteConfirmDialog(`${count} WatchBot${count !== 1 ? 's' : ''}`, `Delete ${count} WatchBot${count !== 1 ? 's' : ''}?`);
  if (!ok) return;
  const ids = [...adminTrackersSelected];
  adminTrackersSelected.clear();
  let failed = 0;
  await Promise.all(ids.map(async id => {
    const res = await fetch(`/api/admin/trackers/${id}`, { method: 'DELETE' });
    if (!res.ok) failed++;
  }));
  if (failed > 0) showSnackbar(`${failed} deletion${failed !== 1 ? 's' : ''} failed.`, 'error');
  else showSnackbar(`${ids.length} WatchBot${ids.length !== 1 ? 's' : ''} deleted.`);
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
  else showSnackbar(`${ids.length} WatchBot${ids.length !== 1 ? 's' : ''} ${active ? 'enabled' : 'disabled'}.`);
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

function openEditUser(id, username, email, role) {
  editUserId = id;
  const cached = _adminCache.users?.find(u => u.id === id);
  document.getElementById('editUserSubtitle').textContent = username;
  document.getElementById('editUserEmail').value = email;
  document.getElementById('editUserRole').value = role;
  document.getElementById('editUserLimit').value = cached?.trackerLimit ?? '';
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
  if (res.ok) {
    // Keep cache in sync so the edit modal reads the current value
    if (_adminCache.users) {
      const u = _adminCache.users.find(u => u.id === id);
      if (u) u.trackerLimit = limit;
    }
    showSnackbar('WatchBot limit updated.');
  } else { const d = await res.json(); showSnackbar(d.error || 'Update failed', 'error'); }
}

async function adminToggleTracker(id, active) {
  const res = await fetch(`/api/admin/trackers/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active }),
  });
  if (res.ok) {
    showSnackbar(active ? 'WatchBot enabled.' : 'WatchBot disabled.');
    loadAdminTab('trackers');
  } else {
    const d = await res.json();
    showSnackbar(d.error || 'Update failed', 'error');
    loadAdminTab('trackers'); // revert toggle in UI
  }
}

async function adminDeleteTracker(id, label) {
  const ok = await openDeleteConfirmDialog(`WatchBot "${label}"`, 'Delete WatchBot?');
  if (!ok) return;
  const res = await fetch(`/api/admin/trackers/${id}`, { method: 'DELETE' });
  if (res.ok) {
    adminTrackersSelected.delete(id);
    _adminCache.trackers = null;
    showSnackbar('WatchBot deleted.');
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
      document.getElementById('profileGlobalEmail').checked   = profile.globalEmailNotify  !== false;
      document.getElementById('profileHideAiFinder').checked   = profile.hideAiFinder   === true;
      document.getElementById('profileHideAddTracker').checked = profile.hideAddTracker  === true;
      document.getElementById('profileChangesMaxHeight').value  = profile.changesMaxHeight || 0;
      applyPanelPrefs(profile);
    }
  } catch {}

  try {
    const cfgRes = await fetch('/api/auth/email-configured');
    if (cfgRes.ok) {
      const { configured } = await cfgRes.json();
      const row = document.getElementById('testEmailRow');
      if (row) row.style.display = configured ? 'flex' : 'none';
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

async function sendTestEmail() {
  const btn   = document.getElementById('testEmailBtn');
  const plain = document.getElementById('testEmailPlainChk')?.checked ?? false;
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    const res  = await fetch('/api/auth/test-email', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ plain }),
    });
    const data = await res.json();
    if (res.ok) {
      showSnackbar('✓ Test email sent — check your inbox.');
    } else {
      showSnackbar(data.error || 'Failed to send test email.', 'error');
    }
  } catch {
    showSnackbar('Connection error.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-icons" style="font-size:16px">email</span> Send test email'; }
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

async function saveProfileGlobalEmail(enabled) {
  try {
    await fetch('/api/auth/profile', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ globalEmailNotify: enabled }),
    });
  } catch {}
}

async function saveChangesMaxHeight(val) {
  const h = val >= 100 ? Math.min(val, 2000) : 0;
  document.getElementById('profileChangesMaxHeight').value = h;
  await saveProfilePanelPref('changesMaxHeight', h);
}

async function saveProfilePanelPref(key, value) {
  try {
    await fetch('/api/auth/profile', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ [key]: value }),
    });
    if (currentUser) currentUser[key] = value;
    applyPanelPrefs(currentUser);
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
      const prevStatuses     = Object.fromEntries(trackers.map(t => [t.id, t.status]));
      const prevChangeCounts = Object.fromEntries(trackers.map(t => [t.id, t.changeCount || 0]));
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
      if (data.type === 'update') {
        // Invalidate cache when a tracker gains a new change — either a fresh
        // transition to 'changed', or an additional change while already 'changed'
        // (e.g. a new check fires while a dismiss is in-flight, leaving the cache
        // stale with all-dismissed items that would incorrectly hide the tracker).
        trackers.forEach(t => {
          const isNewChange = t.status === 'changed' && (
            prevStatuses[t.id] !== 'changed' ||
            (t.changeCount || 0) > prevChangeCounts[t.id]
          );
          if (isNewChange) delete _tcCache[t.id];
        });
      }
      renderTrackers();
      updateBadge();
      if (data.type === 'update') {
        trackers.forEach(t => {
          const isNewChange = t.status === 'changed' && (
            prevStatuses[t.id] !== 'changed' ||
            (t.changeCount || 0) > prevChangeCounts[t.id]
          );
          if (isNewChange) {
            showSnackbar(`🔔 Change detected: ${t.label}`);
            triggerBrowserNotification(t.label, t.url);
          }
        });
      }
    }
  };
  evtSource.onerror = async () => {
    // Check if the session is now blocked by maintenance mode
    try {
      const probe = await fetch('/api/auth/me');
      if (probe.status === 503) {
        currentUser = null;
        trackers    = [];
        renderTrackers();
        updateBadge();
        showMaintenanceOverlay();
        return;
      }
    } catch {}
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
  const newEmail    = document.getElementById(`edit-email-${id}`).checked;
  const body = {};
  if (newLabel && newLabel !== t.label) body.label = newLabel;
  if (newInterval && newInterval !== t.interval) body.interval = newInterval;
  body.aiSummary  = newAi;
  body.emailNotify = newEmail;
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
  const interval     = parseInt(document.getElementById('intervalSelect').value);
  const aiSummary    = document.getElementById('addAiSummary').checked;
  const emailNotify  = document.getElementById('addEmailNotify').checked;
  if (!url) { showSnackbar('Please enter a URL.', 'error'); return; }
  try { new URL(url); } catch { showSnackbar('Please enter a valid URL.', 'error'); return; }
  try {
    const res = await fetch('/api/trackers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, label, interval, aiSummary, emailNotify })
    });
    if (!res.ok) { const d = await res.json(); showSnackbar(d.error || 'Failed to add', 'error'); return; }
    document.getElementById('urlInput').value   = '';
    document.getElementById('labelInput').value = '';
    document.getElementById('addAiSummary').checked  = false;
    document.getElementById('addEmailNotify').checked = false;
  } catch {
    showSnackbar('Connection error', 'error');
  }
}

// ─── REMOVE TRACKER ──────────────────────────────────────────────────────────
async function removeTracker(id) {
  const t = trackers.find(t => t.id === id);
  if (!t) return;
  const shouldDelete = await openDeleteConfirmDialog(`WatchBot "${t.label}"`, 'Delete WatchBot?');
  if (!shouldDelete) return;
  try {
    const res = await fetch(`/api/trackers/${id}`, { method: 'DELETE' });
    if (!res.ok) { showSnackbar('Failed to delete WatchBot', 'error'); }
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

// ─── TRACKER CHANGE HISTORY ───────────────────────────────────────────────────

function _tcBuildHTML(t, cache) {
  const isNew      = t.status === 'changed';
  const collapsed  = _tcCollapsed.has(t.id);
  const toggleIcon = collapsed ? 'expand_more' : 'expand_less';
  const toggleTitle = collapsed ? 'Show history' : 'Hide history';

  const unreadCount  = cache?.loaded
    ? cache.items.filter(i => !i.dismissed).length
    : (isNew ? 1 : 0);
  const showUnreadBadge = isNew || unreadCount > 0;
  const badgeLabel      = unreadCount > 1 ? `${unreadCount} unread` : 'UNREAD';

  let html = `<div class="tc-header">
    <span class="material-icons" style="font-size:16px;flex-shrink:0;color:var(--on-surface-medium)">history</span>
    <span class="tc-title">History</span>
    <button class="tc-icon-btn tc-icon-btn-delete" data-tip="Delete all unflagged history" onclick="_tcDeleteHistory('${t.id}')" style="margin-left:16px">
      <span class="material-icons">delete_outline</span>
    </button>
    <button class="tc-icon-btn tc-flag-filter-btn${_tcFlagFilter.has(t.id) ? ' tc-flag-filter-btn-active' : ''}" data-tip="${_tcFlagFilter.has(t.id) ? 'Show all entries' : 'Show flagged only'}" onclick="_tcToggleFlagFilter('${t.id}')">
      <span class="material-icons">${_tcFlagFilter.has(t.id) ? 'flag' : 'outlined_flag'}</span>
    </button>
    <span class="tc-header-hotspot" onclick="_tcToggleHistory('${t.id}')"></span>
    ${showUnreadBadge && unreadCount > 0 ? `<button class="btn btn-text tc-mark-all-read-btn" onclick="_tcDismissAll('${t.id}')">Mark all read</button>` : ''}
    ${showUnreadBadge ? `<span class="tc-unread-badge" style="margin-right:8px">${badgeLabel}</span>` : ''}
    <button class="tc-icon-btn tc-toggle-history-btn" data-tip="${toggleTitle}" onclick="_tcToggleHistory('${t.id}')">
      <span class="material-icons tc-toggle-btn-icon">${toggleIcon}</span>
    </button>
  </div>`;

  if (collapsed) return html;

  html += `<div class="tc-body">`;

  if (!cache?.loaded) {
    // Show current summary from tracker state as a placeholder while history loads
    if (t.changeSummary) {
      const hasSnippet = isNew && t.changeSnippet;
      html += `<div class="tc-entry tc-entry-new">
        <div class="tc-entry-row">
          <span class="tc-unread-dot" data-tip="Unread"></span>
          <div class="tc-entry-meta">Just now</div>
          <span style="flex:1"></span>
        </div>
        <div class="diff-summary">${renderSummary(t.changeSummary)}</div>
        ${hasSnippet ? `<button class="btn btn-text" style="padding:3px 10px;font-size:12px;white-space:nowrap" onclick="toggleDiffPanel('${t.id}',this)">Show changes</button>` : ''}
      </div>
      ${hasSnippet ? `<div class="diff-panel" id="diff-panel-${t.id}">
        <div class="diff-panel-inner">
          <div class="diff-block diff-removed"><div class="diff-block-label">Before</div>${escHtml(t.changeSnippet.removed)}</div>
          <div class="diff-block diff-added"><div class="diff-block-label">After</div>${escHtml(t.changeSnippet.added)}</div>
        </div>
      </div>` : ''}`;
    }
    if (!cache || cache.loading) {
      html += `<div class="tc-loading">Loading history\u2026</div>`;
    }
    html += `</div>`;
    return html;
  }

  // Cache is loaded — render stacked history entries (newest first).
  // Apply active filter to entries too.
  const perTrackerFlagFilter = _tcFlagFilter.has(t.id);
  const visibleItems = cache.items.filter(i => {
    if (perTrackerFlagFilter)                  return !!i.flagged;
    if (!showChangedOnly && !showFlaggedOnly)  return true;
    // Union: entry is shown if it satisfies any active filter
    if (showChangedOnly && !i.dismissed) return true;
    if (showFlaggedOnly  && i.flagged)   return true;
    return false;
  });

  visibleItems.forEach((item, idx) => {
    const entryUnread = !item.dismissed;
    const entrySoft   = !!item.soft;
    const hasSnippet  = !!item.snippet;
    const dateStr     = new Date(item.detectedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    html += `<div class="tc-entry${entryUnread ? ' tc-entry-unread' : ' tc-entry-read'}${item.flagged ? ' tc-entry-flagged' : ''}${entrySoft && !item.flagged ? ' tc-entry-soft' : ''}" data-change-id="${item.id}">
      <div class="tc-entry-row">
        ${entryUnread ? `<span class="tc-unread-dot" data-tip="Unread"></span>` : '<span class="tc-read-dot" data-tip="Read"></span>'}
        <div class="tc-entry-meta">${timeAgo(item.detectedAt)} &middot; ${dateStr}</div>
        ${entrySoft ? `<span class="tc-soft-chip">no sig. change</span>` : ''}
        <span style="flex:1"></span>
        ${entryUnread ? `<button class="btn btn-text tc-mark-read-btn" onclick="_tcDismissChange('${item.id}','${t.id}')">Mark read</button>` : `<span class="tc-read-label">${entrySoft ? 'Read (auto)' : 'Read'}</span>`}
        <button class="tc-icon-btn tc-flag-btn${item.flagged ? ' tc-flag-btn-active' : ''}" data-tip="${item.flagged ? 'Unflag this change' : 'Flag this change'}" onclick="_tcFlagChange('${item.id}','${t.id}')">
          <span class="material-icons">${item.flagged ? 'flag' : 'outlined_flag'}</span>
        </button>
      </div>
      <div class="diff-summary">${renderSummary(item.summary || '')}</div>
      ${hasSnippet ? `<button class="btn btn-text" style="padding:3px 10px;font-size:12px;white-space:nowrap" onclick="toggleDiffPanel('${item.id}',this)">Show changes</button>` : ''}
    </div>
    ${hasSnippet ? `<div class="diff-panel" id="diff-panel-${item.id}">
      <div class="diff-panel-inner">
        <div class="diff-block diff-removed"><div class="diff-block-label">Before</div>${escHtml(item.snippet.removed)}</div>
        <div class="diff-block diff-added"><div class="diff-block-label">After</div>${escHtml(item.snippet.added)}</div>
      </div>
    </div>` : ''}`;
  });

  if (!showChangedOnly && !showFlaggedOnly && !_tcFlagFilter.has(t.id) && cache.total > cache.items.length) {
    const remaining = Math.min(5, cache.total - cache.items.length);
    html += `<button class="btn btn-text tc-load-more" onclick="_tcLoadMore('${t.id}')">Load ${remaining} more change${remaining !== 1 ? 's' : ''}</button>`;
  }

  html += `</div>`;
  return html;
}

async function _tcFetch(trackerId, append = false, scrollToBottom = false) {
  if (!_tcCache[trackerId]) {
    _tcCache[trackerId] = { items: [], total: 0, loaded: false, loading: false };
  }
  if (_tcCache[trackerId].loading) return;
  _tcCache[trackerId].loading = true;

  const offset = append ? _tcCache[trackerId].items.length : 0;
  try {
    const res = await fetch(`/api/trackers/${trackerId}/changes?limit=5&offset=${offset}`);
    if (!res.ok) { _tcCache[trackerId].loading = false; return; }
    const { items, total } = await res.json();
    if (append) {
      _tcCache[trackerId].items.push(...items);
    } else {
      _tcCache[trackerId].items = items;
    }
    _tcCache[trackerId].total   = total;
    _tcCache[trackerId].loaded  = true;
    _tcCache[trackerId].loading = false;
    _tcUpdate(trackerId, scrollToBottom);
  } catch {
    _tcCache[trackerId].loading = false;
  }
}

function _tcUpdate(trackerId, scrollToBottom = false) {
  const container = document.getElementById(`tc-history-${trackerId}`);
  if (!container) return;
  const t = trackers.find(t => t.id === trackerId);
  if (!t) return;
  // Preserve scroll position and diff panel open state before rebuilding
  const body         = container.querySelector('.tc-body');
  const savedScroll  = body ? body.scrollTop : 0;
  const diffPanel    = document.getElementById(`diff-panel-${trackerId}`);
  const panelWasOpen = diffPanel?.classList.contains('open');
  container.innerHTML = _tcBuildHTML(t, _tcCache[trackerId]);
  const newBody = container.querySelector('.tc-body');
  if (newBody) {
    // Use rAF so the restore runs after the browser handles focus-loss scrolling
    requestAnimationFrame(() => {
      if (scrollToBottom) {
        newBody.scrollTop = newBody.scrollHeight;
      } else if (savedScroll > 0) {
        newBody.scrollTop = savedScroll;
      }
    });
  }
  if (panelWasOpen) {
    const newPanel = document.getElementById(`diff-panel-${trackerId}`);
    if (newPanel) {
      newPanel.classList.add('open');
      const btn = container.querySelector('[onclick^="toggleDiffPanel"]');
      if (btn) btn.textContent = 'Hide changes';
    }
  }
}

function _tcLoadMore(trackerId) {
  _tcFetch(trackerId, true, true);
}

async function _tcDismissAll(trackerId) {
  const cache = _tcCache[trackerId];
  const unread = cache?.items.filter(i => !i.dismissed) ?? [];
  // Optimistic update
  unread.forEach(i => { i.dismissed = 1; });
  _tcUpdate(trackerId);
  try {
    await fetch(`/api/trackers/${trackerId}/dismiss`, { method: 'POST' });
    // SSE will update tracker.status
  } catch {
    // Revert
    unread.forEach(i => { i.dismissed = 0; });
    _tcUpdate(trackerId);
    showSnackbar('Failed to mark changes as read', 'error');
  }
}

async function _tcFlagChange(changeId, trackerId) {
  const cache = _tcCache[trackerId];
  const item  = cache?.items.find(i => i.id === changeId);
  if (!item) return;
  const wasFlagged = !!item.flagged;
  const newFlagged = !wasFlagged;
  // If a flag-based filter is active, toggling visibility requires a full rebuild.
  // Otherwise, patch the DOM directly to avoid any scroll jump.
  const filterActive = _tcFlagFilter.has(trackerId) || showFlaggedOnly;
  item.flagged = newFlagged ? 1 : 0;
  if (filterActive) {
    _tcUpdate(trackerId);
  } else {
    _tcPatchFlagDOM(trackerId, changeId, item);
  }
  try {
    const res = await fetch(`/api/changes/${changeId}/flag`, { method: 'POST' });
    if (!res.ok) throw new Error();
    const { flagged } = await res.json();
    item.flagged = flagged ? 1 : 0;
    // Only rebuild if server returned something different from our optimistic value
    if ((!!flagged) !== newFlagged) {
      if (filterActive) _tcUpdate(trackerId);
      else _tcPatchFlagDOM(trackerId, changeId, item);
    }
  } catch {
    item.flagged = wasFlagged ? 1 : 0;
    if (filterActive) _tcUpdate(trackerId);
    else _tcPatchFlagDOM(trackerId, changeId, item);
    showSnackbar('Failed to update flag', 'error');
  }
}

function _tcPatchFlagDOM(trackerId, changeId, item) {
  const container = document.getElementById(`tc-history-${trackerId}`);
  if (!container) return;
  const entry = container.querySelector(`.tc-entry[data-change-id="${changeId}"]`);
  if (!entry) { _tcUpdate(trackerId); return; }
  const flagged = !!item.flagged;
  entry.classList.toggle('tc-entry-flagged', flagged);
  // Only touch tc-entry-soft when not flagged
  if (!flagged && item.soft) entry.classList.add('tc-entry-soft');
  if (flagged) entry.classList.remove('tc-entry-soft');
  const btn = entry.querySelector('.tc-flag-btn');
  if (btn) {
    btn.classList.toggle('tc-flag-btn-active', flagged);
    btn.setAttribute('data-tip', flagged ? 'Unflag this change' : 'Flag this change');
    const icon = btn.querySelector('.material-icons');
    if (icon) icon.textContent = flagged ? 'flag' : 'outlined_flag';
  }
}

async function _tcDismissChange(changeId, trackerId) {
  const cache = _tcCache[trackerId];
  const item  = cache?.items.find(i => i.id === changeId);
  // Optimistic update
  if (item) { item.dismissed = 1; _tcUpdate(trackerId); }
  try {
    const res = await fetch(`/api/changes/${changeId}/dismiss`, { method: 'POST' });
    if (!res.ok) throw new Error();
    // SSE will update tracker.status if all changes are now dismissed
  } catch {
    // Revert optimistic update
    if (item) { item.dismissed = 0; _tcUpdate(trackerId); }
    showSnackbar('Failed to mark change as read', 'error');
  }
}

function _tcToggleFlagFilter(id) {
  if (_tcFlagFilter.has(id)) {
    _tcFlagFilter.delete(id);
  } else {
    _tcFlagFilter.add(id);
  }
  _tcUpdate(id);
}

function _tcToggleHistory(id) {
  const container = document.getElementById(`tc-history-${id}`);
  if (!container) return;
  const isCollapsed = _tcCollapsed.has(id);
  if (isCollapsed) {
    _tcCollapsed.delete(id);
  } else {
    _tcCollapsed.add(id);
  }
  _tcCollapseSave();
  // Swap the icon and re-render just the header button without a full rebuild
  const icon = container.querySelector('.tc-toggle-btn-icon');
  if (icon) {
    icon.textContent = isCollapsed ? 'expand_less' : 'expand_more';
    const btn = icon.closest('.tc-icon-btn');
    if (btn) btn.title = isCollapsed ? 'Hide history' : 'Show history';
  }
  const body = container.querySelector('.tc-body');
  if (body) {
    if (isCollapsed) {
      // Expanding: unhide first, then animate to full height
      body.style.display = '';
      body.style.maxHeight = '0';
      body.style.overflow  = 'hidden';
      requestAnimationFrame(() => {
        body.style.transition = 'max-height 0.25s ease, opacity 0.2s ease';
        body.style.opacity    = '1';
        body.style.maxHeight  = body.scrollHeight + 'px';
        body.addEventListener('transitionend', () => {
          body.style.maxHeight = '';
          body.style.overflow  = '';
          body.style.transition = '';
        }, { once: true });
      });
    } else {
      // Collapsing: animate to zero, then hide
      body.style.maxHeight  = body.scrollHeight + 'px';
      body.style.overflow   = 'hidden';
      requestAnimationFrame(() => {
        body.style.transition = 'max-height 0.2s ease, opacity 0.15s ease';
        body.style.maxHeight  = '0';
        body.style.opacity    = '0';
        body.addEventListener('transitionend', () => {
          body.style.display    = 'none';
          body.style.opacity    = '';
          body.style.maxHeight  = '';
          body.style.overflow   = '';
          body.style.transition = '';
        }, { once: true });
      });
    }
  } else if (isCollapsed) {
    // Body doesn't exist yet — panel was collapsed when last rendered.
    // We're expanding now, so do a full rebuild (also triggers _tcFetch if cache gone).
    _tcUpdate(id);
  }
}

function _tcExpandAll() {
  trackers.filter(t => t.changeCount > 0).forEach(t => {
    if (_tcCollapsed.has(t.id)) _tcToggleHistory(t.id);
  });
}

function _tcCollapseAll() {
  trackers.filter(t => t.changeCount > 0).forEach(t => {
    if (!_tcCollapsed.has(t.id)) _tcToggleHistory(t.id);
  });
}

async function _tcDeleteHistory(id) {
  const t = trackers.find(t => t.id === id);
  if (!t) return;
  const confirmed = await openDeleteConfirmDialog('all unflagged change history for this tracker (flagged entries will be kept)', 'Delete history?');
  if (!confirmed) return;
  try {
    const res = await fetch(`/api/trackers/${id}/changes`, { method: 'DELETE' });
    if (!res.ok) throw new Error();
    // Remove all unlocked entries from cache; keep locked ones so the UI
    // reflects the real state immediately without waiting for SSE.
    if (_tcCache[id]?.items) {
      _tcCache[id].items = _tcCache[id].items.filter(i => i.flagged);
      _tcCache[id].total = _tcCache[id].items.length;
      _tcUpdate(id);
    } else {
      delete _tcCache[id];
    }
    _tcCollapsed.delete(id);
    _tcCollapseSave();
    // SSE broadcast from server will push updated tracker (changeCount) → re-render
  } catch {
    showSnackbar('Failed to delete history', 'error');
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

async function dismissAll() {
  const changed = trackers.filter(t => t.status === 'changed');
  if (!changed.length) return;
  // Optimistic: mark all cached change items as dismissed immediately
  changed.forEach(t => {
    if (_tcCache[t.id]?.items) {
      _tcCache[t.id].items.forEach(i => { if (!i.flagged) i.dismissed = 1; });
      _tcUpdate(t.id);
    }
  });
  await Promise.all(changed.map(t =>
    fetch(`/api/trackers/${t.id}/dismiss`, { method: 'POST' }).catch(() => {})
  ));
  // Clear the "Show unread" filter so trackers don't all vanish after marking read
  if (showChangedOnly) {
    showChangedOnly = false;
    const chk = document.getElementById('showChangedOnlyChk');
    if (chk) chk.checked = false;
    renderTrackers();
  }
}

let _markAllReadResolver = null;
let _markAllReadKeyHandler = null;

function confirmMarkAllRead() {
  const changed = trackers.filter(t => t.status === 'changed');
  if (!changed.length) return;
  const modal = document.getElementById('markAllReadModal');
  const cancelBtn = document.getElementById('markAllReadCancelBtn');
  const confirmBtn = document.getElementById('markAllReadConfirmBtn');
  if (!modal || !cancelBtn || !confirmBtn) { dismissAll(); return; }
  if (_markAllReadResolver) _closeMarkAllReadModal(false);
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  new Promise(resolve => {
    _markAllReadResolver = resolve;
    cancelBtn.onclick  = () => _closeMarkAllReadModal(false);
    confirmBtn.onclick = () => _closeMarkAllReadModal(true);
    modal.onclick = (e) => { if (e.target === modal) _closeMarkAllReadModal(false); };
    _markAllReadKeyHandler = (e) => { if (e.key === 'Escape') _closeMarkAllReadModal(false); };
    document.addEventListener('keydown', _markAllReadKeyHandler);
    setTimeout(() => cancelBtn.focus(), 0);
  }).then(confirmed => { if (confirmed) dismissAll(); });
}

function _closeMarkAllReadModal(confirmed) {
  const modal = document.getElementById('markAllReadModal');
  if (modal) {
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    modal.onclick = null;
  }
  document.body.classList.remove('modal-open');
  if (_markAllReadKeyHandler) {
    document.removeEventListener('keydown', _markAllReadKeyHandler);
    _markAllReadKeyHandler = null;
  }
  if (_markAllReadResolver) {
    const resolve = _markAllReadResolver;
    _markAllReadResolver = null;
    resolve(confirmed);
  }
}

// ─── RENDER ───────────────────────────────────────────────────────────────────
function renderTrackers() {
  const list = document.getElementById('trackerList');

  const filtered = trackers.filter(t => {
    if (showActiveOnly  && !t.active)            return false;
    if (showAIOnly      && t.aiSummary === false) return false;
    if (trackerFilter &&
        !(t.label || '').toLowerCase().includes(trackerFilter) &&
        !(t.url   || '').toLowerCase().includes(trackerFilter)) return false;
    // Unread / locked filters: use loaded cache for precision; fall back to tracker-level counters
    if (showChangedOnly || showFlaggedOnly) {
      const cache = _tcCache[t.id];
      if (cache?.loaded) {
        // Tracker visible if any entry satisfies any active filter (OR)
        const hasMatch = cache.items.some(i =>
          (showChangedOnly && !i.dismissed) || (showFlaggedOnly && i.flagged)
        );
        if (!hasMatch) return false;
      } else {
        // Cache not yet loaded — use coarse proxy flags (OR)
        if (!(
          (showChangedOnly && t.status === 'changed') ||
          (showFlaggedOnly  && t.flaggedCount > 0)
        )) return false;
      }
    }
    return true;
  });

  // Update the filter count badge
  const countEl = document.getElementById('trackerFilterCount');
  if (countEl) {
    if (trackers.length === 0) {
      countEl.textContent = '';
    } else if (trackerFilter || showChangedOnly || showActiveOnly || showAIOnly || showFlaggedOnly) {
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
        <p>Try a different search term or <button class="btn btn-text" style="padding:2px 6px;font-size:14px;vertical-align:baseline" onclick="clearAllFilters()">clear the filter</button>.</p>
      </div>`;
    return;
  }

  // Remember which diff panels are open so we can restore them after re-render
  const openDiffPanels = new Set(
    [...list.querySelectorAll('.diff-panel.open')].map(el => el.id)
  );

  // Save tc-body scroll positions so they survive the innerHTML rebuild
  const savedScrolls = new Map();
  list.querySelectorAll('[id^="tc-history-"]').forEach(el => {
    const body = el.querySelector('.tc-body');
    if (body && body.scrollTop > 0) {
      savedScrolls.set(el.id.replace('tc-history-', ''), body.scrollTop);
    }
  });

  list.innerHTML = '';
  filtered.forEach(t => {
    const el = document.createElement('div');
    el.className = `tracker-item ${t.active ? '' : 'tracker-item-paused'}`.trim();
    el.dataset.id = t.id;
    el.draggable = false;
    el.innerHTML = trackerHTML(t);
    list.appendChild(el);
    // Restore scroll immediately after element is in DOM
    if (savedScrolls.has(t.id)) {
      const body = el.querySelector('.tc-body');
      if (body) body.scrollTop = savedScrolls.get(t.id);
    }
  });

  // Kick off history fetches for trackers with changes that aren't cached yet
  filtered.filter(t => t.changeCount > 0 && !_tcCache[t.id]?.loaded).forEach(t => _tcFetch(t.id));

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
function clearAllFilters() {
  trackerFilter   = '';
  showChangedOnly = false;
  showActiveOnly  = false;
  showAIOnly      = false;
  showFlaggedOnly = false;
  const search = document.getElementById('trackerSearch');
  if (search) search.value = '';
  const changedChk = document.getElementById('showChangedOnlyChk');
  if (changedChk) changedChk.checked = false;
  const activeChk = document.getElementById('showActiveOnlyChk');
  if (activeChk) activeChk.checked = false;
  const aiChk = document.getElementById('showAIOnlyChk');
  if (aiChk) aiChk.checked = false;
  const flaggedChk = document.getElementById('showFlaggedOnlyChk');
  if (flaggedChk) flaggedChk.checked = false;
  renderTrackers();
}

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

function setShowFlaggedOnly(checked) {
  showFlaggedOnly = checked;
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

async function moveToTop(id) {
  const idx = trackers.findIndex(t => t.id === id);
  if (idx <= 0) return;
  const [moved] = trackers.splice(idx, 1);
  trackers.unshift(moved);
  renderTrackers();
  await persistOrder();
}

function trackerHTML(t) {
  const statusClass = t.status === 'checking' ? 'status-pending' :
                      !t.active              ? 'status-pending' :
                      t.status === 'changed' ? 'status-changed' :
                      t.status === 'error'   ? 'status-error'   :
                      t.status === 'ok'      ? 'status-ok'      : 'status-pending';

  const chipClass = t.status === 'checking' ? '' :
                    !t.active               ? 'chip-paused'  :
                    t.status === 'changed'  ? 'chip-changed' :
                    t.status === 'error'    ? 'chip-error'   :
                    t.status === 'ok'       ? 'chip-ok'      : '';

  const chipLabel = t.status === 'checking' ? 'Checking…' :
                    !t.active               ? 'Paused' :
                    t.status === 'changed'  ? `${t.changeCount} change${t.changeCount !== 1 ? 's' : ''}` :
                    t.status === 'error'    ? 'Error' :
                    t.status === 'ok'       ? 'No changes' : 'Pending';

  const lastCheck    = t.lastCheck ? 'Last: ' + new Date(t.lastCheck).toLocaleTimeString() : 'Never checked';
  const timeAgoStr   = t.lastCheck ? timeAgo(t.lastCheck) : '';
  const intervalLabel = intervalText(t.interval);

  let changeBanner = '';
  if (t.status === 'error' && t.changeSummary) {
    // Error: keep the simple single-banner style
    changeBanner = `
      <div class="tracker-change-banner">
        <span class="material-icons">error_outline</span>
        <span class="diff-summary">${renderSummary(t.changeSummary)}</span>
      </div>`;
  } else if (t.changeCount > 0) {
    // Change history stacking panel
    changeBanner = `<div id="tc-history-${t.id}" class="tc-history">${_tcBuildHTML(t, _tcCache[t.id])}</div>`;
  }

  return `
    <div class="tracker-main">
      <span class="drag-handle material-icons" data-tip="Drag to reorder">drag_indicator</span>
      <span class="tracker-status ${statusClass}"></span>
      <div class="tracker-info">
        ${(() => { let src = t.faviconUrl; if (!src) { try { const h = new URL(t.url).hostname; src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h)}&sz=32`; } catch {} } return src ? `<img src="${escHtml(src)}" alt="" class="tracker-favicon" onerror="this.style.display='none'" loading="lazy">` : ''; })()}
        <div class="tracker-info-text">
          <div class="tracker-name">${escHtml(t.label)}</div>
          <div class="tracker-url">${escHtml(t.url)}</div>
        </div>
      </div>
      <span class="chip ${chipClass}" style="margin-right:8px">${chipLabel}</span>
      <div class="tracker-meta">
        <div class="tracker-interval"><span class="material-icons">schedule</span>${intervalLabel}</div>
        <div class="tracker-last-check">${lastCheck}</div>
        ${timeAgoStr ? `<div class="tracker-time-ago" data-ts="${t.lastCheck}">${timeAgoStr}</div>` : ''}
        <div data-tip="${t.aiSummary !== false ? 'AI summary enabled' : 'AI summary disabled'}" style="display:flex;align-items:center;gap:3px;font-size:11px;${t.aiSummary !== false ? 'color:var(--primary);opacity:0.75' : 'color:var(--on-surface-medium);opacity:0.45'}">
          <span class="material-icons" style="font-size:13px">${t.aiSummary !== false ? 'auto_awesome' : 'auto_awesome'}</span>AI
        </div>
        ${t.emailNotify ? `<div data-tip="Email notifications enabled" style="display:flex;align-items:center;gap:3px;font-size:11px;color:var(--primary);opacity:0.75"><span class="material-icons" style="font-size:13px">email</span></div>` : ''}
      </div>
      <div class="tracker-actions">
        <label class="toggle" data-tip="${t.active ? 'Pause' : 'Resume'} tracker">
          <input type="checkbox" ${t.active ? 'checked' : ''} onchange="toggleTracker('${t.id}')">
          <span class="toggle-slider"></span>
        </label>
        <button class="btn-icon tracker-action-icon" onclick="moveToTop('${t.id}')" data-tip="Move to top" ${trackers[0]?.id === t.id ? 'disabled style="opacity:0.25;cursor:default"' : ''}><span class="material-icons">vertical_align_top</span></button>
        <a class="btn-icon tracker-action-icon material-icons" href="${escHtml(t.url)}" target="_blank" rel="noopener noreferrer" data-tip="Open URL in new tab" style="text-decoration:none">open_in_new</a>
        <button class="btn-icon tracker-action-icon material-icons" style="color:var(--error)" onclick="removeTracker('${t.id}')" data-tip="Remove">delete_outline</button>
        <button class="btn-icon tracker-action-icon material-icons" onclick="toggleEdit('${t.id}')" data-tip="Edit">edit</button>
        <button class="btn-icon tracker-action-icon material-icons" onclick="checkTracker('${t.id}')" data-tip="Check now" ${t.status === 'checking' ? 'disabled' : ''}>refresh</button>
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
        <label class="ai-checkbox-row" data-tip="When disabled, changes are still detected but no AI summary is generated">
          <input type="checkbox" id="edit-ai-${t.id}" ${t.aiSummary !== false ? 'checked' : ''} />
          AI summary
        </label>
        <label class="ai-checkbox-row" data-tip="Send an email notification when this tracker detects a change">
          <input type="checkbox" id="edit-email-${t.id}" ${t.emailNotify ? 'checked' : ''} />
          Email on change
        </label>
      </div>
      <button class="btn btn-primary" style="height:36px;padding:0 16px;font-size:13px" onclick="saveEdit('${t.id}')">Save</button>
      <button class="btn btn-text"    style="height:36px;padding:0 12px;font-size:13px" onclick="toggleEdit(null)">Cancel</button>
    </div>` : ''}
    ${changeBanner}`;
}

function updateBadge() {
  const active = trackers.filter(t => t.active).length;
  const limit = currentUser && currentUser.trackerLimit ? currentUser.trackerLimit : null;
  const limitStr = limit ? limit : '<span style="font-size:22px;line-height:1;vertical-align:middle">∞</span>';
  document.getElementById('activeCount').innerHTML = `${active} active / ${limitStr}`;
  const btn = document.getElementById('dismissAllBtn');
  if (btn) btn.style.display = trackers.some(t => t.status === 'changed') ? '' : 'none';
  const hasHistory = trackers.some(t => t.changeCount > 0);
  const expandBtn   = document.getElementById('expandAllBtn');
  const collapseBtn = document.getElementById('collapseAllBtn');
  if (expandBtn)   expandBtn.style.display   = hasHistory ? '' : 'none';
  if (collapseBtn) collapseBtn.style.display = hasHistory ? '' : 'none';
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
let aiVisibleCount       = 10;
let aiCategoryFilter     = null;
const AI_PAGE_SIZE       = 10;
const _AI_CACHE_KEY      = 'watchdog_ai_results';
let _trackerOptResolver  = null;
let _trackerOptEscHandler = null;

function _aiCacheSave(query) {
  try {
    localStorage.setItem(_AI_CACHE_KEY, JSON.stringify({
      query,
      suggestions: aiSuggestions.map(s => ({ ...s, selected: false })),
    }));
  } catch {}
}

function _aiCacheRestore() {
  try {
    const cached = JSON.parse(localStorage.getItem(_AI_CACHE_KEY));
    if (!cached?.suggestions?.length) return;
    aiSuggestions  = cached.suggestions;
    aiVisibleCount = AI_PAGE_SIZE;
    aiCategoryFilter = null;
    document.getElementById('aiSearchInput').value = cached.query || '';
    document.getElementById('aiResultsPanel').style.display = '';
    _renderAISuggestions(cached.query || '');
  } catch {}
}

// Per-tracker change history cache: trackerId → { items, total, loaded, loading }
const _tcCache = {};
// Trackers whose history panel is collapsed — persisted in localStorage
const _TC_COLLAPSED_KEY = 'watchdog_tc_collapsed';
function _tcCollapseSave() {
  try { localStorage.setItem(_TC_COLLAPSED_KEY, JSON.stringify([..._tcCollapsed])); } catch {}
}
const _tcCollapsed = new Set(
  (() => { try { return JSON.parse(localStorage.getItem(_TC_COLLAPSED_KEY)) || []; } catch { return []; } })()
);

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

function clearAIResults() {
  aiSuggestions    = [];
  aiVisibleCount   = AI_PAGE_SIZE;
  aiCategoryFilter = null;
  document.getElementById('aiResultsPanel').style.display = 'none';
  document.getElementById('aiSearchInput').value = '';
  document.getElementById('aiSearchInput').focus();
  try { localStorage.removeItem(_AI_CACHE_KEY); } catch {}
}

async function prefillLabelFromUrl(url) {
  if (!url) return;
  try { new URL(url); } catch { return; }
  const labelEl = document.getElementById('labelInput');
  // Don't overwrite if the user already typed something
  if (labelEl.value.trim()) return;
  try {
    const res  = await fetch(`/api/fetch-title?url=${encodeURIComponent(url)}`);
    if (!res.ok) return;
    const { title } = await res.json();
    if (title && !labelEl.value.trim()) {
      labelEl.value = title.slice(0, 120);
      labelEl.select();
    }
  } catch { /* silent — label stays empty */ }
}

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
  aiSuggestions    = (data.suggestions || []).map(s => ({ ...s, selected: false }));
    aiVisibleCount   = AI_PAGE_SIZE;
    aiCategoryFilter = null;
    _aiCacheSave(query);
    _renderAISuggestions(query);
  } catch {
    showSnackbar('Connection error', 'error');
    panel.style.display = 'none';
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="material-icons" style="font-size:18px">auto_awesome</span> Find Resources';
  }
}

function _aiSetCategoryFilter(cat) {
  aiCategoryFilter = (aiCategoryFilter === cat) ? null : cat;
  aiVisibleCount   = AI_PAGE_SIZE;
  const query = document.getElementById('aiSearchInput').value.trim();
  _renderAISuggestions(query);
}

function _renderCategoryFilterChips() {
  const filtersEl = document.getElementById('aiCategoryFilters');
  if (!filtersEl) return;

  // Count each category across ALL suggestions (not just visible)
  const counts = {};
  aiSuggestions.forEach(s => { counts[s.category] = (counts[s.category] || 0) + 1; });
  const cats = Object.keys(counts).sort();

  if (cats.length <= 1) { filtersEl.style.display = 'none'; return; }

  filtersEl.style.display = 'flex';
  filtersEl.innerHTML = cats.map(cat => {
    const cls     = AI_CATEGORY_CLASS[cat] || 'ai-cat-other';
    const active  = aiCategoryFilter === cat;
    return `<button class="ai-filter-chip ${cls}${active ? ' active' : ''}" onclick="_aiSetCategoryFilter('${escHtml(cat)}')">
      ${escHtml(cat)} <span class="ai-filter-chip-count">${counts[cat]}</span>
    </button>`;
  }).join('');
}

function _renderAISuggestions(query) {
  const list  = document.getElementById('aiSuggestionsList');
  const title = document.getElementById('aiResultsTitle');

  if (!aiSuggestions.length) {
    title.textContent = 'No results found';
    list.innerHTML = '<div class="ai-finder-empty">No suggestions found for this topic. Try a different search term.</div>';
    return;
  }

  _renderCategoryFilterChips();

  const filtered  = aiCategoryFilter ? aiSuggestions.filter(s => s.category === aiCategoryFilter) : aiSuggestions;
  const shown     = filtered.slice(0, aiVisibleCount);
  const remaining = filtered.length - aiVisibleCount;
  const totalDesc = aiCategoryFilter
    ? `${filtered.length} ${aiCategoryFilter} result${filtered.length !== 1 ? 's' : ''} of ${aiSuggestions.length} total`
    : `${aiSuggestions.length} suggestion${aiSuggestions.length !== 1 ? 's' : ''}`;
  title.textContent = `Showing ${shown.length} of ${totalDesc} for "${escHtml(query)}"`;

  const itemsHtml = shown.map((s) => {
    const origIdx  = aiSuggestions.indexOf(s);
    const catClass = AI_CATEGORY_CLASS[s.category] || 'ai-cat-other';
    return `
    <div class="ai-suggestion-item${s.selected ? ' selected' : ''}" data-ai-idx="${origIdx}" onclick="_aiToggle(${origIdx})">
      <input type="checkbox" class="ai-suggestion-checkbox" ${s.selected ? 'checked' : ''}
        onclick="event.stopPropagation();_aiToggle(${origIdx})" />
      <div class="ai-suggestion-body">
        <div class="ai-suggestion-label">${escHtml(s.label)}</div>
        <a class="ai-suggestion-url" href="${escHtml(s.url)}" target="_blank" rel="noopener noreferrer"
          onclick="event.stopPropagation()">${escHtml(s.url)}</a>
        <div class="ai-suggestion-desc">${escHtml(s.description)}</div>
      </div>
      <span class="ai-category-badge ${catClass}">${escHtml(s.category)}</span>
    </div>`;
  }).join('');

  const showMoreHtml = remaining > 0
    ? `<div class="ai-show-more">
        <button class="btn btn-text" onclick="_aiShowMore()">
          <span class="material-icons" style="font-size:18px">expand_more</span>
          Show ${Math.min(remaining, AI_PAGE_SIZE)} more <span style="color:var(--on-surface-light);font-weight:400">(${remaining} remaining)</span>
        </button>
       </div>`
    : '';

  list.innerHTML = itemsHtml + showMoreHtml;
  _updateAIAddBtn();
}

function _aiShowMore() {
  const filtered = aiCategoryFilter ? aiSuggestions.filter(s => s.category === aiCategoryFilter) : aiSuggestions;
  aiVisibleCount = Math.min(aiVisibleCount + AI_PAGE_SIZE, filtered.length);
  const query = document.getElementById('aiSearchInput').value.trim();
  _renderAISuggestions(query);
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
  // Only affect currently visible (and filtered) items
  const filtered = aiCategoryFilter ? aiSuggestions.filter(s => s.category === aiCategoryFilter) : aiSuggestions;
  filtered.slice(0, aiVisibleCount).forEach(s => s.selected = selected);
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
  const interval     = parseInt(document.getElementById('toIntervalSelect').value) || 30000;
  const aiSummary    = document.getElementById('toAiSummary').checked;
  const emailNotify  = document.getElementById('toEmailNotify').checked;

  let added = 0, failed = 0, lastError = null;

  for (const s of selected) {
    try {
      const res = await fetch('/api/trackers', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ url: s.url, label: s.label, interval, aiSummary, emailNotify })
      });
      if (res.ok) {
        added++;
        const idx = aiSuggestions.findIndex(x => x === s);
        if (idx >= 0) aiSuggestions[idx].selected = false;
      } else {
        const d = await res.json().catch(() => ({}));
        if (d.error) lastError = d.error;
        failed++;
      }
    } catch { failed++; }
  }

  const query = document.getElementById('aiSearchInput').value.trim();
  _renderAISuggestions(query);

  if (added > 0 && failed === 0)
    showSnackbar(`Added ${added} WatchBot${added !== 1 ? 's' : ''} successfully!`);
  else if (added > 0)
    showSnackbar(`Added ${added} WatchBot${added !== 1 ? 's' : ''}; ${failed} failed.${lastError ? ' ' + lastError : ''}`, 'error');
  else
    showSnackbar(lastError || `Failed to add WatchBot${failed !== 1 ? 's' : ''}.`, 'error');
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

// Render AI summary text: supports markdown bullets (- / * / •), bold (**text**), and newlines
function renderSummary(text) {
  if (!text) return '';
  const lines = text.split(/\n/);
  let html = '';
  let inList = false;

  for (let raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (inList) { html += '</ul>'; inList = false; }
      html += '<br>';
      continue;
    }
    const bulletMatch = line.match(/^[-*•]\s+(.*)/);
    if (bulletMatch) {
      if (!inList) { html += '<ul class="summary-list">'; inList = true; }
      html += `<li>${_summaryInline(bulletMatch[1])}</li>`;
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<p class="summary-para">${_summaryInline(line)}</p>`;
    }
  }
  if (inList) html += '</ul>';
  return html;
}

function _summaryInline(str) {
  return escHtml(str)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
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
  if (document.getElementById('markAllReadModal')?.classList.contains('show')) {
    _closeMarkAllReadModal(false); return;
  }
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

// ─── STICKY TOOLBAR SENTINEL ──────────────────────────────────────────────────
// Add .is-stuck when the section header is scrolled into sticky position.
// Uses an IntersectionObserver on a zero-height sentinel inserted just above it.
(function initStickyToolbar() {
  const header = document.querySelector('.section-header');
  if (!header || !window.IntersectionObserver) return;
  const sentinel = document.createElement('div');
  sentinel.style.cssText = 'height:1px;pointer-events:none;margin-bottom:-1px';
  header.parentNode.insertBefore(sentinel, header);
  new IntersectionObserver(([entry]) => {
    header.classList.toggle('is-stuck', !entry.isIntersecting);
  }, { threshold: 0, rootMargin: `-${65}px 0px 0px 0px` }).observe(sentinel);
})();
