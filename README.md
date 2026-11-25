# Rain Warning

A lightweight, zero-build Progressive Web App (PWA) for short-range hourly rain probability and precipitation forecasting, combining multiple global and regional weather ensembles into a single actionable view.

## Features

- **Multi-model ensemble forecast**: Aggregates hourly precipitation probability and expected rainfall across up to five models:
  - **NOAA GFS** (`gfs_seamless` via Open-Meteo Forecast API)
  - **ECMWF IFS** (`ecmwf_ifs` via Open-Meteo Forecast API)
  - **DWD ICON** (`icon_seamless` via Open-Meteo Forecast API)
  - **Google DeepMind WeatherNext 3** (`google_weathernext3_ensemble_mean` via Open-Meteo Ensemble Mean API)
  - **NWS** (`api.weather.gov`, automatically included for US locations)
- **At-a-glance verdict & telemetry**: Shows the earliest rain risk meeting your alert threshold, peak probability and time, expected total rainfall over the selected window, and inter-model spread.
- **Interactive hourly chart**:
  - Toggleable **6h / 12h / 24h** forecast horizons
  - Toggleable **individual model lines**, **quantile confidence interval** ($\alpha$ to $1 - \alpha$), and **expected rainfall amount** (metric `mm` or imperial `in`)
  - Dashed warning threshold line synced with your alert threshold
- **Location search & GPS**: Live debounced city autocomplete via Open-Meteo Geocoding plus browser geolocation with OpenStreetMap Nominatim reverse geocoding.
- **Desktop & mobile PWA**:
  - Installable standalone app with offline app-shell caching (`sw.js`)
  - Optional browser rain alert notifications (clicking an alert focuses the app window)
  - Automatic 20-minute background refresh plus wake-from-sleep / reconnect refresh
  - Responsive single-column layout on mobile and compact windows, expanding to a two-column layout on wide desktop screens (`≥ 960px`)

## WeatherNext 3 Integration Notes

Open-Meteo's Ensemble Mean API exposes WeatherNext 3's hourly ensemble `precipitation` mean alongside five percentiles (`p10`, `p25`, `p50`, `p75`, `p90`), rather than a direct `precipitation_probability` field. Rain Warning derives hourly probability of measurable precipitation ($\ge 0.1\text{ mm}$) from those percentiles via piecewise-linear interpolation of the empirical CDF, and includes WeatherNext 3's ensemble mean precipitation in the expected rainfall total.

## Keyboard Shortcuts (Desktop)

| Key | Action |
| --- | --- |
| `/` | Focus city search |
| `R` | Refresh forecast |
| `1` / `2` / `3` | Switch forecast horizon (`6h` / `12h` / `24h`) |
| `M` | Toggle individual model lines |
| `I` | Toggle confidence interval |
| `A` | Toggle expected rainfall amount |

## Project Structure

- `index.html` — Semantic app shell and controls
- `style.css` — Responsive dark oceanic slate design system
- `app.js` — Forecast fetchers, WeatherNext 3 percentile-to-probability estimator, ensemble aggregation, Chart.js controller, autocomplete, and settings persistence
- `sw.js` — Service worker (network-first app shell caching, CDN caching, `notificationclick` window focus)
- `manifest.json` — Web app manifest (`192×192` and `512×512` PNG icons)

## Local Development

No build step or dependencies are required. Serve the directory with any static HTTP server:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

### Syntax & Manifest Checks

```bash
node --check app.js && node --check sw.js && node -e "JSON.parse(require('fs').readFileSync('manifest.json', 'utf8'))"
```