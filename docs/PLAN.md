# Phase 6: Absorb Occupancy App into Gateway

## What Exists Today

| Component | Location | What It Does |
|-----------|----------|-------------|
| **2 CSV download scripts** | `STP_scripts/DownloadCamlytics*.py` | Weekly Windows Scheduled Task: `requests.get()` Camlytics cloud CSV URL → save to `C:\Users\info\Box\Reports\` |
| **Occupancy dashboard** | `STP_Occupancy/app.py` (port 20857) | Flask + pandas: reads saved CSVs, parses weekly trends, communion counts, occupancy pacing, participation ratios. Chart.js frontend. |
| **Live camlytics poller** | `gateway.py` (already built-in) | Polls Camlytics cloud JSON API every 5s for real-time communion/occupancy/entry counts. Endpoints: `/api/camlytics/state`, `/api/camlytics/buffer` |
| **Main page people counting** | `frontend/js/pages/main.js` | Shows live occupancy + communion with adjustable buffers on the Main Church page |

## What Changes

### 1. Create `gateway/occupancy_module.py` (~300 lines)

Absorb the CSV-parsing analytics logic from `STP_Occupancy/app.py`:

- `OccupancyModule` class with:
  - `__init__(cfg, logger)` — reads `occupancy:` section from config.yaml
  - `start()` — launches background scheduler thread
  - `refresh_data()` — scans CSV directory, parses with pandas, caches results
  - `get_data()` → dict — returns cached weekly summary, trends, pacing data
  - `get_config()` → dict — returns buffer schedule, communion window, etc.
  - Background scheduler thread: auto-reloads data daily at configured time (default 01:00)

Key logic ported from `STP_Occupancy/app.py`:
- `parse_building_file()` / `parse_communion_file()` — pandas CSV parsing
- `service_peak_occupancy()` / `service_communion_totals()` — windowed aggregation
- `build_weekly_summary()` — joins occupancy + communion by date
- Buffer schedule with date-based percentage adjustments
- Special services support (non-Sunday dates with custom time windows)

**New dependency:** `pandas` added to `requirements.txt`

### 2. Add CSV download as a gateway scheduled task

Instead of Windows Task Scheduler running `DownloadCamlyticsBuildingOccupancy.py` and `DownloadCamlyticsCommunionCounts.py`, the occupancy module will download CSVs itself:

- `_download_csvs()` method: fetches both report URLs, saves to configured data directory
- Runs as part of the daily scheduler (before data reload), or on manual trigger
- Config provides the two Camlytics cloud CSV export URLs
- Saves with same filename pattern: `Camlytics_BuildingOccupancy_YYYY-MM-DD.csv`

### 3. Merge occupancy config into `gateway/config.yaml`

Add `occupancy:` section (merging from `STP_Occupancy/config.yaml`):

```yaml
occupancy:
  data_dir: "C:\\Users\\info\\Box\\Reports"        # CSV root directory
  building_subdir: "BuildingOccupancy"
  communion_subdir: "CommunionCounts"
  service_hour_start: 7
  service_hour_end: 22
  communion_window_start: "10:30"
  communion_window_end: "12:15"
  occupancy_pacing_start: "08:30"
  occupancy_pacing_end: "12:30"
  daily_reload_time: "01:00"
  csv_download_urls:
    building: "https://cloud.camlytics.com/feed/report/4f82c3553002b39064ef61fc87cb8621/csv"
    communion: "https://cloud.camlytics.com/feed/report/b09996961a7806ed790996ff451ab2cf/csv"
  buffer_schedule:
    - effective_date: "2000-01-01"
      occupancy_buffer: 0.20
      communion_buffer: 0.05
    - effective_date: "2026-01-19"
      occupancy_buffer: 0.15
      communion_buffer: 0.05
  special_services:
    - date: "2026-01-06"
      label: "Coptic Christmas"
      communion_window_start: "22:00"
      communion_window_end: "23:45"
      occupancy_pacing_start: "19:30"
      occupancy_pacing_end: "23:45"
      service_hour_start: 18
      service_hour_end: 24
```

### 4. Add gateway API endpoints

In `gateway.py`, register these routes (replacing the old proxy-to-port-20857 pattern):

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `GET /api/occupancy/data` | GET | Return cached weekly summary + trends + pacing |
| `POST /api/occupancy/refresh` | POST | Trigger immediate CSV re-scan |
| `GET /api/occupancy/config` | GET | Return buffer schedule + windows |

### 5. Create `frontend/js/pages/occupancy.js` — SPA page

Port the dashboard from `STP_Occupancy/static/app.js` + `templates/dashboard.html`:

- Register as `occupancy: OccupancyPage` in router.js (but NO nav bar button — accessed from people counting panel)
- KPI summary cards: last service communion, peak occupancy, participation ratio, averages
- Chart.js charts (load Chart.js from CDN, add script tag to index.html):
  - Occupancy trend (line chart)
  - Communion trend (line chart)
  - Occupancy vs. Communion comparison (bar chart)
  - Pacing drill-down (15-min intervals, toggleable communion/occupancy)
- Week-over-week summary table
- Manual refresh button
- Buffer schedule display

### 6. Wire people counting panel → occupancy page

Update the existing people counting popup (on main.js) to include a link/button that navigates to `#occupancy` — similar to how the health pills panel has "Open Full Dashboard".

### 7. Add `<script>` tag to `index.html`

```html
<script src="js/pages/occupancy.js?v=26012"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
```

### 8. Start module in `gateway.py`

```python
from occupancy_module import OccupancyModule
occupancy = None if mock_mode else OccupancyModule(cfg, logger)
# In _start_pollers():
if occupancy is not None:
    occupancy.start()
```

## Files Changed

| File | Action |
|------|--------|
| `gateway/occupancy_module.py` | **CREATE** — ~300 lines, pandas-based CSV analytics + scheduled download |
| `gateway/config.yaml` | **MODIFY** — add `occupancy:` section |
| `gateway/gateway.py` | **MODIFY** — import module, add 3 API endpoints, start in pollers |
| `gateway/requirements.txt` | **MODIFY** — add `pandas>=2.0` |
| `frontend/js/pages/occupancy.js` | **CREATE** — SPA dashboard page with Chart.js |
| `frontend/js/router.js` | **MODIFY** — register occupancy page |
| `frontend/index.html` | **MODIFY** — add Chart.js CDN + occupancy.js script tag |
| `frontend/css/styles.css` | **MODIFY** — append occupancy page styles |
| `frontend/js/pages/main.js` | **MODIFY** — add "View Analytics" link in people counting section |
| `CLAUDE.md` | **MODIFY** — mark Phase 6 complete |

## What Gets Retired

- `STP_Occupancy/app.py` (port 20857) — no longer needed as standalone service
- `STP_scripts/DownloadCamlyticsBuildingOccupancy.py` — download absorbed into module
- `STP_scripts/DownloadCamlyticsCommunionCounts.py` — download absorbed into module
- Windows Scheduled Tasks for the above scripts — replaced by gateway's internal scheduler

## Key Decisions

- **pandas dependency**: Required for CSV parsing. ~30MB install but makes the date-windowed aggregation and time-series processing straightforward. No reasonable alternative for what this code does.
- **Chart.js from CDN**: The occupancy dashboard needs charts. Chart.js is loaded from CDN (not bundled) to keep the repo lean. The rest of the frontend is vanilla JS — Chart.js is the only library.
- **No nav bar button**: Occupancy page is accessed from the people counting panel (same pattern as health page accessed from pills), not cluttering the nav bar.
- **CSV directory**: Stays configurable via `occupancy.data_dir`. On Windows it's `C:\Users\info\Box\Reports`. After Mac migration it'll be wherever the CSVs are synced to.
