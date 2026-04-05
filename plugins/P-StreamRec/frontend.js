// P-StreamRec - Redesigned Browser for Stash
(function () {
  "use strict";

  const PLUGIN_ID = "P-StreamRec";
  const HLS_CDN = "https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js";

  let isPageActive = false;
  let currentGender = "f";
  let currentPage = 1;
  let currentCam4Page = 1;
  let totalRooms = 0;
  let isLoading = false;
  let hlsPlayer = null;
  let hlsLoaded = false;
  let thumbRefreshInterval = null;

  // Filters state
  let filters = { search: "", region: "", tags: [], newOnly: false, minViewers: 0, minAge: 0, genders: [] };

  // Session state (loaded from backend)
  let cbSession = { connected: false, username: "" };

  async function loadSessionStatus() {
    try {
      const res = await runPlugin({ action: "get_status" });
      const parsed = typeof res === "string" ? JSON.parse(res) : (res || {});
      cbSession = { connected: !!parsed.connected, username: parsed.username || "" };
    } catch {
      cbSession = { connected: false, username: "" };
    }
  }

  // --- Plugin Backend ---

  async function runPlugin(args, timeoutMs) {
    const controller = new AbortController();
    const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const data = await csLib.callGQL({
        query: `mutation RunPluginOperation($plugin_id: ID!, $args: Map!) {
          runPluginOperation(plugin_id: $plugin_id, args: $args)
        }`,
        variables: { plugin_id: PLUGIN_ID, args },
      });
      if (timer) clearTimeout(timer);
      const raw = data?.runPluginOperation;
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return raw; }
    } catch (e) {
      if (timer) clearTimeout(timer);
      throw e;
    }
  }

  function escapeHtml(str) {
    if (!str) return "";
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  function formatViewers(n) {
    if (!n) return "0";
    if (n >= 1000) return (n / 1000).toFixed(1) + "k";
    return String(n);
  }

  function formatDuration(seconds) {
    if (!seconds) return "";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return h + "h" + (m > 0 ? m + "m" : "");
    return m + "m";
  }

  // --- HLS Loader ---

  function loadHls() {
    return new Promise((resolve) => {
      if (typeof Hls !== "undefined") return resolve();
      if (hlsLoaded) return setTimeout(resolve, 300);
      const s = document.createElement("script");
      s.src = HLS_CDN;
      s.onload = () => { hlsLoaded = true; resolve(); };
      s.onerror = () => resolve();
      document.head.appendChild(s);
    });
  }

  // --- Navigation Tab ---

  function injectNavTab() {
    if (document.getElementById("cb-nav-link")) return;
    const nav = document.querySelector(".navbar-nav");
    if (!nav) return;
    const existingItem = nav.querySelector(".nav-link");
    if (!existingItem) return;

    const wrapper = document.createElement(existingItem.tagName);
    wrapper.className = existingItem.className;
    wrapper.id = "cb-nav-wrapper";

    const a = document.createElement("a");
    a.href = "#";
    a.id = "cb-nav-link";
    const link = existingItem.querySelector("a");
    a.className = link ? link.className : "minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column justify-content-between align-items-center btn btn-primary";
    a.innerHTML = '<span class="cb-nav-dot"></span><span>P-StreamRec</span>';
    a.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.location.hash = "#/plugin/P-StreamRec/f";
    });

    wrapper.appendChild(a);
    nav.appendChild(wrapper);
  }

  // --- Page ---

  async function openPage(initialTab) {
    if (isPageActive) return;
    isPageActive = true;
    await loadSessionStatus();
    const hasSession = cbSession.connected;
    currentGender = initialTab || "f";

    // Hide Stash's own content
    const stashMain = document.querySelector(".main.container-fluid");
    if (stashMain) {
      [...stashMain.children].forEach(c => {
        if (c.id !== "cb-overlay") c.style.display = "none";
      });
    }

    const overlay = document.createElement("div");
    overlay.id = "cb-overlay";
    overlay.className = "cb-page";
    overlay.innerHTML = `
      <div class="cb-app">
        <div class="cb-topbar">
          <div class="cb-topbar-left">
            <span class="cb-logo-dot"></span>
            <span class="cb-logo-text">P-StreamRec</span>
          </div>
          <div class="cb-topbar-center">
            <div class="cb-tabs" id="cb-tabs">
              <button class="cb-tab${currentGender==='f'?' active':''}" data-gender="f">Women</button>
              <button class="cb-tab${currentGender==='m'?' active':''}" data-gender="m">Men</button>
              <button class="cb-tab${currentGender==='c'?' active':''}" data-gender="c">Couples</button>
              <button class="cb-tab${currentGender==='t'?' active':''}" data-gender="t">Trans</button>
              <button class="cb-tab${currentGender==='follows'?' active':''}" data-gender="follows">
                <span class="cb-tab-heart">\u2665</span> Following${hasSession ? '' : ' <span class="cb-tab-lock">\uD83D\uDD12</span>'}
              </button>
            </div>
          </div>
          <div class="cb-topbar-right">
            <button class="cb-icon-btn" id="cb-settings-btn" title="Settings">\u2699</button>
            <button class="cb-icon-btn" id="cb-refresh-btn" title="Refresh">\u21BB</button>
          </div>
        </div>
        <div class="cb-filters" id="cb-filters">
          <div class="cb-filters-row">
            <div class="cb-gender-pills" id="cb-gender-pills">
              <button class="cb-gender-pill" data-g="f">Women</button>
              <button class="cb-gender-pill" data-g="m">Men</button>
              <button class="cb-gender-pill" data-g="c">Couples</button>
              <button class="cb-gender-pill" data-g="t">Trans</button>
            </div>
            <div class="cb-filter-sep"></div>
            <input class="cb-filter-search" id="cb-filter-search" type="text" placeholder="Search\u2026" />
            <select class="cb-filter-select" id="cb-filter-region">
              <option value="">Region</option>
              <option value="North America">North America</option>
              <option value="South America">South America</option>
              <option value="Europe">Europe</option>
              <option value="Asia">Asia</option>
              <option value="Other">Other</option>
            </select>
            <select class="cb-filter-select" id="cb-filter-viewers">
              <option value="0">Viewers</option>
              <option value="10">10+</option>
              <option value="50">50+</option>
              <option value="100">100+</option>
              <option value="500">500+</option>
              <option value="1000">1000+</option>
            </select>
            <select class="cb-filter-select" id="cb-filter-age">
              <option value="0">Age</option>
              <option value="18">18+</option>
              <option value="20">20+</option>
              <option value="25">25+</option>
              <option value="30">30+</option>
              <option value="40">40+</option>
            </select>
            <label class="cb-filter-toggle" id="cb-filter-new-label"><input type="checkbox" id="cb-filter-new" /> NEW</label>
          </div>
          <div class="cb-filters-tags" id="cb-filters-tags"></div>
        </div>
        <div class="cb-body" id="cb-body">
          <div class="cb-grid" id="cb-grid"></div>
          <div class="cb-load-more" id="cb-load-more" style="display:none">
            <button class="cb-more-btn" id="cb-more-btn">Load more</button>
          </div>
        </div>
      </div>

      <!-- Player Modal -->
      <div class="cb-player-overlay" id="cb-player-overlay" style="display:none">
        <div class="cb-player-modal" id="cb-player-modal">
          <div class="cb-player-head">
            <div class="cb-player-info">
              <span class="cb-player-live-dot"></span>
              <span class="cb-player-name" id="cb-player-name"></span>
              <span class="cb-player-viewers" id="cb-player-viewers"></span>
            </div>
            <div class="cb-player-actions">
              <button class="cb-player-follow-btn" id="cb-player-follow" title="Follow">\u2661</button>
              <a id="cb-player-ext" href="#" target="_blank" rel="noopener" class="cb-icon-btn" title="Open on site">\u2197</a>
              <button class="cb-icon-btn cb-icon-close" id="cb-player-close">\u00D7</button>
            </div>
          </div>
          <div class="cb-player-subject" id="cb-player-subject"></div>
          <div class="cb-player-video-wrap">
            <video id="cb-player-video" controls autoplay playsinline></video>
            <div class="cb-player-loading" id="cb-player-loading"><span class="cb-spin"></span></div>
          </div>
        </div>
      </div>

      <!-- Settings Modal -->
      <div class="cb-settings-overlay" id="cb-settings-overlay" style="display:none">
        <div class="cb-settings-modal cb-settings-modal-wide">
          <div class="cb-settings-head">
            <span class="cb-settings-title">\u2699 P-StreamRec Settings</span>
            <button class="cb-icon-btn cb-icon-close" id="cb-settings-close">\u00D7</button>
          </div>
          <div class="cb-settings-layout">
            <div class="cb-settings-sidebar">
              <button class="cb-settings-menu-item active" data-settings-tab="chaturbate">
                <span class="cb-settings-menu-icon">\uD83D\uDFE0</span>
                <span class="cb-settings-menu-label">Chaturbate</span>
              </button>
              <button class="cb-settings-menu-item" data-settings-tab="cam4">
                <span class="cb-settings-menu-icon">\uD83D\uDD34</span>
                <span class="cb-settings-menu-label">Cam4</span>
              </button>
            </div>
            <div class="cb-settings-content">
              <!-- Chaturbate panel -->
              <div class="cb-settings-panel" id="cb-panel-chaturbate">
                <div class="cb-settings-section">
                  <div class="cb-settings-section-title">Chaturbate Login</div>
                  <p class="cb-settings-desc">
                    Enter your credentials to access your follows.<br>
                    <span class="cb-settings-note">A window will briefly open for authentication.</span>
                  </p>
                  <div class="cb-field">
                    <label class="cb-field-label">Username</label>
                    <input class="cb-field-input" type="text" id="cb-creds-user" placeholder="your_username" autocomplete="username" />
                  </div>
                  <div class="cb-field">
                    <label class="cb-field-label">Password</label>
                    <input class="cb-field-input" type="password" id="cb-creds-pass" placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" autocomplete="current-password" />
                  </div>
                  <div class="cb-login-status" id="cb-login-status" style="display:none">
                    <span class="cb-spin"></span>
                    <span id="cb-login-msg">Connecting\u2026</span>
                  </div>
                  <div class="cb-settings-actions">
                    <button class="cb-save-btn" id="cb-creds-login">Log in</button>
                    <button class="cb-clear-btn" id="cb-creds-clear" ${hasSession ? '' : 'style="display:none"'}>Log out</button>
                    <span class="cb-save-status" id="cb-save-status">${hasSession ? '\u2713 Connected' : ''}</span>
                  </div>
                </div>
              </div>
              <!-- Cam4 panel -->
              <div class="cb-settings-panel" id="cb-panel-cam4" style="display:none">
                <div class="cb-settings-section">
                  <div class="cb-settings-section-title">Cam4 Login</div>
                  <p class="cb-settings-desc">
                    Enter your Cam4 credentials to access your follows.<br>
                    <span class="cb-settings-note">Coming soon.</span>
                  </p>
                  <div class="cb-field">
                    <label class="cb-field-label">Username</label>
                    <input class="cb-field-input" type="text" id="cam4-creds-user" placeholder="your_username" autocomplete="username" disabled />
                  </div>
                  <div class="cb-field">
                    <label class="cb-field-label">Password</label>
                    <input class="cb-field-input" type="password" id="cam4-creds-pass" placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" autocomplete="current-password" disabled />
                  </div>
                  <div class="cb-settings-actions">
                    <button class="cb-save-btn" id="cam4-creds-login" disabled>Coming soon</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    const mainContainer = document.querySelector(".main.container-fluid");
    if (mainContainer) {
      mainContainer.appendChild(overlay);
    } else {
      document.body.appendChild(overlay);
    }

    // Pre-fill saved username
    if (cbSession.username) {
      const userInput = overlay.querySelector("#cb-creds-user");
      if (userInput) userInput.value = cbSession.username;
    }
    if (hasSession) {
      const status = overlay.querySelector("#cb-save-status");
      if (status) { status.textContent = "\u2713 Connected"; status.className = "cb-save-status cb-save-status-ok"; }
    }

    bindEvents(overlay);
    document.addEventListener("keydown", handleEsc);

    const navLink = document.getElementById("cb-nav-link");
    if (navLink) navLink.classList.add("cb-active");

    currentPage = 1;
    currentCam4Page = 1;
    fetchRooms();
    startThumbRefresh();
  }

  function closePage() {
    if (!isPageActive) return;
    isPageActive = false;
    stopThumbRefresh();
    closePlayer();
    const overlay = document.getElementById("cb-overlay");
    if (overlay) overlay.remove();
    document.removeEventListener("keydown", handleEsc);

    const mainContainer = document.querySelector(".main.container-fluid");
    if (mainContainer) {
      [...mainContainer.children].forEach(c => {
        if (c.style) c.style.display = "";
      });
    }

    const navLink = document.getElementById("cb-nav-link");
    if (navLink) navLink.classList.remove("cb-active");
  }

  function handleEsc(e) {
    if (e.key === "Escape") {
      const pov = document.getElementById("cb-player-overlay");
      if (pov && pov.style.display !== "none") { closePlayer(); return; }
      const sov = document.getElementById("cb-settings-overlay");
      if (sov && sov.style.display !== "none") { closeSettings(); return; }
      closePage();
    }
  }

  // --- Settings ---

  function openSettings() {
    const sov = document.getElementById("cb-settings-overlay");
    if (sov) sov.style.display = "";
  }

  function closeSettings() {
    const sov = document.getElementById("cb-settings-overlay");
    if (sov) sov.style.display = "none";
  }

  function showSaveStatus(msg, type) {
    const el = document.getElementById("cb-save-status");
    if (!el) return;
    el.textContent = msg;
    el.className = "cb-save-status " + (type === "error" ? "cb-save-status-err" : "cb-save-status-ok");
    if (type !== "ok-persist") setTimeout(() => { el.textContent = ""; el.className = "cb-save-status"; }, 4000);
  }

  function bindEvents(overlay) {
    overlay.querySelector("#cb-refresh-btn").addEventListener("click", () => {
      currentPage = 1;
      currentCam4Page = 1;
      fetchRooms();
    });
    overlay.querySelector("#cb-player-close").addEventListener("click", closePlayer);
    overlay.querySelector("#cb-player-overlay").addEventListener("click", (e) => {
      if (e.target.id === "cb-player-overlay") closePlayer();
    });

    // Settings
    overlay.querySelector("#cb-settings-btn").addEventListener("click", openSettings);
    overlay.querySelector("#cb-settings-close").addEventListener("click", closeSettings);
    overlay.querySelector("#cb-settings-overlay").addEventListener("click", (e) => {
      if (e.target.id === "cb-settings-overlay") closeSettings();
    });

    // Settings sidebar tabs
    overlay.querySelectorAll(".cb-settings-menu-item").forEach(item => {
      item.addEventListener("click", () => {
        overlay.querySelectorAll(".cb-settings-menu-item").forEach(i => i.classList.remove("active"));
        item.classList.add("active");
        const tab = item.dataset.settingsTab;
        overlay.querySelectorAll(".cb-settings-panel").forEach(p => p.style.display = "none");
        const panel = overlay.querySelector("#cb-panel-" + tab);
        if (panel) panel.style.display = "";
      });
    });

    // Login button
    overlay.querySelector("#cb-creds-login").addEventListener("click", () => doLogin(overlay));
    overlay.querySelector("#cb-creds-pass").addEventListener("keydown", (e) => {
      if (e.key === "Enter") doLogin(overlay);
    });

    // Logout
    overlay.querySelector("#cb-creds-clear").addEventListener("click", () => {
      cbSession = { connected: false, username: "" };
      runPlugin({ action: "logout" }).catch(() => {});
      overlay.querySelector("#cb-creds-pass").value = "";
      overlay.querySelector("#cb-creds-clear").style.display = "none";
      showSaveStatus("Logged out", "ok");
      const followsTab = overlay.querySelector('[data-gender="follows"]');
      if (followsTab) followsTab.innerHTML = '<span class="cb-tab-heart">\u2665</span> Following <span class="cb-tab-lock">\uD83D\uDD12</span>';
      if (currentGender === "follows") { currentPage = 1; fetchRooms(); }
    });

    // Tabs
    overlay.querySelectorAll(".cb-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        overlay.querySelectorAll(".cb-tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        currentGender = tab.dataset.gender;
        currentPage = 1;
        currentCam4Page = 1;
        setHashTab(currentGender);
        resetFilters();
        updateFiltersVisibility();
        fetchRooms();
      });
    });

    // Gender pills
    overlay.querySelectorAll(".cb-gender-pill").forEach(pill => {
      pill.addEventListener("click", () => {
        const g = pill.dataset.g;
        const idx = filters.genders.indexOf(g);
        if (idx >= 0) { filters.genders.splice(idx, 1); pill.classList.remove("active"); }
        else { filters.genders.push(g); pill.classList.add("active"); }
        applyFiltersToGrid();
      });
    });

    // Filters
    let filterTimeout = null;
    const debouncedFilter = () => {
      clearTimeout(filterTimeout);
      filterTimeout = setTimeout(() => applyFiltersToGrid(), 200);
    };
    overlay.querySelector("#cb-filter-search").addEventListener("input", (e) => {
      filters.search = e.target.value.trim().toLowerCase();
      debouncedFilter();
    });
    overlay.querySelector("#cb-filter-region").addEventListener("change", (e) => {
      filters.region = e.target.value;
      debouncedFilter();
    });
    overlay.querySelector("#cb-filter-viewers").addEventListener("change", (e) => {
      filters.minViewers = parseInt(e.target.value) || 0;
      debouncedFilter();
    });
    overlay.querySelector("#cb-filter-age").addEventListener("change", (e) => {
      filters.minAge = parseInt(e.target.value) || 0;
      debouncedFilter();
    });
    overlay.querySelector("#cb-filter-new").addEventListener("change", (e) => {
      filters.newOnly = e.target.checked;
      debouncedFilter();
    });
    updateFiltersVisibility();

    // Load more
    overlay.querySelector("#cb-more-btn").addEventListener("click", () => {
      currentPage++;
      currentCam4Page++;
      fetchRooms(true);
    });

    // Infinite scroll
    const body = overlay.querySelector("#cb-body");
    body.addEventListener("scroll", () => {
      if (isLoading) return;
      const { scrollTop, scrollHeight, clientHeight } = body;
      if (scrollTop + clientHeight >= scrollHeight - 400) {
        const grid = document.getElementById("cb-grid");
        if (grid && grid.children.length < totalRooms) {
          currentPage++;
          currentCam4Page++;
          fetchRooms(true);
        }
      }
    });
  }

  async function doLogin(overlay) {
    const username = overlay.querySelector("#cb-creds-user").value.trim();
    const password = overlay.querySelector("#cb-creds-pass").value;
    if (!username || !password) {
      showSaveStatus("Fill in both fields", "error");
      return;
    }

    const loginBtn = overlay.querySelector("#cb-creds-login");
    const statusEl = overlay.querySelector("#cb-login-status");
    const msgEl = overlay.querySelector("#cb-login-msg");
    loginBtn.disabled = true;
    loginBtn.textContent = "Connecting\u2026";
    statusEl.style.display = "flex";
    msgEl.textContent = "A browser window will open briefly for authentication\u2026";
    overlay.querySelector("#cb-save-status").textContent = "";

    try {
      const result = await runPlugin({ action: "login", username, password });
      const parsed = typeof result === "string" ? JSON.parse(result) : (result || {});

      if (parsed.sessionid) {
        cbSession = { connected: true, username };
        statusEl.style.display = "none";
        loginBtn.disabled = false;
        loginBtn.textContent = "Log in";
        showSaveStatus("\u2713 Connected!", "ok-persist");
        overlay.querySelector("#cb-creds-clear").style.display = "";
        overlay.querySelector("#cb-creds-pass").value = "";
        const followsTab = overlay.querySelector('[data-gender="follows"]');
        if (followsTab) followsTab.innerHTML = '<span class="cb-tab-heart">\u2665</span> Following';
        overlay.querySelectorAll(".cb-tab").forEach(t => t.classList.remove("active"));
        if (followsTab) followsTab.classList.add("active");
        currentGender = "follows";
        currentPage = 1;
        setHashTab("follows");
        closeSettings();
        fetchRooms();
      } else {
        const err = parsed.error || "Login failed";
        statusEl.style.display = "none";
        loginBtn.disabled = false;
        loginBtn.textContent = "Log in";
        showSaveStatus(err, "error");
      }
    } catch (e) {
      statusEl.style.display = "none";
      loginBtn.disabled = false;
      loginBtn.textContent = "Log in";
      showSaveStatus("Error: " + e.message, "error");
    }
  }

  // --- Filters ---

  function resetFilters() {
    filters = { search: "", region: "", tags: [], newOnly: false, minViewers: 0, minAge: 0, genders: [] };
    const overlay = document.getElementById("cb-overlay");
    if (!overlay) return;
    const s = overlay.querySelector("#cb-filter-search"); if (s) s.value = "";
    const r = overlay.querySelector("#cb-filter-region"); if (r) r.value = "";
    const v = overlay.querySelector("#cb-filter-viewers"); if (v) v.value = "0";
    const a = overlay.querySelector("#cb-filter-age"); if (a) a.value = "0";
    const n = overlay.querySelector("#cb-filter-new"); if (n) n.checked = false;
    const tags = overlay.querySelector("#cb-filters-tags"); if (tags) tags.innerHTML = "";
    overlay.querySelectorAll(".cb-gender-pill").forEach(p => p.classList.remove("active"));
  }

  function updateFiltersVisibility() {
    const bar = document.getElementById("cb-filters");
    if (!bar) return;
    bar.style.display = currentGender !== "follows" ? "" : "none";
  }

  function applyFiltersToGrid() {
    const grid = document.getElementById("cb-grid");
    if (!grid) return;
    const cards = grid.querySelectorAll(".cb-card");
    let visible = 0;
    cards.forEach(card => {
      const show = cardMatchesFilters(card);
      card.style.display = show ? "" : "none";
      if (show) visible++;
    });
    let emptyMsg = grid.querySelector(".cb-filter-empty");
    if (visible === 0 && cards.length > 0) {
      if (!emptyMsg) {
        emptyMsg = document.createElement("div");
        emptyMsg.className = "cb-filter-empty cb-empty";
        emptyMsg.textContent = "No results for these filters.";
        grid.appendChild(emptyMsg);
      }
      emptyMsg.style.display = "";
    } else if (emptyMsg) {
      emptyMsg.style.display = "none";
    }
  }

  function cardMatchesFilters(card) {
    const username = (card.dataset.username || "").toLowerCase();
    const nameEl = card.querySelector(".cb-card-name");
    const subjectEl = card.querySelector(".cb-card-subject");
    const name = nameEl ? nameEl.textContent.toLowerCase() : "";
    const subject = subjectEl ? subjectEl.textContent.toLowerCase() : "";
    const tagsEls = card.querySelectorAll(".cb-tag");
    const cardTags = [...tagsEls].map(t => t.textContent.toLowerCase());

    if (filters.search) {
      const q = filters.search;
      const match = username.includes(q) || name.includes(q) || subject.includes(q) || cardTags.some(t => t.includes(q));
      if (!match) return false;
    }
    if (filters.newOnly && !card.querySelector(".cb-card-new")) return false;
    if (filters.minViewers > 0) {
      const viewerEl = card.querySelector(".cb-card-viewers");
      if (viewerEl) {
        const text = viewerEl.textContent.replace(/[^0-9.k]/g, "");
        let count = text.includes("k") ? parseFloat(text) * 1000 : (parseInt(text) || 0);
        if (count < filters.minViewers) return false;
      } else return false;
    }
    if (filters.minAge > 0) {
      const ageEl = card.querySelector(".cb-card-age");
      if (ageEl) { if ((parseInt(ageEl.textContent) || 0) < filters.minAge) return false; }
      else return false;
    }
    if (filters.tags.length > 0) {
      if (!filters.tags.some(t => cardTags.includes(t))) return false;
    }
    if (filters.region) {
      const country = (card.dataset.country || "").toLowerCase();
      if (!matchesRegion(country, filters.region)) return false;
    }
    if (filters.genders.length > 0) {
      const g = (card.dataset.gender || "").toLowerCase();
      if (!filters.genders.includes(g)) return false;
    }
    return true;
  }

  function matchesRegion(country, region) {
    const regions = {
      "North America": ["usa", "us", "united states", "canada", "mexico", "florida", "california", "new york", "texas", "colorado", "nevada", "ohio", "michigan", "illinois", "arizona", "georgia", "washington", "oregon", "virginia", "north carolina", "pennsylvania", "tennessee", "minnesota", "indiana", "wisconsin", "missouri", "maryland", "massachusetts", "connecticut", "iowa", "kansas", "louisiana", "oklahoma", "kentucky", "alabama", "mississippi", "arkansas", "utah", "nebraska", "montana", "idaho", "wyoming", "maine", "south carolina", "west virginia", "new hampshire", "vermont", "rhode island", "delaware", "south dakota", "north dakota", "hawaii", "alaska", "new jersey", "new mexico"],
      "South America": ["brazil", "colombia", "argentina", "chile", "peru", "venezuela", "ecuador", "bolivia", "uruguay", "paraguay"],
      "Europe": ["uk", "united kingdom", "england", "france", "germany", "spain", "italy", "netherlands", "poland", "romania", "czech", "portugal", "sweden", "norway", "denmark", "finland", "belgium", "austria", "switzerland", "ireland", "greece", "hungary", "croatia", "ukraine", "russia", "serbia", "lithuania", "latvia", "estonia", "slovakia", "slovenia", "bulgaria"],
      "Asia": ["japan", "china", "korea", "india", "thailand", "philippines", "indonesia", "malaysia", "vietnam", "taiwan", "singapore", "hong kong"],
    };
    const list = regions[region];
    if (!list) return true;
    return list.some(r => country.includes(r));
  }

  function collectPopularTags() {
    const grid = document.getElementById("cb-grid");
    if (!grid) return;
    const tagCount = {};
    grid.querySelectorAll(".cb-tag").forEach(el => {
      const t = el.textContent.toLowerCase();
      tagCount[t] = (tagCount[t] || 0) + 1;
    });
    const sorted = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 15);
    const container = document.getElementById("cb-filters-tags");
    if (!container) return;
    container.innerHTML = "";
    for (const [tag] of sorted) {
      const btn = document.createElement("button");
      btn.className = "cb-filter-tag-btn";
      btn.textContent = tag;
      btn.addEventListener("click", () => {
        const idx = filters.tags.indexOf(tag);
        if (idx >= 0) { filters.tags.splice(idx, 1); btn.classList.remove("active"); }
        else { filters.tags.push(tag); btn.classList.add("active"); }
        applyFiltersToGrid();
      });
      container.appendChild(btn);
    }
  }

  // --- Data ---

  function interleaveRooms(cbRooms, cam4Rooms) {
    const result = [];
    const maxLen = Math.max(cbRooms.length, cam4Rooms.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < cbRooms.length) result.push(cbRooms[i]);
      if (i < cam4Rooms.length) result.push(cam4Rooms[i]);
    }
    return result;
  }

  async function fetchRooms(append) {
    if (isLoading) return;
    isLoading = true;
    const grid = document.getElementById("cb-grid");
    const loadMore = document.getElementById("cb-load-more");
    if (!grid) return;

    if (!append) {
      grid.innerHTML = '<div class="cb-loading"><span class="cb-spin"></span>Loading...</div>';
    }

    try {
      let rooms, total;

      if (currentGender === "follows") {
        if (!cbSession.connected) {
          grid.innerHTML = `
            <div class="cb-empty cb-empty-creds">
              <div class="cb-empty-icon">\uD83D\uDD12</div>
              <div class="cb-empty-title">Login required</div>
              <div class="cb-empty-sub">Set up your account to see your follows.</div>
              <button class="cb-more-btn" id="cb-empty-settings-btn" style="margin-top:16px">\u2699 Log in</button>
            </div>`;
          const btn = grid.querySelector("#cb-empty-settings-btn");
          if (btn) btn.addEventListener("click", openSettings);
          if (loadMore) loadMore.style.display = "none";
          isLoading = false;
          return;
        }

        const result = await runPlugin({ action: "fetch_follows", page: currentPage, page_size: 60 });
        const parsed = typeof result === "string" ? JSON.parse(result) : (result || {});
        rooms = (parsed.rooms || []).map(r => ({ ...r, site: "chaturbate" }));
        total = parsed.total || 0;

        if (parsed.error) {
          if (!append) {
            const isAuth = parsed.error.includes("Session") || parsed.error.includes("expir") || parsed.error.includes("invalid");
            grid.innerHTML = `
              <div class="cb-empty cb-empty-creds">
                <div class="cb-empty-icon">\u26A0\uFE0F</div>
                <div class="cb-empty-title">${isAuth ? "Session expired" : "Error"}</div>
                <div class="cb-empty-sub">${escapeHtml(parsed.error)}</div>
                <button class="cb-more-btn" id="cb-empty-relogin" style="margin-top:16px">\u2699 ${isAuth ? "Reconnect" : "Settings"}</button>
              </div>`;
            if (isAuth) cbSession.connected = false;
            const btn = grid.querySelector("#cb-empty-relogin");
            if (btn) btn.addEventListener("click", openSettings);
          }
          isLoading = false;
          return;
        }

      } else {
        // Fetch from both Chaturbate and Cam4 in parallel
        const [cbResult, cam4Result] = await Promise.all([
          runPlugin({ action: "fetch_rooms", gender: currentGender, page: currentPage, page_size: 30 }),
          runPlugin({ action: "fetch_cam4_rooms", gender: currentGender, page: currentCam4Page, page_size: 30 }).catch(() => ({ rooms: [], total: 0 })),
        ]);

        const cbParsed = typeof cbResult === "string" ? JSON.parse(cbResult) : (cbResult || {});
        const cam4Parsed = typeof cam4Result === "string" ? JSON.parse(cam4Result) : (cam4Result || {});

        const cbRooms = (cbParsed.rooms || []).map(r => ({ ...r, site: "chaturbate" }));
        const cam4Rooms = (cam4Parsed.rooms || []).map(r => ({ ...r, site: "cam4" }));

        rooms = interleaveRooms(cbRooms, cam4Rooms);
        total = (cbParsed.total || 0) + (cam4Parsed.total || 0);

        if (cbParsed.error && cam4Parsed.error) {
          if (!append) grid.innerHTML = `<div class="cb-empty">Error: ${escapeHtml(cbParsed.error)}</div>`;
          isLoading = false;
          return;
        }
      }

      totalRooms = total;
      if (!append) grid.innerHTML = "";

      if (rooms.length === 0 && !append) {
        grid.innerHTML = '<div class="cb-empty">No live streams found.</div>';
        if (loadMore) loadMore.style.display = "none";
        isLoading = false;
        return;
      }

      // For follows tab, split into online/offline sections
      if (currentGender === "follows" && !append) {
        grid.classList.add("cb-grid-sections");
        const online = rooms.filter(r => r.is_online !== false);
        const offline = rooms.filter(r => r.is_online === false);

        if (online.length > 0) {
          const header = document.createElement("div");
          header.className = "cb-section-header";
          header.innerHTML = `<span class="cb-section-dot cb-dot-live"></span> Live <span class="cb-section-count">${online.length}</span>`;
          grid.appendChild(header);
          const onlineGrid = document.createElement("div");
          onlineGrid.className = "cb-grid cb-section-grid";
          for (const room of online) onlineGrid.appendChild(createCard(room));
          grid.appendChild(onlineGrid);
        }

        if (offline.length > 0) {
          const header = document.createElement("div");
          header.className = "cb-section-header";
          header.innerHTML = `<span class="cb-section-dot cb-dot-off"></span> Offline <span class="cb-section-count">${offline.length}</span>`;
          grid.appendChild(header);
          const offlineGrid = document.createElement("div");
          offlineGrid.className = "cb-grid cb-section-grid";
          for (const room of offline) offlineGrid.appendChild(createCard(room));
          grid.appendChild(offlineGrid);
        }
      } else {
        grid.classList.remove("cb-grid-sections");
        for (const room of rooms) grid.appendChild(createCard(room));
      }

      if (!append && currentGender !== "follows") collectPopularTags();
      applyFiltersToGrid();

      if (loadMore) {
        loadMore.style.display = grid.children.length < totalRooms ? "" : "none";
      }
    } catch (e) {
      if (!append) grid.innerHTML = `<div class="cb-empty">Error: ${escapeHtml(e.message)}</div>`;
    }

    isLoading = false;
  }

  function createCard(room) {
    const card = document.createElement("div");
    const isOffline = room.is_online === false;
    card.className = "cb-card" + (isOffline ? " cb-card-offline" : "");
    card.dataset.username = room.username;
    card.dataset.country = (room.country || "").toLowerCase();
    card.dataset.site = room.site || "chaturbate";
    card.dataset.gender = room.gender || "";

    const thumb = room.img_url || `https://roomimg.stream.highwebmedia.com/ri/${room.username}.jpg`;
    const viewers = room.viewers ? formatViewers(room.viewers) : "";
    const duration = formatDuration(room.seconds_online);
    const tags = (room.tags || []).slice(0, 3).map((t) => `<span class="cb-tag">${escapeHtml(t)}</span>`).join("");

    const siteBadge = room.site === "cam4"
      ? '<div class="cb-site-badge cb-site-cam4">C4</div>'
      : '<div class="cb-site-badge cb-site-cb">CB</div>';

    card.innerHTML = `
      <div class="cb-card-img">
        <img src="${escapeHtml(thumb)}" alt="${escapeHtml(room.username)}" loading="lazy"
          onerror="this.onerror=null;this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22320%22 height=%22180%22><rect fill=%22%23111%22 width=%22320%22 height=%22180%22/><text fill=%22%23444%22 x=%22160%22 y=%2295%22 text-anchor=%22middle%22 font-size=%2214%22>${escapeHtml(room.display_name || room.username)}</text></svg>'" />
        ${isOffline ? '<div class="cb-card-offline-badge">OFFLINE</div>' : '<div class="cb-card-live">LIVE</div>'}
        ${siteBadge}
        ${viewers ? `<div class="cb-card-viewers">${viewers}</div>` : ""}
        ${room.is_hd ? '<div class="cb-card-hd">HD</div>' : ""}
        ${room.is_new ? '<div class="cb-card-new">NEW</div>' : ""}
        ${duration ? `<div class="cb-card-time">${duration}</div>` : ""}
      </div>
      <div class="cb-card-body">
        <div class="cb-card-name">${escapeHtml(room.display_name || room.username)}${room.age ? ` <span class="cb-card-age">${room.age}</span>` : ""}</div>
        <div class="cb-card-subject">${escapeHtml(room.subject || "")}</div>
        ${tags ? `<div class="cb-card-tags">${tags}</div>` : ""}
      </div>
    `;

    card.addEventListener("click", () => {
      if (isOffline) return;
      openPlayer(room);
    });

    return card;
  }

  // --- Player ---

  function setupPlayerFollowBtn(username, site) {
    const btn = document.getElementById("cb-player-follow");
    if (!btn) return;

    if (site === "cam4") { btn.style.display = "none"; return; }

    btn.textContent = "\u2026";
    btn.disabled = true;
    btn.className = "cb-player-follow-btn";
    btn._username = username;

    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.id = "cb-player-follow";
    newBtn._username = username;

    if (!cbSession.connected) { newBtn.style.display = "none"; return; }
    newBtn.style.display = "";

    runPlugin({ action: "check_follow", username }).then(res => {
      const parsed = typeof res === "string" ? JSON.parse(res) : (res || {});
      if (newBtn._username !== username) return;
      if (parsed.following) {
        newBtn.textContent = "\u2665 Following";
        newBtn.classList.add("cb-pfb-followed");
      } else {
        newBtn.textContent = "\u2661 Follow";
        newBtn.classList.remove("cb-pfb-followed");
      }
      newBtn.disabled = false;
    }).catch(() => { newBtn.style.display = "none"; });

    newBtn.addEventListener("click", async () => {
      const isFollowed = newBtn.classList.contains("cb-pfb-followed");
      const action = isFollowed ? "unfollow" : "follow";
      newBtn.disabled = true;
      newBtn.textContent = "\u2026";
      try {
        const res = await runPlugin({ action: "toggle_follow", username: newBtn._username, follow_action: action });
        const parsed = typeof res === "string" ? JSON.parse(res) : (res || {});
        if (parsed.following !== undefined) {
          if (parsed.following) { newBtn.textContent = "\u2665 Following"; newBtn.classList.add("cb-pfb-followed"); }
          else { newBtn.textContent = "\u2661 Follow"; newBtn.classList.remove("cb-pfb-followed"); }
        }
      } catch {}
      newBtn.disabled = false;
    });
  }

  // --- Volume persistence ---

  function loadVolume(username) {
    try { const data = JSON.parse(localStorage.getItem("cb_volumes") || "{}"); return data[username] !== undefined ? data[username] : null; }
    catch { return null; }
  }

  function saveVolume(username, volume) {
    try { const data = JSON.parse(localStorage.getItem("cb_volumes") || "{}"); data[username] = Math.round(volume * 100) / 100; localStorage.setItem("cb_volumes", JSON.stringify(data)); }
    catch {}
  }

  async function openPlayer(room) {
    await loadHls();

    const pov = document.getElementById("cb-player-overlay");
    const video = document.getElementById("cb-player-video");
    const loading = document.getElementById("cb-player-loading");
    if (!pov || !video) return;

    document.getElementById("cb-player-name").textContent = room.display_name || room.username;
    document.getElementById("cb-player-viewers").textContent = room.viewers ? formatViewers(room.viewers) + " viewers" : "";
    document.getElementById("cb-player-subject").textContent = room.subject || "";

    const extLink = document.getElementById("cb-player-ext");
    extLink.href = room.site === "cam4" ? `https://www.cam4.com/${room.username}` : `https://chaturbate.com/${room.username}`;

    setupPlayerFollowBtn(room.username, room.site);

    const savedVol = loadVolume(room.username);
    if (savedVol !== null) video.volume = savedVol;
    video._cbUsername = room.username;
    video.onvolumechange = () => { if (video._cbUsername) saveVolume(video._cbUsername, video.volume); };

    pov.style.display = "";
    loading.style.display = "";
    loading.innerHTML = '<span class="cb-spin"></span>';

    let hlsSource = room.hls_source;
    if (!hlsSource) {
      try {
        const action = room.site === "cam4" ? "cam4_get_stream" : "get_stream";
        const res = await runPlugin({ action, username: room.username });
        const parsed = typeof res === "string" ? JSON.parse(res) : (res || {});
        hlsSource = parsed.hls_source || "";
      } catch {}
    }

    if (!hlsSource) {
      loading.innerHTML = '<div class="cb-player-err">Stream unavailable</div>';
      return;
    }

    loading.style.display = "none";

    if (typeof Hls !== "undefined" && Hls.isSupported()) {
      hlsPlayer = new Hls({ maxBufferLength: 10, maxMaxBufferLength: 30, liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 6 });
      hlsPlayer.loadSource(hlsSource);
      hlsPlayer.attachMedia(video);
      hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
      hlsPlayer.on(Hls.Events.ERROR, (_, d) => { if (d.fatal && d.type === Hls.ErrorTypes.NETWORK_ERROR) hlsPlayer.startLoad(); });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = hlsSource;
      video.addEventListener("loadedmetadata", () => video.play().catch(() => {}), { once: true });
    } else {
      loading.style.display = "";
      loading.innerHTML = '<div class="cb-player-err">HLS not supported by this browser</div>';
    }
  }

  function closePlayer() {
    if (hlsPlayer) { hlsPlayer.destroy(); hlsPlayer = null; }
    const video = document.getElementById("cb-player-video");
    if (video) { video.pause(); video.removeAttribute("src"); video.load(); }
    const pov = document.getElementById("cb-player-overlay");
    if (pov) pov.style.display = "none";
  }

  // --- Thumbnail auto-refresh ---

  function startThumbRefresh() { stopThumbRefresh(); thumbRefreshInterval = setInterval(refreshThumbnails, 5000); }
  function stopThumbRefresh() { if (thumbRefreshInterval) { clearInterval(thumbRefreshInterval); thumbRefreshInterval = null; } }

  function refreshThumbnails() {
    const overlay = document.getElementById("cb-overlay");
    if (!overlay) return;
    const t = Date.now();
    overlay.querySelectorAll(".cb-card:not(.cb-card-offline) .cb-card-img img").forEach(img => {
      const src = img.src;
      if (!src || src.startsWith("data:")) return;
      const base = src.replace(/[?&]_cb=\d+/, "");
      img.src = base + (base.includes("?") ? "&" : "?") + "_cb=" + t;
    });
  }

  // --- Init ---

  function isChaturbateRoute() { return window.location.hash.startsWith("#/plugin/P-StreamRec"); }

  function getTabFromHash() {
    const hash = window.location.hash;
    const parts = hash.replace("#/plugin/P-StreamRec", "").replace(/^\//, "").split("/");
    return parts[0] || "f";
  }

  function setHashTab(tab) {
    const newHash = "#/plugin/P-StreamRec/" + tab;
    if (window.location.hash !== newHash) history.replaceState(null, "", newHash);
  }

  function handleRoute() {
    if (isChaturbateRoute()) { if (!isPageActive) openPage(getTabFromHash()); }
    else { if (isPageActive) closePage(); }
  }

  function init() {
    if (typeof csLib === "undefined") { setTimeout(init, 200); return; }
    function tryInject() {
      injectNavTab();
      if (!document.getElementById("cb-nav-link")) csLib.waitForElement(".navbar-nav", () => injectNavTab());
    }
    tryInject();
    window.addEventListener("hashchange", () => { setTimeout(tryInject, 100); handleRoute(); });
    PluginApi.Event.addEventListener("stash:location", () => { setTimeout(tryInject, 300); handleRoute(); });
    handleRoute();
  }

  init();
})();
