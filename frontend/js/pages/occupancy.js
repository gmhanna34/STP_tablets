// Occupancy Dashboard Page — Ported from STP_Occupancy (Phase 6 consolidation)
// Chart.js charts, KPI cards, pacing drill-down, week-over-week table.
// Accessed from the people counting panel on Main page (no nav bar button).

const OccupancyPage = {
  _data: null,
  _charts: {},
  _activePacingDate: null,
  _pacingMode: 'communion',

  render(container) {
    container.innerHTML = `
      <div class="occ-page">
        <div class="occ-header">
          <div>
            <h1 class="occ-title">Occupancy Dashboard</h1>
            <div class="occ-subtitle">Camlytics &middot; Building &amp; Communion Analytics</div>
          </div>
          <div class="occ-header-actions">
            <button class="btn" id="occ-btn-refresh">
              <span class="material-icons">refresh</span>
              <span class="btn-label">Refresh</span>
            </button>
            <button class="btn" id="occ-btn-back">
              <span class="material-icons">arrow_back</span>
              <span class="btn-label">Back</span>
            </button>
          </div>
        </div>

        <div class="occ-status" id="occ-status">Loading dashboard data&hellip;</div>

        <div class="occ-kpis" id="occ-kpi-row"></div>

        <div class="occ-chart-section">
          <div class="occ-card occ-card-full">
            <div class="occ-card-header">
              <h2>Building Occupancy</h2>
              <span class="occ-card-desc">Peak occupancy during service hours, per service (with buffer)</span>
            </div>
            <div class="occ-chart-wrap"><canvas id="occ-chart-occupancy"></canvas></div>
          </div>
        </div>

        <div class="occ-chart-row">
          <div class="occ-card">
            <div class="occ-card-header">
              <h2>Total Communion Count</h2>
              <span class="occ-card-desc">Filtered to communion window, per service (with buffer)</span>
            </div>
            <div class="occ-chart-wrap"><canvas id="occ-chart-communion"></canvas></div>
          </div>
          <div class="occ-card">
            <div class="occ-card-header">
              <h2>Occupancy vs. Communion</h2>
              <span class="occ-card-desc">Side-by-side comparison with participation ratio</span>
            </div>
            <div class="occ-chart-wrap"><canvas id="occ-chart-comparison"></canvas></div>
          </div>
        </div>

        <div class="occ-card occ-card-full occ-hidden" id="occ-pacing-section">
          <div class="occ-card-header occ-pacing-header">
            <div>
              <h2 id="occ-pacing-title">Communion Pacing</h2>
              <span class="occ-card-desc" id="occ-pacing-desc">15-minute interval breakdown during communion window</span>
            </div>
            <div class="occ-pacing-mode-toggle" id="occ-pacing-mode">
              <button class="occ-toggle-btn occ-toggle-active" data-mode="communion">Communion</button>
              <button class="occ-toggle-btn" data-mode="occupancy">Occupancy</button>
            </div>
          </div>
          <div class="occ-pacing-tabs" id="occ-pacing-tabs"></div>
          <div class="occ-chart-wrap occ-chart-wrap-tall"><canvas id="occ-chart-pacing"></canvas></div>
        </div>

        <div class="occ-card occ-card-full">
          <div class="occ-card-header">
            <h2>Week-over-Week Summary</h2>
            <span class="occ-card-desc">All services &mdash; buffered values (raw in parentheses)</span>
          </div>
          <div class="occ-table-wrap">
            <table class="occ-table" id="occ-week-table"></table>
          </div>
        </div>

        <div class="occ-card occ-card-full occ-card-muted">
          <div class="occ-card-header">
            <h2>Buffer Configuration</h2>
            <span class="occ-card-desc">Camera under-count adjustment schedule</span>
          </div>
          <div class="occ-table-wrap">
            <table class="occ-table" id="occ-buffer-table"></table>
          </div>
        </div>
      </div>
    `;
  },

  init() {
    document.getElementById('occ-btn-refresh')?.addEventListener('click', () => this._manualRefresh());
    document.getElementById('occ-btn-back')?.addEventListener('click', () => {
      Router.navigate('main');
    });

    // Pacing mode toggle
    document.getElementById('occ-pacing-mode')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.occ-toggle-btn');
      if (btn && btn.dataset.mode) this._setPacingMode(btn.dataset.mode);
    });

    // Pacing date tabs (delegated)
    document.getElementById('occ-pacing-tabs')?.addEventListener('click', (e) => {
      const tab = e.target.closest('.occ-pacing-tab');
      if (tab && tab.dataset.date) this._selectPacing(tab.dataset.date);
    });

    this._loadData();
  },

  destroy() {
    this._destroyCharts();
    this._data = null;
  },

  // ── Helpers ────────────────────────────────────────────────────────

  _esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },

  _formatDate(iso) {
    const [y, m, d] = iso.split('-');
    return new Date(+y, +m - 1, +d).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: '2-digit'
    });
  },

  _setStatus(msg, isError) {
    const el = document.getElementById('occ-status');
    if (!el) return;
    el.className = 'occ-status' + (isError ? ' occ-status-error' : '');
    el.innerHTML = msg;
  },

  _destroyCharts() {
    Object.values(this._charts).forEach(c => c.destroy());
    this._charts = {};
  },

  _chartOptions(yLabel) {
    const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim() || '#7b7f75';
    const gridColor = 'rgba(180,176,165,0.2)';
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: { font: { size: 11 }, color: textColor, boxWidth: 12, padding: 16 }
        },
        tooltip: {
          backgroundColor: '#343B3D',
          titleColor: '#d4a843',
          bodyColor: '#f4f3f1',
          borderColor: '#b8860b',
          borderWidth: 1,
          padding: 10
        }
      },
      scales: {
        x: {
          grid: { color: gridColor },
          ticks: { font: { size: 11 }, color: textColor, maxRotation: 35 }
        },
        y: {
          grid: { color: gridColor },
          ticks: { font: { size: 11 }, color: textColor },
          title: { display: true, text: yLabel, font: { size: 10 }, color: textColor }
        }
      }
    };
  },

  // ── Data loading ───────────────────────────────────────────────────

  async _loadData() {
    this._setStatus('Loading\u2026', false);
    this._destroyCharts();

    try {
      const res = await fetch('/api/occupancy/data', { signal: AbortSignal.timeout(10000) });
      const data = await res.json();
      if (data.error) {
        this._setStatus('Error: ' + this._esc(data.error), true);
        return;
      }
      this._data = data;
      this._setStatus(
        '<b>' + data.weekly_summary.length + '</b> service(s) with communion data &middot; ' +
        'Communion window: <b>' + data.communion_window.start + ' \u2013 ' + data.communion_window.end + '</b> &middot; ' +
        'Refreshed ' + new Date(data.scanned_at).toLocaleTimeString(),
        false
      );
      this._render(data);
    } catch (e) {
      this._setStatus('Connection error \u2014 is the server running?', true);
    }
  },

  async _manualRefresh() {
    const btn = document.getElementById('occ-btn-refresh');
    if (btn) btn.disabled = true;
    this._setStatus('Refreshing data from server\u2026', false);

    try {
      const res = await fetch('/api/occupancy/refresh', { method: 'POST' });
      const result = await res.json();
      if (!result.ok) {
        this._setStatus('Refresh failed: ' + this._esc(result.message), true);
        return;
      }
      await this._loadData();
    } catch (e) {
      this._setStatus('Refresh error: ' + this._esc(String(e)), true);
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  // ── Render ─────────────────────────────────────────────────────────

  _render(data) {
    const { weekly_summary, occupancy_trend } = data;
    this._buildKPIs(weekly_summary);
    this._buildOccupancyTrend(occupancy_trend);
    this._buildCommunionTrend(weekly_summary);
    this._buildComparisonChart(weekly_summary);
    this._buildWeekTable(weekly_summary);
    this._buildBufferTable(data.buffer_schedule);

    if (weekly_summary.length > 0) {
      document.getElementById('occ-pacing-section')?.classList.remove('occ-hidden');
      this._activePacingDate = weekly_summary[weekly_summary.length - 1].date;
      this._renderPacingTabs(weekly_summary);
      this._buildPacingChart(weekly_summary, this._activePacingDate);
    }
  },

  // ── KPIs ───────────────────────────────────────────────────────────

  _buildKPIs(weekly) {
    const row = document.getElementById('occ-kpi-row');
    if (!row) return;

    if (!weekly.length) {
      row.innerHTML = '<div class="occ-kpi-empty">No service data found.</div>';
      return;
    }

    const last = weekly[weekly.length - 1];
    const prev = weekly.length > 1 ? weekly[weekly.length - 2] : null;

    const avgComm = Math.round(weekly.reduce((s, w) => s + w.total_communion, 0) / weekly.length);
    const withOcc = weekly.filter(w => w.peak_occupancy);
    const avgOcc = withOcc.length
      ? Math.round(withOcc.reduce((s, w) => s + w.peak_occupancy, 0) / withOcc.length)
      : '\u2014';

    const trend = prev
      ? (last.total_communion >= prev.total_communion ? '\u25B2' : '\u25BC')
      : '';
    const trendClass = prev
      ? (last.total_communion >= prev.total_communion ? 'occ-kpi-sage' : 'occ-kpi-rust')
      : '';

    row.innerHTML = [
      this._kpiCard((last.label || 'Last Service') + ' \u2014 ' + this._formatDate(last.date), last.total_communion, 'Communion count (buffered)', 'occ-kpi-gold'),
      this._kpiCard('Building occupancy', last.peak_occupancy ?? '\u2014', 'Peak during service hours', ''),
      this._kpiCard('Participation ratio',
        (last.ratio !== null ? (last.ratio * 100).toFixed(0) + '%' : '\u2014') +
        (trend ? ' <small class="' + trendClass + '">' + trend + '</small>' : ''),
        'Communion \u00F7 occupancy', trendClass),
      this._kpiCard('Avg communion / service', avgComm, 'Over ' + weekly.length + ' recorded service(s)', 'occ-kpi-rust'),
      this._kpiCard('Avg peak occupancy', avgOcc, 'Services with building data', ''),
    ].join('');
  },

  _kpiCard(label, value, sub, colorClass) {
    return '<div class="occ-kpi">' +
      '<div class="occ-kpi-card">' +
        '<div class="occ-kpi-label">' + this._esc(label) + '</div>' +
        '<div class="occ-kpi-value ' + (colorClass || '') + '">' + value + '</div>' +
        '<div class="occ-kpi-sub">' + this._esc(sub) + '</div>' +
      '</div></div>';
  },

  // ── Charts ─────────────────────────────────────────────────────────

  _buildOccupancyTrend(occ) {
    const ctx = document.getElementById('occ-chart-occupancy');
    if (!ctx) return;
    const labels = occ.map(r => this._formatDate(r.date));
    const values = occ.map(r => r.peak_occupancy);
    this._charts.occupancy = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Peak Occupancy (buffered)',
          data: values,
          borderColor: '#b8860b',
          backgroundColor: 'rgba(184,134,11,0.08)',
          borderWidth: 2.5,
          pointBackgroundColor: '#b8860b',
          pointRadius: 5,
          pointHoverRadius: 7,
          tension: 0.35,
          fill: true
        }]
      },
      options: this._chartOptions('People in building')
    });
  },

  _buildCommunionTrend(weekly) {
    const ctx = document.getElementById('occ-chart-communion');
    if (!ctx) return;
    const labels = weekly.map(r => this._formatDate(r.date));
    const values = weekly.map(r => r.total_communion);
    this._charts.communion = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Total Communion (buffered)',
          data: values,
          borderColor: '#8b3a2a',
          backgroundColor: 'rgba(139,58,42,0.08)',
          borderWidth: 2.5,
          pointBackgroundColor: '#8b3a2a',
          pointRadius: 5,
          pointHoverRadius: 7,
          tension: 0.35,
          fill: true
        }]
      },
      options: this._chartOptions('Communion count')
    });
  },

  _buildComparisonChart(weekly) {
    const ctx = document.getElementById('occ-chart-comparison');
    if (!ctx) return;
    const filtered = weekly.filter(w => w.peak_occupancy);
    const labels = filtered.map(r => this._formatDate(r.date));
    const occ = filtered.map(r => r.peak_occupancy);
    const comm = filtered.map(r => r.total_communion);
    this._charts.comparison = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Peak Occupancy',
            data: occ,
            backgroundColor: 'rgba(184,134,11,0.65)',
            borderColor: '#b8860b',
            borderWidth: 1.5,
            borderRadius: 3
          },
          {
            label: 'Communion',
            data: comm,
            backgroundColor: 'rgba(139,58,42,0.65)',
            borderColor: '#8b3a2a',
            borderWidth: 1.5,
            borderRadius: 3
          }
        ]
      },
      options: this._chartOptions('Count')
    });
  },

  // ── Pacing ─────────────────────────────────────────────────────────

  _renderPacingTabs(weekly) {
    const tabs = document.getElementById('occ-pacing-tabs');
    if (!tabs) return;
    tabs.innerHTML = weekly.map(w =>
      '<button class="occ-pacing-tab' +
        (w.date === this._activePacingDate ? ' occ-pacing-tab-active' : '') +
        '" data-date="' + w.date + '">' + this._formatDate(w.date) + '</button>'
    ).join('');
  },

  _selectPacing(date) {
    this._activePacingDate = date;
    document.querySelectorAll('.occ-pacing-tab').forEach(t => {
      t.classList.toggle('occ-pacing-tab-active', t.dataset.date === date);
    });
    this._buildPacingChart(this._data.weekly_summary, date);
  },

  _setPacingMode(mode) {
    this._pacingMode = mode;
    document.querySelectorAll('#occ-pacing-mode .occ-toggle-btn').forEach(btn => {
      btn.classList.toggle('occ-toggle-active', btn.dataset.mode === mode);
    });

    const title = document.getElementById('occ-pacing-title');
    const desc = document.getElementById('occ-pacing-desc');
    if (mode === 'communion') {
      if (title) title.textContent = 'Communion Pacing';
      if (desc) desc.textContent = '15-minute interval breakdown during communion window';
    } else {
      if (title) title.textContent = 'Building Occupancy Pacing';
      const win = this._data && this._data.occupancy_pacing_window;
      const winText = win ? win.start + ' \u2013 ' + win.end : 'service window';
      if (desc) desc.textContent = '15-minute interval breakdown (' + winText + ')';
    }

    if (this._data) {
      this._buildPacingChart(this._data.weekly_summary, this._activePacingDate);
    }
  },

  _buildPacingChart(weekly, date) {
    const week = weekly.find(w => w.date === date);
    if (!week) return;

    let pacingData, chartLabel, barColor, barHighlight;
    if (this._pacingMode === 'communion') {
      pacingData = week.pacing || [];
      chartLabel = 'Communion count';
      barColor = 'rgba(184,134,11,0.45)';
      barHighlight = '#b8860b';
    } else {
      pacingData = week.occupancy_pacing || [];
      chartLabel = 'Building occupancy';
      barColor = 'rgba(74,103,65,0.45)';
      barHighlight = '#4a6741';
    }

    if (!pacingData.length) return;

    const labels = pacingData.map(p => p.time);
    const values = pacingData.map(p => p.count);
    const maxVal = Math.max(...values);

    if (this._charts.pacing) { this._charts.pacing.destroy(); delete this._charts.pacing; }

    const ctx = document.getElementById('occ-chart-pacing');
    if (!ctx) return;
    this._charts.pacing = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: chartLabel,
          data: values,
          backgroundColor: values.map(v => v === maxVal ? barHighlight : barColor),
          borderColor: barHighlight,
          borderWidth: 1,
          borderRadius: 4
        }]
      },
      options: this._chartOptions('People')
    });
  },

  // ── Week table ─────────────────────────────────────────────────────

  _buildWeekTable(weekly) {
    const table = document.getElementById('occ-week-table');
    if (!table) return;

    const maxComm = Math.max(...weekly.map(w => w.total_communion), 1);

    table.innerHTML =
      '<thead><tr>' +
        '<th>Service Date</th>' +
        '<th>Peak Occupancy</th>' +
        '<th>Total Communion</th>' +
        '<th>Participation</th>' +
        '<th>Ratio</th>' +
      '</tr></thead>' +
      '<tbody>' +
      [...weekly].reverse().map(w => {
        const pct = w.ratio !== null ? (w.ratio * 100).toFixed(0) : null;
        const barW = Math.min(100, Math.round((w.total_communion / maxComm) * 100));
        const occLabel = w.peak_occupancy != null
          ? w.peak_occupancy + (w.raw_peak_occupancy != null ? ' <small class="occ-muted">(' + w.raw_peak_occupancy + ')</small>' : '')
          : '\u2014';
        const commLabel = w.total_communion +
          (w.raw_total_communion != null ? ' <small class="occ-muted">(' + w.raw_total_communion + ')</small>' : '');

        return '<tr>' +
          '<td>' + this._formatDate(w.date) + (w.label ? ' <small class="occ-muted">(' + this._esc(w.label) + ')</small>' : '') + '</td>' +
          '<td class="occ-num">' + occLabel + '</td>' +
          '<td class="occ-num">' + commLabel + '</td>' +
          '<td class="occ-num">' + (pct !== null ? pct + '%' : '\u2014') + '</td>' +
          '<td>' +
            '<div class="occ-ratio-bar">' +
              '<div class="occ-ratio-fill" style="width:' + barW + '%"></div>' +
              '<span class="occ-ratio-label">' + w.total_communion + ' / ' + (w.peak_occupancy ?? '?') + '</span>' +
            '</div>' +
          '</td>' +
        '</tr>';
      }).join('') +
      '</tbody>';
  },

  // ── Buffer table ───────────────────────────────────────────────────

  _buildBufferTable(schedule) {
    const table = document.getElementById('occ-buffer-table');
    if (!table || !schedule) return;

    table.innerHTML =
      '<thead><tr>' +
        '<th>Effective Date</th>' +
        '<th>Occupancy Buffer</th>' +
        '<th>Communion Buffer</th>' +
      '</tr></thead>' +
      '<tbody>' +
      schedule.map(entry =>
        '<tr>' +
          '<td>' + this._formatDate(entry.effective_date) + '</td>' +
          '<td>' + (entry.occupancy_buffer * 100).toFixed(1) + '%</td>' +
          '<td>' + (entry.communion_buffer * 100).toFixed(1) + '%</td>' +
        '</tr>'
      ).join('') +
      '</tbody>';
  },
};
