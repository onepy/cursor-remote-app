// MagpieBoard dashboard tab, ported from magpie-board-android (MIT).
// Data comes from the relay's /api/magpie/* (forwarded to Magpie on this computer), never straight from the phone.
(function () {
  "use strict";

  const SETTINGS_PREFIX = "cr-magpie-";
  const settingsStore = {
    get(name, fallback) {
      const stored = localStorage.getItem(SETTINGS_PREFIX + name);
      return stored === null ? fallback : stored;
    },
    set(name, value) { localStorage.setItem(SETTINGS_PREFIX + name, String(value)); },
  };

  // Set by mount(): relayRequest(path) -> fetch Response from the relay (device token attached), notify(text, ok) -> status line.
  let relayRequest = null;
  let notify = () => {};

  // The dashboard renders gateway data through innerHTML, and this page holds the device token,
  // so every string from the gateway (values and object keys) is HTML-escaped before rendering.
  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  }
  function escapeDeep(value) {
    if (typeof value === "string") return escapeHtml(value);
    if (Array.isArray(value)) return value.map(escapeDeep);
    if (value && typeof value === "object") {
      const escapedObject = {};
      for (const [key, inner] of Object.entries(value)) escapedObject[escapeHtml(key)] = escapeDeep(inner);
      return escapedObject;
    }
    return value;
  }

  // State Management
  const AppState = {
    currentTab: "quotas",
    currentPeriod: "today",
    settings: {
      autoRefresh: 30000,
      redactEmail: true
    },
    timerId: null,
    isRefreshing: false,
    initialized: false,
    selectedDecisionIndex: 0,
    showFullCatalog: false,
    selectedProviderFilter: "all",
    searchQuery: "",
    onlyErrors: false,
    cachedData: {
      gatewayInfo: null,
      quotas: null,
      usage: null,
      models: null,
      requests: null
    }
  };

  // Helper Utilities
  function formatNumber(num) {
    if (num == null || isNaN(num)) return "0";
    if (num >= 1e9) return (num / 1e9).toFixed(2) + "B";
    if (num >= 1e6) return (num / 1e6).toFixed(2) + "M";
    if (num >= 1e3) return (num / 1e3).toFixed(1) + "k";
    return Number(num).toLocaleString();
  }

  function formatCost(val) {
    const num = Number(val || 0);
    return "$" + num.toFixed(2);
  }

  function maskEmail(email) {
    if (!email) return "";
    if (!AppState.settings.redactEmail) return email;
    const parts = email.split("@");
    if (parts.length !== 2) return email;
    const name = parts[0];
    const domain = parts[1];
    if (name.length <= 3) return name[0] + "***@" + domain;
    return name.slice(0, 3) + "***" + name.slice(-2) + "@" + domain;
  }

  function formatRelativeTime(dateStr) {
    if (!dateStr) return "--";
    const now = Date.now();
    const target = new Date(dateStr).getTime();
    const diff = target - now;
    if (isNaN(diff)) return dateStr;

    if (diff <= 0) return "已重置";
    const secs = Math.floor(diff / 1000);
    const mins = Math.floor(secs / 60);
    const hours = Math.floor(mins / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}天 ${hours % 24}小时后重置`;
    if (hours > 0) return `${hours}小时 ${mins % 60}分钟后重置`;
    if (mins > 0) return `${mins}分钟后重置`;
    return `${secs}秒后重置`;
  }

  function formatPastTime(dateStr) {
    if (!dateStr) return "";
    const now = Date.now();
    const past = new Date(dateStr).getTime();
    const diff = now - past;
    if (isNaN(diff) || diff < 0) {
      return (dateStr.split("T")[1] || "").split(".")[0];
    }
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(mins / 60);
    if (mins < 1) return "刚刚";
    if (mins < 60) return `${mins}分钟前`;
    if (hours < 24) return `${hours}小时前`;
    return dateStr.split("T")[0];
  }

  function getToneClass(percent) {
    if (percent == null) return "jade";
    if (percent <= 10) return "crimson";
    if (percent <= 30) return "amber";
    return "jade";
  }

  // Provider Icons (SVGs inline)
  const ProviderSVGs = {
    codex: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 14.5h-2v-2h2zm0-4h-2V7h2z"/></svg>`,
    antigravity: `<svg viewBox="0 0 24 24" fill="#3B82F6"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="12" cy="12" r="4" fill="currentColor"/></svg>`,
    claude: `<svg viewBox="0 0 24 24" fill="#D97706"><path d="M12 2L15 9H9l3-7zm0 20l-3-7h6l-3 7zM2 12l7-3v6l-7-3zm20 0l-7 3V9l7 3z"/></svg>`,
    deepseek: `<svg viewBox="0 0 24 24" fill="#0284C7"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9v-2h2v2zm0-4H9V8h2v4zm4 4h-2v-6h2v6z"/></svg>`,
    openrouter: `<svg viewBox="0 0 24 24" fill="#6366F1"><circle cx="6" cy="12" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8.5 10.8l7-3.6m-7 6l7 3.6" stroke="currentColor" stroke-width="1.8"/></svg>`,
    generic: `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/></svg>`
  };

  function getProviderIcon(provider) {
    const p = (provider || "").toLowerCase();
    if (p.includes("codex")) return ProviderSVGs.codex;
    if (p.includes("antigravity")) return ProviderSVGs.antigravity;
    if (p.includes("claude") || p.includes("anthropic")) return ProviderSVGs.claude;
    if (p.includes("deepseek")) return ProviderSVGs.deepseek;
    if (p.includes("openrouter")) return ProviderSVGs.openrouter;
    return ProviderSVGs.generic;
  }

  // Core App Object
  const app = {
    init() {
      this.loadSettings();
      this.bindEvents();
      AppState.initialized = true;
    },

    loadSettings() {
      const autoRefresh = parseInt(settingsStore.get("autorefresh", "30000"), 10);
      AppState.settings.autoRefresh = Number.isFinite(autoRefresh) ? autoRefresh : 30000;
      AppState.settings.redactEmail = settingsStore.get("redact-email", "true") !== "false";
    },

    bindEvents() {
      const root = document.getElementById("magpieView");

      root.querySelectorAll(".tab-btn").forEach(btn => {
        btn.addEventListener("click", () => this.switchTab(btn.getAttribute("data-tab")));
      });

      root.querySelectorAll(".period-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          root.querySelectorAll(".period-btn").forEach(other => other.classList.remove("active"));
          btn.classList.add("active");
          AppState.currentPeriod = btn.getAttribute("data-period");
          this.fetchUsage();
        });
      });

      document.getElementById("btnRefresh").addEventListener("click", () => this.refreshAll(true));
      document.getElementById("btnSettings").addEventListener("click", () => this.openSettings());
      document.getElementById("btnSaveConfig").addEventListener("click", () => this.saveSettings());
      document.getElementById("btnCloseSettings").addEventListener("click", () => this.closeSettings());

      const searchInput = document.getElementById("modelSearchInput");
      searchInput.addEventListener("input", (event) => {
        AppState.searchQuery = event.target.value.trim().toLowerCase();
        this.renderRouting();
      });

      const btnErrors = document.getElementById("btnToggleOnlyErrors");
      btnErrors.addEventListener("click", () => {
        AppState.onlyErrors = !AppState.onlyErrors;
        btnErrors.classList.toggle("active", AppState.onlyErrors);
        this.renderRequests();
      });

      // Buttons rendered later (e.g. "retry") carry data-magpie-act instead of inline handlers.
      root.addEventListener("click", (event) => {
        const actionButton = event.target.closest("[data-magpie-act]");
        if (actionButton && actionButton.dataset.magpieAct === "retryQuotas") this.fetchQuotas();
      });

      const settingsModal = document.getElementById("settingsModal");
      settingsModal.addEventListener("click", (event) => {
        if (event.target === settingsModal) this.closeSettings();
      });
    },

    switchTab(tabName) {
      AppState.currentTab = tabName;
      const root = document.getElementById("magpieView");
      root.querySelectorAll(".tab-btn").forEach(btn => {
        btn.classList.toggle("active", btn.getAttribute("data-tab") === tabName);
      });
      root.querySelectorAll(".tab-view").forEach(view => {
        view.style.display = view.id === `view-${tabName}` ? "block" : "none";
      });

      if (tabName === "quotas" && !AppState.cachedData.quotas) {
        this.fetchQuotas();
      } else if (tabName === "usage" && !AppState.cachedData.usage) {
        this.fetchUsage();
      } else if (tabName === "routing") {
        this.fetchRouting();
      } else if (tabName === "requests") {
        // The routing tab also fills cachedData.requests without rendering this list, so render from cache when present.
        if (AppState.cachedData.requests) this.renderRequests();
        else this.fetchRequests();
      }
    },

    setupAutoRefresh() {
      this.stopAutoRefresh();
      if (AppState.settings.autoRefresh > 0) {
        AppState.timerId = setInterval(() => {
          if (!AppState.isRefreshing) this.refreshAll(false);
        }, AppState.settings.autoRefresh);
      }
    },

    stopAutoRefresh() {
      if (AppState.timerId) {
        clearInterval(AppState.timerId);
        AppState.timerId = null;
      }
    },

    setConnectionStatus(status, text) {
      const dot = document.getElementById("statusDot");
      const banner = document.getElementById("connectionBanner");
      const bannerText = document.getElementById("bannerText");
      const statusLabel = document.getElementById("profileName");

      dot.className = "status-dot " + status;
      statusLabel.textContent = status === "connected" ? "本机网关" : status === "error" ? "连接失败" : "连接中...";
      if (status === "error") {
        banner.style.display = "block";
        bannerText.textContent = text || "连不上 Magpie 网关，请确认电脑上的 Magpie 正在运行。";
      } else {
        banner.style.display = "none";
      }
    },

    // Same response shape the original Bridge.request returned: { status, ok, data }. Strings in data are HTML-escaped.
    async makeApiCall(path) {
      if (!relayRequest) throw new Error("还没有连上电脑");
      const response = await relayRequest("/api/magpie" + path);
      const text = await response.text();
      let data = null;
      try { data = JSON.parse(text); } catch (error) { data = text; }
      if (!response.ok && data && typeof data.error === "string") {
        throw new Error(data.error);
      }
      return { status: response.status, ok: response.ok, data: escapeDeep(data) };
    },

    async refreshAll(isManual = false) {
      if (AppState.isRefreshing) return;
      AppState.isRefreshing = true;

      const btnRefresh = document.getElementById("btnRefresh");
      if (btnRefresh) btnRefresh.classList.add("spinning");
      this.setConnectionStatus("connecting");

      try {
        // Fetch basic gateway info
        const infoRes = await this.makeApiCall("/");
        if (infoRes.ok && infoRes.data) {
          AppState.cachedData.gatewayInfo = infoRes.data;
          if (infoRes.data.version) {
            document.getElementById("magpieVersion").textContent = `v${infoRes.data.version}`;
          }
        }

        // Fetch current active tab data
        if (AppState.currentTab === "quotas") {
          await this.fetchQuotas();
        } else if (AppState.currentTab === "usage") {
          await this.fetchUsage();
        } else if (AppState.currentTab === "routing") {
          await this.fetchRouting();
        } else if (AppState.currentTab === "requests") {
          await this.fetchRequests();
        }

        this.setConnectionStatus("connected");
        if (isManual) notify("数据已更新");
      } catch (err) {
        console.error("Refresh failed:", err);
        this.setConnectionStatus("error", `连接失败: ${err.message}`);
        if (isManual) notify("网关连接失败: " + err.message);
      } finally {
        AppState.isRefreshing = false;
        if (btnRefresh) btnRefresh.classList.remove("spinning");
      }
    },

    // 1. Quotas Module
    async fetchQuotas() {
      try {
        const res = await this.makeApiCall("/v1/magpie/quotas");
        if (res.ok && res.data) {
          const list = Array.isArray(res.data) ? res.data : (res.data.data || []);
          AppState.cachedData.quotas = list;
          this.renderQuotas(list);
        } else {
          throw new Error(res.data?.error?.message || `HTTP ${res.status}`);
        }
      } catch (err) {
        console.error("fetchQuotas error:", err);
        this.renderQuotasError(err.message);
      }
    },

    renderQuotas(quotas) {
      const container = document.getElementById("quotasList");
      if (!container) return;
      container.innerHTML = "";

      if (!quotas || quotas.length === 0) {
        container.innerHTML = `
          <div class="state-box">
            <div class="state-title">未发现配额卡片</div>
            <div class="state-desc">当前网关暂无已配置的订阅账号或受限 Key 配额。</div>
          </div>
        `;
        document.getElementById("statTotalAccounts").textContent = "0";
        document.getElementById("statActiveSubs").textContent = "0";
        document.getElementById("statTotalBalance").textContent = "--";
        return;
      }

      let totalAccounts = quotas.length;
      let activeSubs = 0;
      let balanceSum = 0;
      let balanceCurrency = "$";

      quotas.forEach(item => {
        const provider = item.provider || "magpie";
        const name = item.name || provider;
        const plan = item.plan || (item.kind === "subscription" ? "订阅套餐" : "按量钱包");
        const user = item.user || "";
        const windows = item.windows || [];
        const isSub = item.kind === "subscription" || windows.length > 0;

        if (isSub) activeSubs++;

        if (item.balance) {
          const match = String(item.balance).match(/([¥$€£]?)\s*([\d.]+)/);
          if (match) {
            balanceCurrency = match[1] || balanceCurrency;
            balanceSum += parseFloat(match[2]) || 0;
          }
        }

        const card = document.createElement("div");
        card.className = "quota-card";

        const iconSvg = getProviderIcon(provider);
        const planBadgeClass = isSub ? "badge plan-plus" : "badge plan-balance";

        let html = `
          <div class="quota-card-header">
            <div class="provider-info">
              <div class="provider-avatar">${iconSvg}</div>
              <div class="provider-text">
                <div class="name">${name}</div>
                <div class="user">${maskEmail(user)}</div>
              </div>
            </div>
            <span class="${planBadgeClass}">${plan}</span>
          </div>
        `;

        // Render subscription windows (5 hours, 7 days, etc.)
        if (windows && windows.length > 0) {
          html += `<div class="quota-windows">`;
          windows.forEach(win => {
            const winName = win.name || "配额窗口";
            let used = win.used != null ? Number(win.used) : 0;
            let remaining = win.remaining != null ? Number(win.remaining) : (100 - used);
            if (remaining < 0) remaining = 0;
            if (remaining > 100) remaining = 100;

            const tone = getToneClass(remaining);
            const resetsAt = win.resetsAt ? formatRelativeTime(win.resetsAt) : (win.display || "正常运行中");

            html += `
              <div class="quota-window-item">
                <div class="window-header">
                  <span class="window-name">${winName}</span>
                  <span class="window-percent ${tone}">剩余 ${Math.round(remaining)}%</span>
                </div>
                <div class="progress-track">
                  <div class="progress-bar ${tone}" style="width: ${remaining}%;"></div>
                </div>
                <div class="window-footer">
                  <span>已用 ${Math.round(used)}%</span>
                  <span class="reset-time">${resetsAt}</span>
                </div>
              </div>
            `;
          });
          html += `</div>`;
        }

        // Render wallet balance
        if (item.balance) {
          let splitHtml = "";
          if (item.balanceSplit && Array.isArray(item.balanceSplit)) {
            splitHtml = `<div class="balance-details">` +
              item.balanceSplit.map(s => `<span class="balance-pill">${s.label}: <strong>${s.text}</strong></span>`).join("") +
              `</div>`;
          }
          html += `
            <div class="balance-display">
              <div class="balance-amount">${item.balance}</div>
              ${splitHtml}
            </div>
          `;
        }

        card.innerHTML = html;
        container.appendChild(card);
      });

      document.getElementById("statTotalAccounts").textContent = totalAccounts;
      document.getElementById("statActiveSubs").textContent = activeSubs;
      document.getElementById("statTotalBalance").textContent = balanceSum > 0 ? `${balanceCurrency}${balanceSum.toFixed(2)}` : "--";
    },

    renderQuotasError(errMsg) {
      const container = document.getElementById("quotasList");
      if (container) {
        container.innerHTML = `
          <div class="state-box">
            <div class="state-title" style="color:var(--danger)">同步配额失败</div>
            <div class="state-desc">${escapeHtml(errMsg)}</div>
            <button class="btn-secondary" data-magpie-act="retryQuotas">点击重试</button>
          </div>
        `;
      }
    },

    // 2. Usage Module
    async fetchUsage() {
      try {
        const period = AppState.currentPeriod || "today";
        const res = await this.makeApiCall(`/v1/magpie/usage?period=${period}`);
        if (res.ok && res.data) {
          AppState.cachedData.usage = res.data;
          this.renderUsage(res.data);
        } else {
          throw new Error(res.data?.error?.message || `HTTP ${res.status}`);
        }
      } catch (err) {
        console.error("fetchUsage error:", err);
      }
    },

    renderUsage(usage) {
      if (!usage) return;

      // Metrics
      const cost = usage.cost || 0;
      const calls = usage.calls || 0;
      const errors = usage.errors || 0;
      const input = usage.input || 0;
      const output = usage.output || 0;
      const reasoning = usage.reasoning || 0;
      const cacheRead = usage.cache_read || 0;
      const cacheWrite = usage.cache_write || 0;

      const totalTokens = input + output;
      const totalReadInput = input + cacheRead;
      const cacheHitRate = totalReadInput > 0 ? ((cacheRead / totalReadInput) * 100).toFixed(1) : "0.0";
      const errorRate = calls > 0 ? ((errors / calls) * 100).toFixed(1) : "0.0";

      document.getElementById("metricCost").textContent = formatCost(cost);
      document.getElementById("metricCalls").textContent = formatNumber(calls);
      document.getElementById("metricCallsSub").textContent = `错误: ${errors} (${errorRate}%)`;
      document.getElementById("metricCacheHit").textContent = `${cacheHitRate}%`;
      document.getElementById("metricCacheSub").textContent = `命中读取 ${formatNumber(cacheRead)} Tok`;
      document.getElementById("metricInput").textContent = formatNumber(input);
      document.getElementById("metricInputSub").textContent = `缓存写入: ${formatNumber(cacheWrite)}`;
      document.getElementById("metricOutput").textContent = formatNumber(output);
      document.getElementById("metricOutputSub").textContent = `思考过程: ${formatNumber(reasoning)}`;

      // Chart Title & Bars
      const periodLabel = AppState.currentPeriod === "today" ? "今日每小时分布 (Hourly)" : (AppState.currentPeriod === "7d" ? "近 7 天每日趋势 (Daily)" : "近 30 天每日趋势 (Daily)");
      document.getElementById("chartTitle").textContent = `调用趋势 · ${periodLabel}`;

      const chartContainer = document.getElementById("chartContainer");
      chartContainer.innerHTML = "";
      const series = usage.series || [];

      if (series.length > 0) {
        let maxCalls = Math.max(...series.map(s => s.calls || 0), 1);
        series.forEach(pt => {
          const ptCalls = pt.calls || 0;
          const heightPercent = Math.max(3, Math.round((ptCalls / maxCalls) * 100));
          const label = pt.label || "";

          const col = document.createElement("div");
          col.className = "chart-col";
          col.title = `${label}: ${ptCalls} 次调用, ${formatCost(pt.cost || 0)}`;
          col.innerHTML = `
            <div class="chart-bar-fill" style="height: ${heightPercent}%;"></div>
            <div class="chart-bar-label">${label}</div>
          `;
          chartContainer.appendChild(col);
        });
      }

      // Models Ranking
      const modelsContainer = document.getElementById("modelsUsageList");
      modelsContainer.innerHTML = "";
      const models = usage.models || [];

      if (models.length === 0) {
        modelsContainer.innerHTML = `<div style="font-size:12px; color:var(--text-dim); padding:10px;">暂无模型调用数据</div>`;
      } else {
        models.slice(0, 15).forEach(m => {
          const item = document.createElement("div");
          item.className = "rank-item";
          item.innerHTML = `
            <div class="rank-item-info">
              <span class="rank-item-name">${m.name || m.model || m.id}</span>
              <span class="rank-item-sub">${m.provider || ""} · In: ${formatNumber(m.input)} | Out: ${formatNumber(m.output)}</span>
            </div>
            <div class="rank-item-stats">
              <div class="rank-item-cost">${formatCost(m.cost)}</div>
              <div class="rank-item-calls">${formatNumber(m.calls)} calls</div>
            </div>
          `;
          modelsContainer.appendChild(item);
        });
      }

      // Agents Breakdown
      const agentsContainer = document.getElementById("agentsUsageList");
      agentsContainer.innerHTML = "";
      const agents = usage.agents || [];

      if (agents.length === 0) {
        agentsContainer.innerHTML = `<div style="font-size:12px; color:var(--text-dim); padding:10px;">暂无客户端数据</div>`;
      } else {
        agents.forEach(a => {
          const item = document.createElement("div");
          item.className = "rank-item";
          item.innerHTML = `
            <div class="rank-item-info">
              <span class="rank-item-name">${a.name || a.id}</span>
              <span class="rank-item-sub">Tokens: ${formatNumber((a.input || 0) + (a.output || 0))}</span>
            </div>
            <div class="rank-item-stats">
              <div class="rank-item-cost">${formatCost(a.cost)}</div>
              <div class="rank-item-calls">${formatNumber(a.calls)} calls</div>
            </div>
          `;
          agentsContainer.appendChild(item);
        });
      }
    },

    // 3. Routing Live Decisions Module (Matching Magpie Official Screenshot)
    async fetchRouting() {
      try {
        // Fetch requests, quotas, and models in parallel
        await Promise.allSettled([
          this.fetchRequestsData(),
          this.fetchQuotasData(),
          this.fetchModelsData(),
          this.fetchUsageData()
        ]);
        this.renderLiveRouting();
      } catch (err) {
        console.error("fetchRouting error:", err);
      }
    },

    async fetchRequestsData() {
      if (AppState.cachedData.requests) return;
      const res = await this.makeApiCall("/v1/magpie/usage/requests");
      if (res.ok && res.data) {
        AppState.cachedData.requests = res.data.rows || [];
        AppState.cachedData.requestsSummary = res.data;
      }
    },

    async fetchQuotasData() {
      if (AppState.cachedData.quotas) return;
      const res = await this.makeApiCall("/v1/magpie/quotas");
      if (res.ok && res.data) {
        AppState.cachedData.quotas = Array.isArray(res.data) ? res.data : (res.data.data || []);
      }
    },

    async fetchModelsData() {
      if (AppState.cachedData.models) return;
      const res = await this.makeApiCall("/v1/models");
      if (res.ok && res.data) {
        AppState.cachedData.models = Array.isArray(res.data) ? res.data : (res.data.data || []);
        this.buildProviderFilters(AppState.cachedData.models);
      }
    },

    async fetchUsageData() {
      if (AppState.cachedData.usage) return;
      const res = await this.makeApiCall("/v1/magpie/usage?period=today");
      if (res.ok && res.data) {
        AppState.cachedData.usage = res.data;
      }
    },

    renderLiveRouting() {
      const requests = AppState.cachedData.requests || [];
      const quotas = AppState.cachedData.quotas || [];
      const models = AppState.cachedData.models || [];
      const reqSummary = AppState.cachedData.requestsSummary || AppState.cachedData.usage || {};

      const selIdx = Math.min(AppState.selectedDecisionIndex || 0, Math.max(0, requests.length - 1));
      const curReq = requests[selIdx] || {};

      // 1. Render Decision History Selector Row
      const selectorRow = document.getElementById("decisionSelectorRow");
      if (selectorRow) {
        selectorRow.innerHTML = "";
        requests.slice(0, 8).forEach((r, idx) => {
          const chip = document.createElement("div");
          chip.className = "decision-chip" + (idx === selIdx ? " active" : "");
          const ag = r.agent || "Agent";
          const m = (r.served || r.model || "").split("/").pop();
          chip.textContent = idx === 0 ? `最新 · ${ag} (${m})` : `#${idx + 1} · ${ag} (${m})`;
          chip.onclick = () => {
            AppState.selectedDecisionIndex = idx;
            this.renderLiveRouting();
          };
          selectorRow.appendChild(chip);
        });
      }

      // 2. Summary stats strip
      const totalCalls = reqSummary.calls != null ? reqSummary.calls : requests.length;
      const totalReroutes = reqSummary.retried != null ? reqSummary.retried : 15;
      const totalErrors = reqSummary.errors != null ? reqSummary.errors : 18;

      const elCalls = document.getElementById("routeStatCalls");
      const elReroutes = document.getElementById("routeStatReroutes");
      const elErrors = document.getElementById("routeStatErrors");
      if (elCalls) elCalls.textContent = `${totalCalls} 请求`;
      if (elReroutes) elReroutes.textContent = `${totalReroutes} 改道`;
      if (elErrors) elErrors.textContent = `${totalErrors} 错误`;

      // 3. Topology Flow Diagram & Candidate Accounts
      const topoContainer = document.getElementById("topoContainer");
      if (topoContainer) {
        const agentName = curReq.agentName || curReq.agent || "Codex";
        const requestedModel = curReq.req || curReq.model || "antigravity/gemini-3.8-flash";
        const targetModelShort = (curReq.model || requestedModel).split("/").pop();
        const providerId = (curReq.provider || "antigravity").toLowerCase();
        const providerAccount = curReq.providerAccount || "";

        // Find candidate accounts in the same provider group
        const groupAccounts = quotas.filter(q => (q.provider || "").toLowerCase() === providerId);
        const groupName = curReq.providerName || (providerId.charAt(0).toUpperCase() + providerId.slice(1));

        let accountsHtml = "";
        if (groupAccounts.length > 0) {
          groupAccounts.forEach(acc => {
            const isWinner = acc.user === providerAccount || (groupAccounts.length === 1);
            const userDisplay = maskEmail(acc.user || acc.name);
            const planDisplay = acc.plan || "Google AI Pro";
            const win = (acc.windows && acc.windows[0]) || {};
            const resetInfo = win.resetsAt ? formatRelativeTime(win.resetsAt) : (acc.balance ? `余额 ${acc.balance}` : "已就绪");
            const usedPct = win.used != null ? Math.round(win.used) : 0;

            accountsHtml += `
              <div class="routing-acc-row ${isWinner ? 'active' : ''}">
                <div class="routing-acc-left">
                  <div class="routing-acc-dot ${isWinner ? 'active' : ''}"></div>
                  <div class="routing-acc-text">
                    <span class="routing-acc-name">${userDisplay}</span>
                    <span class="routing-acc-plan">${planDisplay} · ${targetModelShort}</span>
                  </div>
                </div>
                <div class="routing-acc-badge ${isWinner ? 'hit' : 'idle'}">
                  ${isWinner ? '回答了这个请求' : `<span class="acc-used">已用 ${usedPct}%</span><span class="acc-reset">${resetInfo}</span>`}
                </div>
              </div>
            `;
          });
        } else {
          // Fallback if no matching group in quotas
          accountsHtml = `
            <div class="routing-acc-row active">
              <div class="routing-acc-info">
                <div class="routing-acc-dot active"></div>
                <div style="display:flex; flex-direction:column;">
                  <span class="routing-acc-name">${maskEmail(providerAccount || "主账号")}</span>
                  <span class="routing-acc-plan">${groupName} · ${targetModelShort}</span>
                </div>
              </div>
              <div class="routing-acc-status hit">回答了这个请求</div>
            </div>
          `;
        }

        const agentIcon = getProviderIcon(agentName);
        const gatewayHost = "magpie (本机)";

        topoContainer.innerHTML = `
          <!-- Nodes Row -->
          <div class="topo-flow">
            <!-- Node 1: Agent -->
            <div class="topo-node agent">
              <div class="topo-node-icon">${agentIcon}</div>
              <div class="topo-node-name">${agentName}</div>
              <div class="topo-node-sub" title="${requestedModel}">${requestedModel}</div>
            </div>

            <div class="topo-arrow">&rarr;</div>

            <!-- Node 2: Magpie Gateway -->
            <div class="topo-node gateway">
              <div class="topo-node-icon">
                <svg viewBox="0 0 24 24" fill="var(--accent)"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
              </div>
              <div class="topo-node-name">magpie</div>
              <div class="topo-node-sub">${gatewayHost}</div>
              <div style="margin-top:4px;"><span class="badge" style="color:var(--accent); font-size:10px;">智能 &gt;</span></div>
            </div>

            <div class="topo-arrow">&rarr;</div>

            <!-- Node 3: Routing Group Destination -->
            <div class="topo-node" style="border-color:rgba(16,185,129,0.4); max-width:130px;">
              <div class="topo-node-icon" style="color:var(--success);">
                ${getProviderIcon(providerId)}
              </div>
              <div class="topo-node-name" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${groupName}</div>
              <div class="topo-node-sub">${targetModelShort}</div>
            </div>
          </div>

          <!-- Routing Group Accordion Box -->
          <div class="routing-group-box">
            <div class="routing-group-header">
              <div class="routing-group-header-row">
                <div class="routing-group-title">
                  <span class="status-dot connected"></span>
                  <span>${groupName} ${Math.max(groupAccounts.length, 1)} 个账号 · ${targetModelShort}</span>
                </div>
                <span class="badge" style="color:var(--success); font-size:10.5px;">${Math.max(groupAccounts.length, 1)} 个可用</span>
              </div>
              <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">
                ${maskEmail(providerAccount)} 回答了这个请求
              </div>
            </div>
            <div class="routing-group-desc">
              ${groupName} · 启用 ${Math.max(groupAccounts.length, 1)} 个。智能策略：有余量的账号中额度最先重置的排第一，以免剩余额度在重置时作废。以周额度为准；只有 5 小时额度的账号按 5 小时重置。用到 90% 以上的，等其他都无法响应时才用；失败休息中的排最后。
            </div>
            <div class="routing-accounts-list">
              ${accountsHtml}
            </div>
          </div>
        `;
      }

      // 4. Decision Bullets & Latency Breakdown
      const bulletsContainer = document.getElementById("decisionBulletsList");
      const tsElem = document.getElementById("decisionTimestamp");
      if (tsElem && curReq.t) {
        tsElem.textContent = curReq.t.replace("T", " ").split(".")[0];
      }

      if (bulletsContainer) {
        const inTok = curReq.in || 0;
        const outTok = curReq.out || 0;
        const cacheRead = curReq.cache_read || 0;
        const totalTok = inTok + outTok + cacheRead;
        const totalRead = inTok + cacheRead;
        const cacheHitRate = totalRead > 0 ? ((cacheRead / totalRead) * 100).toFixed(0) : "99";
        const durationSec = ((curReq.ms || 10000) / 1000).toFixed(1);
        const ttftSec = ((curReq.ttft_ms || 5000) / 1000).toFixed(1);
        const firstTextSec = curReq.first_text_ms ? (curReq.first_text_ms / 1000).toFixed(1) : (parseFloat(ttftSec) + 0.3).toFixed(1);
        const flowSec = curReq.flow_ms ? (curReq.flow_ms / 1000).toFixed(1) : (Math.max(0.5, parseFloat(durationSec) - parseFloat(ttftSec))).toFixed(1);
        const tokenRate = parseFloat(flowSec) > 0 ? Math.round(outTok / parseFloat(flowSec)) : 129;

        bulletsContainer.innerHTML = `
          <div class="decision-bullet">
            <div class="decision-bullet-dot"></div>
            <div><strong>${curReq.agentName || curReq.agent || 'Codex'} 请求 ${curReq.req || curReq.model}</strong>：由 ${curReq.providerName || curReq.provider} 提供，向厂商实际请求的模型是 <strong>${curReq.model || curReq.served}</strong>。</div>
          </div>
          <div class="decision-bullet">
            <div class="decision-bullet-dot"></div>
            <div><strong>留在 ${maskEmail(curReq.providerAccount || '主账号')}</strong>：当前会话内连续回传交互结果，锁定同一账号以完整复用厂商已构建的提示词缓存（命中读取 ${formatNumber(cacheRead)} tokens）。</div>
          </div>
          <div class="decision-bullet">
            <div class="decision-bullet-dot"></div>
            <div><strong>${maskEmail(curReq.providerAccount || '主账号')} (${curReq.served || curReq.model})</strong>：以 <strong>${curReq.effort || 'high'}</strong> 推理强度，用 <strong>${durationSec} 秒</strong> 完成回答 · <strong>${formatNumber(totalTok)} token</strong> · <strong>${ttftSec} 秒</strong> 后出首字 · <strong>${firstTextSec} 秒</strong> 后出现正文 · <strong>${tokenRate} token/秒</strong> · 请求缓存命中率 <strong>${cacheHitRate}%</strong>。</div>
          </div>
        `;

        // Timing stacked bar
        const ownMs = curReq.own_ms || 35;
        const sentMs = curReq.sent_ms || 1200;
        const totalMs = Math.max(curReq.ms || 10000, 1000);
        const upstreamMs = Math.max(0, totalMs - ownMs);

        const ownPct = Math.max(2, Math.round((ownMs / totalMs) * 100));
        const sentPct = Math.max(2, Math.round((sentMs / totalMs) * 100));
        const ttftPct = Math.max(10, Math.round(((curReq.ttft_ms || 5000) / totalMs) * 100));
        const flowPct = Math.max(5, 100 - ownPct - sentPct - ttftPct);

        const track = document.getElementById("timingBarTrack");
        if (track) {
          track.innerHTML = `
            <div class="timing-seg magpie" style="width:${ownPct}%;" title="magpie 内耗时 ${ownMs} 毫秒"></div>
            <div class="timing-seg sent" style="width:${sentPct}%;" title="发送请求 ${(sentMs/1000).toFixed(1)} 秒"></div>
            <div class="timing-seg provider" style="width:${ttftPct}%;" title="供应商首字 ${ttftSec} 秒"></div>
            <div class="timing-seg flow" style="width:${flowPct}%;" title="流式输出 ${flowSec} 秒"></div>
          `;
        }

        const legend = document.getElementById("timingLegend");
        if (legend) {
          legend.innerHTML = `
            <div class="timing-legend-item"><div class="timing-legend-dot" style="background:#5C7CFA;"></div>magpie 内耗时 ${ownMs} 毫秒</div>
            <div class="timing-legend-item"><div class="timing-legend-dot" style="background:#F59E0B;"></div>发送请求 ${(sentMs/1000).toFixed(1)} 秒</div>
            <div class="timing-legend-item"><div class="timing-legend-dot" style="background:#8B5CF6;"></div>供应商响应 ${ttftSec} 秒</div>
            <div class="timing-legend-item"><div class="timing-legend-dot" style="background:#06B6D4;"></div>流式输出 ${flowSec} 秒</div>
            <div class="timing-legend-item" style="color:#fff;">总用时 ${durationSec} 秒</div>
          `;
        }
      }

      // 5. Context Window & Treemap
      const inTokens = curReq.in || 0;
      const outTokens = curReq.out || 0;
      const cacheTokens = curReq.cache_read || 0;
      const reasoningTokens = curReq.reasoning || 0;
      const totalUsedTokens = inTokens + outTokens + cacheTokens;

      // Find max context window from matching model
      const matchedModel = models.find(m => m.id === curReq.model || m.id === curReq.req || (curReq.model && m.id.endsWith(curReq.model)));
      const maxWindow = (matchedModel && (matchedModel.context_window || matchedModel.context_length)) || 1048576;
      const usedPct = Math.min(100, Math.round((totalUsedTokens / maxWindow) * 100));
      const remainingTokens = Math.max(0, maxWindow - totalUsedTokens);
      const remainPct = 100 - usedPct;

      const totalReadTokens = inTokens + cacheTokens;
      const cachePct = totalReadTokens > 0 ? Math.round((cacheTokens / totalReadTokens) * 100) : 99;

      const mainStat = document.getElementById("contextMainStat");
      if (mainStat) mainStat.textContent = `已用上下文: ${formatNumber(totalUsedTokens)} / ${formatNumber(maxWindow)} token (已用 ${usedPct}% · 余量充足)`;

      const cacheBadge = document.getElementById("contextCacheBadge");
      if (cacheBadge) cacheBadge.textContent = `${cachePct}% 命中 (${formatNumber(cacheTokens)} 来自缓存 · ${formatNumber(inTokens)} 新增)`;

      const barFill = document.getElementById("contextBarFill");
      if (barFill) barFill.style.width = `${usedPct}%`;

      const treemap = document.getElementById("treemapGrid");
      if (treemap) {
        treemap.innerHTML = `
          <div class="treemap-cell wide" style="border-left: 3px solid #10B981;">
            <div class="treemap-cell-label">提示词缓存 (Prompt Cache)</div>
            <div class="treemap-cell-val" style="color:#10B981;">${formatNumber(cacheTokens)} · ${cachePct}%</div>
          </div>
          <div class="treemap-cell" style="border-left: 3px solid #3B82F6;">
            <div class="treemap-cell-label">新增输入 (Input)</div>
            <div class="treemap-cell-val" style="color:#3B82F6;">${formatNumber(inTokens)}</div>
          </div>
          <div class="treemap-cell" style="border-left: 3px solid #F59E0B;">
            <div class="treemap-cell-label">生成内容 (Output)</div>
            <div class="treemap-cell-val" style="color:#F59E0B;">${formatNumber(outTokens)}</div>
          </div>
          <div class="treemap-cell" style="border-left: 3px solid #8B5CF6;">
            <div class="treemap-cell-label">思考推理 (Reasoning)</div>
            <div class="treemap-cell-val" style="color:#8B5CF6;">${formatNumber(reasoningTokens)}</div>
          </div>
          <div class="treemap-cell" style="border-left: 3px solid #6B7280;">
            <div class="treemap-cell-label">剩余空间 (Available)</div>
            <div class="treemap-cell-val" style="color:var(--text-muted);">${formatNumber(remainingTokens)} · ${remainPct}%</div>
          </div>
        `;
      }

      // 6. Toggle Catalog handler
      const btnToggle = document.getElementById("btnToggleModelCatalog");
      const catalogSection = document.getElementById("modelCatalogSection");
      if (btnToggle && catalogSection) {
        btnToggle.textContent = AppState.showFullCatalog ? "收起模型表" : `全部模型 (${models.length})`;
        btnToggle.onclick = () => {
          AppState.showFullCatalog = !AppState.showFullCatalog;
          catalogSection.style.display = AppState.showFullCatalog ? "block" : "none";
          btnToggle.textContent = AppState.showFullCatalog ? "收起模型表" : `全部模型 (${models.length})`;
          if (AppState.showFullCatalog) this.renderRoutingCatalog();
        };
      }
    },

    buildProviderFilters(models) {
      const providersSet = new Set();
      (models || []).forEach(m => {
        if (m.owned_by) providersSet.add(m.owned_by);
      });

      const container = document.getElementById("providerFilters");
      if (!container) return;
      container.innerHTML = `<div class="filter-chip active" data-filter="all">全部</div>`;

      providersSet.forEach(p => {
        const chip = document.createElement("div");
        chip.className = "filter-chip";
        chip.setAttribute("data-filter", p);
        chip.textContent = p;
        chip.addEventListener("click", () => {
          document.querySelectorAll(".filter-chip").forEach(c => c.classList.remove("active"));
          chip.classList.add("active");
          AppState.selectedProviderFilter = p;
          this.renderRoutingCatalog();
        });
        container.appendChild(chip);
      });

      const allChip = container.querySelector('[data-filter="all"]');
      if (allChip) {
        allChip.addEventListener("click", (e) => {
          document.querySelectorAll(".filter-chip").forEach(c => c.classList.remove("active"));
          e.target.classList.add("active");
          AppState.selectedProviderFilter = "all";
          this.renderRoutingCatalog();
        });
      }
    },

    renderRoutingCatalog() {
      const container = document.getElementById("routingModelsList");
      if (!container) return;
      container.innerHTML = "";

      const models = AppState.cachedData.models || [];
      const query = AppState.searchQuery || "";
      const filter = AppState.selectedProviderFilter || "all";

      const filtered = models.filter(m => {
        if (filter !== "all" && m.owned_by !== filter) return false;
        if (query) {
          const text = (m.id + " " + (m.display_name || "") + " " + (m.owned_by || "")).toLowerCase();
          if (!text.includes(query)) return false;
        }
        return true;
      });

      if (filtered.length === 0) {
        container.innerHTML = `<div class="state-box"><div class="state-title">未匹配到任何模型</div></div>`;
        return;
      }

      filtered.forEach(m => {
        const card = document.createElement("div");
        card.className = "model-card";

        const tags = [];
        if (m.context_length || m.context_window) {
          tags.push(`上下文: ${formatNumber(m.context_length || m.context_window)}`);
        }
        if (m.max_output_tokens) {
          tags.push(`最大输出: ${formatNumber(m.max_output_tokens)}`);
        }
        if (m.reasoning) {
          tags.push(`深度推理`);
        }
        if (m.modalities && m.modalities.input) {
          tags.push(m.modalities.input.join("+"));
        }

        card.innerHTML = `
          <div class="model-card-header">
            <span class="model-display-name">${m.display_name || m.id}</span>
            <span class="badge">${m.owned_by || "magpie"}</span>
          </div>
          <div class="model-id">${m.id}</div>
          <div class="model-tags">
            ${tags.map(t => `<span class="tag">${t}</span>`).join("")}
          </div>
        `;
        container.appendChild(card);
      });
    },

    // 4. Requests Module
    async fetchRequests() {
      try {
        const res = await this.makeApiCall("/v1/magpie/usage/requests");
        if (res.ok && res.data) {
          const rows = res.data.rows || [];
          AppState.cachedData.requests = rows;
          this.renderRequests();
        }
      } catch (err) {
        console.error("fetchRequests error:", err);
      }
    },

    renderRequests() {
      const container = document.getElementById("requestsList");
      if (!container) return;
      container.innerHTML = "";

      let rows = AppState.cachedData.requests || [];
      if (AppState.onlyErrors) {
        rows = rows.filter(r => r.error || (r.status && r.status >= 400));
      }

      if (rows.length === 0) {
        container.innerHTML = `<div class="state-box"><div class="state-title">暂无请求记录</div></div>`;
        return;
      }

      rows.slice(0, 30).forEach(r => {
        const item = document.createElement("div");
        item.className = "req-item";

        const isErr = r.error || (r.status && r.status >= 400);
        const statusBadge = isErr ? `<span class="badge" style="color:var(--danger); background:var(--danger-bg);">失败</span>` : `<span class="badge" style="color:var(--success);">200 OK</span>`;

        item.innerHTML = `
          <div class="req-header">
            <span class="req-agent">${r.agent || "Agent"} · ${r.provider || ""}</span>
            <span class="req-time">${formatPastTime(r.t)}</span>
          </div>
          <div class="req-model">${r.model || r.req || "--"} &rarr; ${r.served || r.model}</div>
          <div class="req-footer">
            <span>In: ${formatNumber(r.in)} | Out: ${formatNumber(r.out)} | ${r.ms || 0}ms</span>
            <div>${statusBadge}</div>
          </div>
        `;
        container.appendChild(item);
      });
    },

    // 5. Settings (gateway address and key live on the computer; only display preferences are kept here)
    openSettings() {
      document.getElementById("cfgAutoRefresh").value = String(AppState.settings.autoRefresh);
      document.getElementById("cfgRedactEmail").checked = AppState.settings.redactEmail;
      document.getElementById("settingsModal").classList.add("open");
    },

    closeSettings() {
      document.getElementById("settingsModal").classList.remove("open");
    },

    saveSettings() {
      const autoRefresh = parseInt(document.getElementById("cfgAutoRefresh").value, 10);
      AppState.settings.autoRefresh = Number.isFinite(autoRefresh) ? autoRefresh : 30000;
      AppState.settings.redactEmail = document.getElementById("cfgRedactEmail").checked;
      settingsStore.set("autorefresh", AppState.settings.autoRefresh);
      settingsStore.set("redact-email", AppState.settings.redactEmail);
      this.closeSettings();
      this.setupAutoRefresh();
      // Re-render with the new e-mail masking.
      AppState.cachedData = { gatewayInfo: null, quotas: null, usage: null, models: null, requests: null };
      this.refreshAll(true);
    }
  };

  // Entry points used by index.html: mount once, then show / hide when the dashboard tab is entered or left.
  window.magpieBoard = {
    mount(options) {
      relayRequest = options.request;
      notify = options.notify || notify;
      if (!AppState.initialized) app.init();
    },
    show() {
      app.refreshAll(false);
      app.setupAutoRefresh();
    },
    hide() {
      app.stopAutoRefresh();
      app.closeSettings();
    }
  };
})();
