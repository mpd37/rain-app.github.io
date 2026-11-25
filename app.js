/**
 * Rain Warning - Ensemble Forecast Controller
 * Aggregates hourly precipitation forecasts from Open-Meteo (GFS, ECMWF, ICON),
 * Google DeepMind WeatherNext 3 (via Open-Meteo Ensemble Mean API), and NWS.
 */

'use strict';

const CONFIG = {
    refreshIntervalMs: 20 * 60 * 1000,
    searchDebounceMs: 240,
    openMeteoModels: [
        { id: 'gfs', apiKey: 'gfs_seamless' },
        { id: 'ecmwf', apiKey: 'ecmwf_ifs' },
        { id: 'icon', apiKey: 'icon_seamless' },
    ],
    weatherNext3Model: 'google_weathernext3_ensemble_mean',
    precipThresholdMm: 0.1,
    mmPerInch: 25.4,
    defaultLocation: {
        latitude: 49.2827,
        longitude: -123.1207,
        name: 'Vancouver, BC',
    },
    limits: {
        threshold: { min: 0, max: 100 },
        forecastHours: { min: 1, max: 24 },
        alpha: { min: 0.01, max: 0.5 },
    },
    defaults: {
        threshold: 25,
        forecastHours: 12,
        alpha: 0.25,
        unitSystem: 'metric',
        is24HourFormat: false,
        showConfidenceBounds: false,
        showEnsembleMembers: false,
        showExpectedAmount: false,
    },
};

const MODEL_CONFIGS = [
    { id: 'gfs', label: 'GFS', color: 'rgba(74, 222, 128, 0.9)', width: 1.75 },
    { id: 'ecmwf', label: 'ECMWF', color: 'rgba(251, 191, 36, 0.9)', width: 1.75 },
    { id: 'icon', label: 'ICON', color: 'rgba(147, 197, 253, 0.9)', width: 1.75 },
    { id: 'weathernext3', label: 'WeatherNext 3', color: 'rgba(34, 211, 238, 1)', width: 2.25 },
    { id: 'nws', label: 'NWS', color: 'rgba(251, 113, 133, 0.9)', width: 1.75 },
];

const STORAGE_KEYS = {
    location: 'weatherLocation',
    threshold: 'rainWarningThreshold',
    forecastHours: 'forecastHours',
    is24HourFormat: 'is24HourFormat',
    showConfidenceBounds: 'showConfidenceBounds',
    showEnsembleMembers: 'showEnsembleMembers',
    showExpectedAmount: 'showExpectedAmount',
    alpha: 'quantileAlpha',
    unitSystem: 'unitSystem',
};

const DATASET_IDS = {
    ensembleAvg: 'ensemble-avg',
    confidenceUpper: 'confidence-upper',
    confidenceLower: 'confidence-lower',
    forecastAmount: 'forecast-amount',
    modelPrefix: 'model-',
};

const STATUS_ICONS = {
    warning: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"></path><path d="M16 14v6"></path><path d="M8 14v6"></path><path d="M12 16v6"></path></svg>',
    safe: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="m4.93 4.93 1.41 1.41"></path><path d="m17.66 17.66 1.41 1.41"></path><path d="M2 12h2"></path><path d="M20 12h2"></path><path d="m6.34 17.66-1.41 1.41"></path><path d="m19.07 4.93-1.41 1.41"></path></svg>',
    error: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>',
};

// --- Pure Math & Parsing Helpers ---

function clamp(value, min, max, fallback) {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
}

function getQuantile(sortedValues, q) {
    if (!sortedValues.length) return 0;
    const pos = (sortedValues.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (sortedValues[base + 1] !== undefined) {
        return sortedValues[base] + rest * (sortedValues[base + 1] - sortedValues[base]);
    }
    return sortedValues[base];
}

/**
 * Estimates hourly probability of precipitation (>= thresholdMm) from
 * WeatherNext 3 ensemble percentiles (p10, p25, p50, p75, p90) and mean
 * via piecewise-linear interpolation of the empirical CDF.
 */
function estimateProbabilityFromPercentiles(stats, thresholdMm = CONFIG.precipThresholdMm) {
    if (!stats) return null;
    const { p10, p25, p50, p75, p90, mean } = stats;
    const quantiles = [
        [0.10, p10],
        [0.25, p25],
        [0.50, p50],
        [0.75, p75],
        [0.90, p90],
    ];

    if (quantiles.some(([, value]) => !Number.isFinite(value))) {
        return null;
    }

    if (p90 < thresholdMm) {
        // More than 90% of ensemble members are below threshold; if the mean still reaches
        // threshold, a rare upper-tail precipitation signal (<10% probability) is present.
        return Number.isFinite(mean) && mean >= thresholdMm ? 5 : 0;
    }

    const points = [[0, 0], ...quantiles];
    for (let i = 1; i < points.length; i++) {
        const [q0, v0] = points[i - 1];
        const [q1, v1] = points[i];
        if (v1 >= thresholdMm) {
            const cdf = v1 <= v0
                ? q1
                : q0 + ((thresholdMm - v0) / (v1 - v0)) * (q1 - q0);
            return clamp((1 - cdf) * 100, 0, 100, 0);
        }
    }

    return 0;
}

function parseUtcHourTimestamp(isoString) {
    if (typeof isoString !== 'string') return NaN;
    const normalized = /(?:Z|[+-]\d{2}:\d{2})$/.test(isoString) ? isoString : `${isoString}Z`;
    return Date.parse(normalized);
}

function parseOpenMeteoForecast(raw) {
    const maps = {};
    for (const model of CONFIG.openMeteoModels) {
        maps[model.id] = new Map();
    }

    const hourly = raw?.hourly;
    if (!hourly || !Array.isArray(hourly.time)) return maps;

    for (let i = 0; i < hourly.time.length; i++) {
        const ts = parseUtcHourTimestamp(hourly.time[i]);
        if (!Number.isFinite(ts)) continue;

        for (const model of CONFIG.openMeteoModels) {
            const prob = hourly[`precipitation_probability_${model.apiKey}`]?.[i];
            const precip = hourly[`precipitation_${model.apiKey}`]?.[i];
            const hasProb = Number.isFinite(prob);
            const hasPrecip = Number.isFinite(precip);

            if (hasProb || hasPrecip) {
                maps[model.id].set(ts, {
                    probability: hasProb ? prob : null,
                    precipitationMm: hasPrecip ? precip : null,
                });
            }
        }
    }

    return maps;
}

function parseWeatherNext3Forecast(raw) {
    const map = new Map();
    const hourly = raw?.hourly;
    if (!hourly || !Array.isArray(hourly.time)) return map;

    for (let i = 0; i < hourly.time.length; i++) {
        const ts = parseUtcHourTimestamp(hourly.time[i]);
        if (!Number.isFinite(ts)) continue;

        const mean = hourly.precipitation?.[i];
        const probability = estimateProbabilityFromPercentiles({
            p10: hourly.precipitation_p10?.[i],
            p25: hourly.precipitation_p25?.[i],
            p50: hourly.precipitation_p50?.[i],
            p75: hourly.precipitation_p75?.[i],
            p90: hourly.precipitation_p90?.[i],
            mean,
        });
        const precipitationMm = Number.isFinite(mean) ? mean : null;

        if (probability !== null || precipitationMm !== null) {
            map.set(ts, { probability, precipitationMm });
        }
    }

    return map;
}

function parseNWSForecast(raw) {
    const map = new Map();
    const periods = raw?.properties?.periods;
    if (!Array.isArray(periods)) return map;

    for (const period of periods) {
        const ts = Date.parse(period.startTime);
        if (!Number.isFinite(ts)) continue;
        const probValue = period.probabilityOfPrecipitation?.value;
        map.set(ts, {
            probability: Number.isFinite(probValue) ? probValue : 0,
            precipitationMm: null,
        });
    }

    return map;
}

function buildForecastSeries(modelMaps, options) {
    const {
        now = new Date(),
        forecastHours,
        threshold,
        alpha,
        unitSystem,
        is24HourFormat,
    } = options;

    const hourMs = 3600 * 1000;
    const startUtcMs = Math.floor(now.getTime() / hourMs) * hourMs;
    const timestamps = Array.from({ length: forecastHours }, (_, i) => startUtcMs + i * hourMs);

    const activeModels = [];
    const modelSeries = {};

    for (const cfg of MODEL_CONFIGS) {
        const modelMap = modelMaps[cfg.id];
        const series = timestamps.map((ts) => {
            const point = modelMap?.get(ts);
            return point && Number.isFinite(point.probability) ? point.probability : NaN;
        });
        modelSeries[cfg.id] = series;

        const hasAnyData = timestamps.some((ts) => {
            const point = modelMap?.get(ts);
            return point && (Number.isFinite(point.probability) || Number.isFinite(point.precipitationMm));
        });
        if (hasAnyData) {
            activeModels.push(cfg);
        }
    }

    const labels = [];
    const ensembleAverage = [];
    const forecastAmount = [];
    const confidence = { upper: [], lower: [] };
    let firstWarning = null;
    let peak = { probability: -1, time: new Date(startUtcMs) };
    let totalAmount = 0;
    let spreadSum = 0;
    let spreadCount = 0;

    for (let i = 0; i < timestamps.length; i++) {
        const ts = timestamps[i];
        const forecastTime = new Date(ts);
        labels.push(forecastTime.toLocaleTimeString([], { hour: 'numeric', hour12: !is24HourFormat }));

        const probabilities = [];
        const precipitationsMm = [];

        for (const cfg of activeModels) {
            const point = modelMaps[cfg.id]?.get(ts);
            if (!point) continue;
            if (Number.isFinite(point.probability)) probabilities.push(point.probability);
            if (Number.isFinite(point.precipitationMm)) precipitationsMm.push(point.precipitationMm);
        }

        const probAvg = probabilities.length > 0
            ? probabilities.reduce((sum, val) => sum + val, 0) / probabilities.length
            : 0;
        ensembleAverage.push(probAvg);

        if (probAvg > peak.probability) {
            peak = { probability: Math.round(probAvg), time: forecastTime };
        }

        const precipAvgMm = precipitationsMm.length > 0
            ? precipitationsMm.reduce((sum, val) => sum + val, 0) / precipitationsMm.length
            : 0;
        const precipDisplay = unitSystem === 'imperial' ? precipAvgMm / CONFIG.mmPerInch : precipAvgMm;
        forecastAmount.push(precipDisplay);
        totalAmount += precipDisplay;

        if (probabilities.length > 1) {
            const sorted = [...probabilities].sort((a, b) => a - b);
            const lower = getQuantile(sorted, alpha);
            const upper = getQuantile(sorted, 1 - alpha);
            confidence.lower.push(lower);
            confidence.upper.push(upper);
            spreadSum += (upper - lower) / 2;
            spreadCount += 1;
        } else {
            const singleVal = probabilities[0] ?? 0;
            confidence.lower.push(singleVal);
            confidence.upper.push(singleVal);
        }

        if (!firstWarning && probAvg >= threshold) {
            firstWarning = { probability: Math.round(probAvg), time: forecastTime };
        }
    }

    return {
        labels,
        activeModels,
        ensembleAverage,
        modelSeries,
        confidence,
        forecastAmount,
        firstWarning,
        peak: { probability: Math.max(0, peak.probability), time: peak.time },
        totalAmount,
        avgHalfSpread: spreadCount > 0 ? Math.round(spreadSum / spreadCount) : null,
    };
}

// --- Browser Application Controller ---

function initApp() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js')
            .catch((err) => console.warn('Service Worker registration failed:', err));
    }

    // --- DOM Elements ---
    const dom = {
        weatherInfo: document.getElementById('weather-info'),
        warningMessage: document.getElementById('warning-message'),
        metricsStrip: document.getElementById('metrics-strip'),
        metricPeak: document.getElementById('metric-peak'),
        metricPeakTime: document.getElementById('metric-peak-time'),
        metricTotal: document.getElementById('metric-total'),
        metricTotalWindow: document.getElementById('metric-total-window'),
        metricSpread: document.getElementById('metric-spread'),
        metricModelsCount: document.getElementById('metric-models-count'),
        lastUpdated: document.getElementById('last-updated'),
        notificationBtn: document.getElementById('notification-btn'),
        notificationStatus: document.getElementById('notification-status'),
        locationForm: document.getElementById('location-form'),
        locationInput: document.getElementById('location-input'),
        searchSuggestions: document.getElementById('search-suggestions'),
        locationDisplay: document.getElementById('location-display'),
        gpsButton: document.getElementById('gps-button'),
        refreshButton: document.getElementById('refresh-button'),
        chartCanvas: document.getElementById('rainChart'),
        horizonButtons: Array.from(document.querySelectorAll('.horizon-btn')),
        chipModels: document.getElementById('chip-models'),
        chipConfidence: document.getElementById('chip-confidence'),
        chipAmount: document.getElementById('chip-amount'),
        thresholdInput: document.getElementById('threshold-input'),
        forecastHoursInput: document.getElementById('forecast-hours-input'),
        timeFormatToggle: document.getElementById('time-format-toggle'),
        confidenceToggle: document.getElementById('confidence-toggle'),
        showEnsembleToggle: document.getElementById('show-ensemble-toggle'),
        showAmountToggle: document.getElementById('show-amount-toggle'),
        alphaInput: document.getElementById('alpha-input'),
        unitSystemSelect: document.getElementById('unit-system-select'),
        dataSource: document.getElementById('data-source'),
        installButton: document.getElementById('install-button'),
    };

    // --- App State ---
    const state = {
        latitude: null,
        longitude: null,
        locationName: '',
        threshold: CONFIG.defaults.threshold,
        forecastHours: CONFIG.defaults.forecastHours,
        alpha: CONFIG.defaults.alpha,
        unitSystem: CONFIG.defaults.unitSystem,
        is24HourFormat: CONFIG.defaults.is24HourFormat,
        showConfidenceBounds: CONFIG.defaults.showConfidenceBounds,
        showEnsembleMembers: CONFIG.defaults.showEnsembleMembers,
        showExpectedAmount: CONFIG.defaults.showExpectedAmount,
        lastModelMaps: null,
        lastFetchedAt: null,
        lastNotifiedKey: null,
        refreshTimerId: null,
        activeAbortController: null,
        searchAbortController: null,
        searchDebounceId: null,
        suggestions: [],
        activeSuggestionIndex: -1,
        rainChart: null,
        deferredInstallPrompt: null,
    };

    // --- Safe Storage Helpers ---
    function readStorage(key) {
        try {
            return localStorage.getItem(key);
        } catch {
            return null;
        }
    }

    function writeStorage(key, value) {
        try {
            localStorage.setItem(key, String(value));
        } catch {
            // Ignore storage quota / privacy mode errors
        }
    }

    function formatClockTime(date, includeMinutes = true) {
        const opts = includeMinutes
            ? { hour: 'numeric', minute: '2-digit', hour12: !state.is24HourFormat }
            : { hour: 'numeric', hour12: !state.is24HourFormat };
        return date.toLocaleTimeString([], opts);
    }

    function formatPrecipAmount(value, unitSystem) {
        if (unitSystem === 'imperial') {
            return `${value < 0.01 && value > 0 ? '<0.01' : value.toFixed(2)} in`;
        }
        return `${value.toFixed(1)} mm`;
    }

    // --- PWA Install Prompt ---
    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        state.deferredInstallPrompt = event;
        if (dom.installButton) dom.installButton.style.display = 'block';
    });

    if (dom.installButton) {
        dom.installButton.addEventListener('click', async () => {
            if (!state.deferredInstallPrompt) return;
            state.deferredInstallPrompt.prompt();
            await state.deferredInstallPrompt.userChoice;
            state.deferredInstallPrompt = null;
            dom.installButton.style.display = 'none';
        });
    }

    // --- Toolbar & Controls Sync ---
    function syncQuickControls() {
        for (const btn of dom.horizonButtons) {
            const hours = parseInt(btn.dataset.hours, 10);
            btn.classList.toggle('active', hours === state.forecastHours);
        }
        if (dom.chipModels) dom.chipModels.setAttribute('aria-pressed', String(state.showEnsembleMembers));
        if (dom.chipConfidence) dom.chipConfidence.setAttribute('aria-pressed', String(state.showConfidenceBounds));
        if (dom.chipAmount) dom.chipAmount.setAttribute('aria-pressed', String(state.showExpectedAmount));

        if (dom.forecastHoursInput) dom.forecastHoursInput.value = state.forecastHours;
        if (dom.showEnsembleToggle) dom.showEnsembleToggle.checked = state.showEnsembleMembers;
        if (dom.confidenceToggle) dom.confidenceToggle.checked = state.showConfidenceBounds;
        if (dom.showAmountToggle) dom.showAmountToggle.checked = state.showExpectedAmount;
    }

    // --- Chart Management ---
    function getDataset(id) {
        return state.rainChart?.data.datasets.find((ds) => ds.id === id) ?? null;
    }

    function syncDatasetVisibility(updateMode) {
        if (!state.rainChart) return;

        const upper = getDataset(DATASET_IDS.confidenceUpper);
        const lower = getDataset(DATASET_IDS.confidenceLower);
        const amount = getDataset(DATASET_IDS.forecastAmount);

        if (upper) upper.hidden = !state.showConfidenceBounds;
        if (lower) lower.hidden = !state.showConfidenceBounds;
        if (amount) amount.hidden = !state.showExpectedAmount;

        state.rainChart.options.scales.y1.display = state.showExpectedAmount;
        syncQuickControls();
        if (updateMode === 'none') {
            state.rainChart.stop();
        }
        state.rainChart.update();
    }

    function initializeChart() {
        if (!dom.chartCanvas || typeof Chart === 'undefined') return;
        const ctx = dom.chartCanvas.getContext('2d');

        Chart.defaults.color = '#8295ab';
        Chart.defaults.font.family = "'Plus Jakarta Sans', -apple-system, sans-serif";
        Chart.defaults.borderColor = 'rgba(255, 255, 255, 0.05)';

        const modelDatasets = MODEL_CONFIGS.map((cfg) => ({
            id: `${DATASET_IDS.modelPrefix}${cfg.id}`,
            modelId: cfg.id,
            label: cfg.label,
            data: [],
            yAxisID: 'y',
            type: 'line',
            borderColor: cfg.color,
            backgroundColor: cfg.color,
            borderWidth: cfg.width,
            tension: 0.3,
            fill: false,
            pointRadius: 0,
            pointHoverRadius: 4,
            order: 1,
            hidden: true,
        }));

        state.rainChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: [],
                datasets: [
                    {
                        id: DATASET_IDS.ensembleAvg,
                        label: 'Ensemble Avg',
                        data: [],
                        yAxisID: 'y',
                        backgroundColor: 'rgba(56, 189, 248, 0.35)',
                        borderColor: 'rgba(56, 189, 248, 0.78)',
                        borderWidth: 1,
                        borderRadius: { topLeft: 5, topRight: 5 },
                        borderSkipped: 'bottom',
                        maxBarThickness: 28,
                        order: 2,
                    },
                    ...modelDatasets,
                    {
                        id: DATASET_IDS.confidenceUpper,
                        label: 'Confidence Interval',
                        data: [],
                        yAxisID: 'y',
                        fill: '+1',
                        backgroundColor: 'rgba(148, 163, 184, 0.14)',
                        borderColor: 'transparent',
                        pointRadius: 0,
                        tension: 0.25,
                        type: 'line',
                        order: 0,
                        hidden: true,
                    },
                    {
                        id: DATASET_IDS.confidenceLower,
                        label: 'Lower Bound',
                        data: [],
                        yAxisID: 'y',
                        fill: false,
                        borderColor: 'transparent',
                        pointRadius: 0,
                        tension: 0.25,
                        type: 'line',
                        hidden: true,
                    },
                    {
                        id: DATASET_IDS.forecastAmount,
                        label: 'Expected Amount',
                        data: [],
                        yAxisID: 'y1',
                        backgroundColor: 'rgba(251, 191, 36, 0.3)',
                        borderColor: 'rgba(251, 191, 36, 0.85)',
                        borderWidth: 1,
                        borderRadius: { topLeft: 4, topRight: 4 },
                        maxBarThickness: 18,
                        order: 3,
                        hidden: true,
                    },
                ],
            },
            options: {
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                scales: {
                    y: {
                        type: 'linear',
                        position: 'left',
                        beginAtZero: true,
                        max: 100,
                        ticks: {
                            stepSize: 25,
                            callback: (val) => `${val}%`,
                            font: { family: "'JetBrains Mono', monospace", size: 10 },
                        },
                        grid: { color: 'rgba(255, 255, 255, 0.045)' },
                        border: { display: false },
                    },
                    y1: {
                        type: 'linear',
                        position: 'right',
                        display: false,
                        beginAtZero: true,
                        ticks: {
                            font: { family: "'JetBrains Mono', monospace", size: 10 },
                        },
                        title: {
                            display: true,
                            text: 'Amount (mm)',
                            color: '#94a3b8',
                            font: { size: 10, weight: 600 },
                        },
                        grid: { drawOnChartArea: false },
                        border: { display: false },
                    },
                    x: {
                        grid: { display: false },
                        border: { display: false },
                        ticks: {
                            font: { family: "'JetBrains Mono', monospace", size: 10 },
                            maxRotation: 0,
                            autoSkipPadding: 8,
                        },
                    },
                },
                plugins: {
                    tooltip: {
                        backgroundColor: 'rgba(9, 19, 29, 0.94)',
                        titleColor: '#f1f5f9',
                        bodyColor: '#cbd5e1',
                        borderColor: 'rgba(255, 255, 255, 0.14)',
                        borderWidth: 1,
                        padding: 10,
                        cornerRadius: 8,
                        displayColors: true,
                        boxPadding: 4,
                        filter: (item) => item.dataset.id !== DATASET_IDS.confidenceLower,
                        callbacks: {
                            label: (context) => {
                                const value = context.parsed.y;
                                if (!Number.isFinite(value)) return null;
                                if (context.dataset.id === DATASET_IDS.forecastAmount) {
                                    const unit = state.unitSystem === 'imperial' ? 'in' : 'mm';
                                    const decimals = state.unitSystem === 'imperial' ? 3 : 2;
                                    return ` ${context.dataset.label}: ${value.toFixed(decimals)} ${unit}`;
                                }
                                if (context.dataset.id === DATASET_IDS.confidenceUpper) {
                                    const lowerVal = getDataset(DATASET_IDS.confidenceLower)?.data?.[context.dataIndex];
                                    if (Number.isFinite(lowerVal)) {
                                        return ` ${context.dataset.label}: ${Math.round(lowerVal)}%–${Math.round(value)}%`;
                                    }
                                }
                                return ` ${context.dataset.label}: ${Math.round(value)}%`;
                            },
                        },
                    },
                    legend: {
                        display: true,
                        position: 'bottom',
                        labels: {
                            usePointStyle: true,
                            pointStyle: 'circle',
                            boxWidth: 7,
                            boxHeight: 7,
                            padding: 14,
                            font: { size: 11, weight: 500 },
                        },
                        onClick: (event, legendItem, legend) => {
                            const chart = legend.chart;
                            const dataset = chart.data.datasets[legendItem.datasetIndex];
                            if (!dataset) return;

                            if (dataset.id === DATASET_IDS.confidenceUpper) {
                                state.showConfidenceBounds = !state.showConfidenceBounds;
                                writeStorage(STORAGE_KEYS.showConfidenceBounds, state.showConfidenceBounds);
                                syncDatasetVisibility();
                                return;
                            }

                            if (dataset.id === DATASET_IDS.forecastAmount) {
                                state.showExpectedAmount = !state.showExpectedAmount;
                                writeStorage(STORAGE_KEYS.showExpectedAmount, state.showExpectedAmount);
                                syncDatasetVisibility();
                                return;
                            }

                            Chart.defaults.plugins.legend.onClick.call(chart, event, legendItem, legend);
                        },
                    },
                    annotation: {
                        annotations: {
                            thresholdLine: {
                                type: 'line',
                                scaleID: 'y',
                                value: state.threshold,
                                drawTime: 'afterDatasetsDraw',
                                borderColor: 'rgba(251, 191, 36, 0.85)',
                                borderWidth: 1.5,
                                borderDash: [5, 4],
                                label: {
                                    display: true,
                                    content: `${state.threshold}%`,
                                    position: 'end',
                                    backgroundColor: 'rgba(9, 19, 29, 0.9)',
                                    color: '#fbbf24',
                                    font: { family: "'JetBrains Mono', monospace", size: 10, weight: 600 },
                                    padding: { x: 6, y: 2 },
                                    borderRadius: 4,
                                },
                            },
                        },
                    },
                },
            },
        });
    }

    function updateChart(series) {
        if (!state.rainChart) initializeChart();
        if (!state.rainChart) return;

        const activeIds = new Set(series.activeModels.map((m) => m.id));

        state.rainChart.options.plugins.legend.labels.filter = (item, chartData) => {
            const ds = chartData.datasets[item.datasetIndex];
            if (!ds) return false;
            if (ds.id === DATASET_IDS.ensembleAvg) return true;
            if (ds.id === DATASET_IDS.confidenceUpper) return state.showConfidenceBounds;
            if (ds.id === DATASET_IDS.forecastAmount) return state.showExpectedAmount;
            if (ds.id === DATASET_IDS.confidenceLower) return false;
            return state.showEnsembleMembers && activeIds.has(ds.modelId);
        };

        state.rainChart.data.labels = series.labels;

        const ensembleDs = getDataset(DATASET_IDS.ensembleAvg);
        ensembleDs.data = series.ensembleAverage;
        ensembleDs.backgroundColor = series.ensembleAverage.map((val) =>
            val >= state.threshold ? 'rgba(56, 189, 248, 0.56)' : 'rgba(56, 189, 248, 0.24)'
        );
        ensembleDs.borderColor = series.ensembleAverage.map((val) =>
            val >= state.threshold ? 'rgba(125, 211, 252, 0.92)' : 'rgba(56, 189, 248, 0.55)'
        );

        getDataset(DATASET_IDS.confidenceUpper).data = series.confidence.upper;
        getDataset(DATASET_IDS.confidenceLower).data = series.confidence.lower;
        getDataset(DATASET_IDS.forecastAmount).data = series.forecastAmount;

        for (const cfg of MODEL_CONFIGS) {
            const ds = getDataset(`${DATASET_IDS.modelPrefix}${cfg.id}`);
            if (!ds) continue;
            ds.data = series.modelSeries[cfg.id] || [];
            ds.hidden = !state.showEnsembleMembers || !activeIds.has(cfg.id);
        }

        const thresholdLine = state.rainChart.options.plugins.annotation?.annotations?.thresholdLine;
        if (thresholdLine) {
            thresholdLine.value = state.threshold;
            if (thresholdLine.label) {
                thresholdLine.label.content = `${state.threshold}%`;
            }
        }

        const precipUnitLabel = state.unitSystem === 'imperial' ? 'in' : 'mm';
        state.rainChart.options.scales.y1.title.text = `Amount (${precipUnitLabel})`;

        syncDatasetVisibility();
    }

    // --- Notifications ---
    function syncNotificationStatus() {
        if (!dom.notificationStatus) return;
        if (!('Notification' in window)) {
            dom.notificationStatus.textContent = 'Unsupported';
            return;
        }
        if (Notification.permission === 'granted') {
            dom.notificationStatus.textContent = 'On';
        } else if (Notification.permission === 'denied') {
            dom.notificationStatus.textContent = 'Blocked';
        } else {
            dom.notificationStatus.textContent = 'Enable';
        }
    }

    function requestNotificationPermission() {
        if (!('Notification' in window) || Notification.permission !== 'default') {
            syncNotificationStatus();
            return;
        }
        Notification.requestPermission().then(() => syncNotificationStatus());
    }

    function sendNotification(title, body, dedupeKey) {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        if (dedupeKey && state.lastNotifiedKey === dedupeKey) return;
        state.lastNotifiedKey = dedupeKey ?? null;

        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.ready
                .then((reg) => reg.showNotification(title, { body, icon: 'icon-192.png' }))
                .catch(() => {});
        }
    }

    // --- UI Feedback ---
    function setLoadingState(message) {
        if (dom.refreshButton) dom.refreshButton.classList.add('is-loading');
        if (dom.weatherInfo) {
            dom.weatherInfo.classList.remove('hidden');
            const textEl = dom.weatherInfo.querySelector('.loading-text');
            if (textEl) textEl.textContent = message;
        }
        if (dom.warningMessage) dom.warningMessage.classList.add('hidden');
    }

    function hideLoadingState() {
        if (dom.refreshButton) dom.refreshButton.classList.remove('is-loading');
        if (dom.weatherInfo) dom.weatherInfo.classList.add('hidden');
    }

    function renderStatusBanner(type, headline, detail) {
        if (!dom.warningMessage) return;
        dom.warningMessage.className = `status-banner ${type}`;
        dom.warningMessage.textContent = '';

        const iconWrap = document.createElement('span');
        iconWrap.className = 'status-icon';
        iconWrap.innerHTML = STATUS_ICONS[type] || STATUS_ICONS.safe;

        const copy = document.createElement('div');
        copy.className = 'status-copy';

        const titleEl = document.createElement('p');
        titleEl.className = 'status-headline';
        titleEl.textContent = headline;

        copy.appendChild(titleEl);
        if (detail) {
            const detailEl = document.createElement('p');
            detailEl.className = 'status-detail';
            detailEl.textContent = detail;
            copy.appendChild(detailEl);
        }

        dom.warningMessage.append(iconWrap, copy);
    }

    function handleFetchError(message) {
        hideLoadingState();
        document.body.classList.remove('state-warning');
        renderStatusBanner('error', message, 'Try refreshing or searching for another city.');
    }

    function displayWarning(probability, time, shouldNotify) {
        const formattedTime = formatClockTime(time, true);
        renderStatusBanner(
            'warning',
            `Rain likely around ${formattedTime}`,
            `${probability}% ensemble average · meets ≥${state.threshold}% alert threshold`
        );
        document.body.classList.add('state-warning');

        if (shouldNotify) {
            const key = `${state.locationName}|${time.toISOString()}|${state.threshold}`;
            sendNotification(
                'Rain Warning',
                `${probability}% chance of rain around ${formattedTime} in ${state.locationName}.`,
                key
            );
        }
    }

    function displaySafeMessage() {
        renderStatusBanner(
            'safe',
            `Clear for the next ${state.forecastHours} hours`,
            `Rain risk stays below your ${state.threshold}% alert threshold`
        );
        document.body.classList.remove('state-warning');
        state.lastNotifiedKey = null;
    }

    function updateMetricsStrip(series) {
        if (!dom.metricsStrip) return;
        dom.metricsStrip.classList.remove('hidden');

        if (dom.metricPeak) dom.metricPeak.textContent = `${series.peak.probability}%`;
        if (dom.metricPeakTime) {
            dom.metricPeakTime.textContent = series.peak.probability > 0
                ? `at ${formatClockTime(series.peak.time, false)}`
                : 'dry window';
        }

        if (dom.metricTotal) dom.metricTotal.textContent = formatPrecipAmount(series.totalAmount, state.unitSystem);
        if (dom.metricTotalWindow) dom.metricTotalWindow.textContent = `next ${state.forecastHours}h`;

        if (dom.metricSpread) {
            dom.metricSpread.textContent = series.avgHalfSpread !== null ? `±${series.avgHalfSpread}%` : '--';
        }
        if (dom.metricModelsCount) {
            const count = series.activeModels.length;
            dom.metricModelsCount.textContent = `${count} ${count === 1 ? 'model' : 'models'}`;
        }
    }

    // --- Network Fetchers ---
    async function fetchJson(url, signal) {
        const response = await fetch(url, { signal });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        return response.json();
    }

    async function fetchOpenMeteoForecast(lat, lon, signal) {
        const modelsParam = CONFIG.openMeteoModels.map((m) => m.apiKey).join(',');
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=precipitation_probability,precipitation&models=${modelsParam}&precipitation_unit=mm&forecast_days=2`;
        const data = await fetchJson(url, signal);
        if (data.error) throw new Error(data.reason || 'Open-Meteo API error');
        return parseOpenMeteoForecast(data);
    }

    async function fetchWeatherNext3Forecast(lat, lon, signal) {
        const hourlyVars = [
            'precipitation',
            'precipitation_p10',
            'precipitation_p25',
            'precipitation_p50',
            'precipitation_p75',
            'precipitation_p90',
        ].join(',');
        const url = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${lat}&longitude=${lon}&hourly=${hourlyVars}&models=${CONFIG.weatherNext3Model}&precipitation_unit=mm&forecast_days=2`;
        const data = await fetchJson(url, signal);
        if (data.error) throw new Error(data.reason || 'WeatherNext 3 API error');
        return parseWeatherNext3Forecast(data);
    }

    async function fetchNWSForecast(lat, lon, signal) {
        const pointsData = await fetchJson(
            `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
            signal
        );
        const hourlyUrl = pointsData?.properties?.forecastHourly;
        if (!hourlyUrl) return new Map();

        const hourlyData = await fetchJson(hourlyUrl, signal);
        return parseNWSForecast(hourlyData);
    }

    async function refreshWeatherData() {
        if (!Number.isFinite(state.latitude) || !Number.isFinite(state.longitude)) return;

        if (state.activeAbortController) {
            state.activeAbortController.abort();
        }
        const controller = new AbortController();
        state.activeAbortController = controller;

        setLoadingState('Fetching ensemble forecast...');

        const [openMeteoResult, weatherNext3Result, nwsResult] = await Promise.allSettled([
            fetchOpenMeteoForecast(state.latitude, state.longitude, controller.signal),
            fetchWeatherNext3Forecast(state.latitude, state.longitude, controller.signal),
            fetchNWSForecast(state.latitude, state.longitude, controller.signal),
        ]);

        if (controller.signal.aborted) return;

        const openMeteoMaps = openMeteoResult.status === 'fulfilled' ? openMeteoResult.value : {};
        const modelMaps = {
            gfs: openMeteoMaps.gfs ?? new Map(),
            ecmwf: openMeteoMaps.ecmwf ?? new Map(),
            icon: openMeteoMaps.icon ?? new Map(),
            weathernext3: weatherNext3Result.status === 'fulfilled' ? weatherNext3Result.value : new Map(),
            nws: nwsResult.status === 'fulfilled' ? nwsResult.value : new Map(),
        };

        const hasAnyData = Object.values(modelMaps).some((map) => map.size > 0);
        if (!hasAnyData) {
            handleFetchError('Could not retrieve weather data.');
            return;
        }

        state.lastModelMaps = modelMaps;
        state.lastFetchedAt = new Date();
        renderForecast({ notify: true });
    }

    function renderForecast({ notify = false } = {}) {
        if (!state.lastModelMaps) return;
        hideLoadingState();

        const now = state.lastFetchedAt ?? new Date();
        const series = buildForecastSeries(state.lastModelMaps, {
            now,
            forecastHours: state.forecastHours,
            threshold: state.threshold,
            alpha: state.alpha,
            unitSystem: state.unitSystem,
            is24HourFormat: state.is24HourFormat,
        });

        if (dom.dataSource) {
            const names = series.activeModels.map((m) => m.label);
            dom.dataSource.textContent = `Sources: ${names.join(' · ') || 'None'}`;
        }

        if (series.firstWarning) {
            displayWarning(series.firstWarning.probability, series.firstWarning.time, notify);
        } else {
            displaySafeMessage();
        }

        updateMetricsStrip(series);
        updateChart(series);

        if (dom.lastUpdated) {
            dom.lastUpdated.textContent = formatClockTime(now, true);
        }
    }

    // --- Location Search & Autocomplete ---
    function formatLocationLabel(loc) {
        const region = loc.admin1 || loc.country;
        return region ? `${loc.name}, ${region}` : loc.name;
    }

    function closeSuggestions() {
        state.suggestions = [];
        state.activeSuggestionIndex = -1;
        if (dom.searchSuggestions) {
            dom.searchSuggestions.classList.add('hidden');
            dom.searchSuggestions.textContent = '';
        }
        if (dom.locationInput) {
            dom.locationInput.setAttribute('aria-expanded', 'false');
        }
    }

    function renderSuggestions(results) {
        if (!dom.searchSuggestions) return;
        state.suggestions = results;
        state.activeSuggestionIndex = -1;
        dom.searchSuggestions.textContent = '';

        if (!results.length) {
            closeSuggestions();
            return;
        }

        results.forEach((loc, idx) => {
            const li = document.createElement('li');
            li.className = 'suggestion-item';
            li.setAttribute('role', 'option');
            li.dataset.index = String(idx);

            const nameEl = document.createElement('span');
            nameEl.className = 'suggestion-name';
            nameEl.textContent = loc.name;

            const regionEl = document.createElement('span');
            regionEl.className = 'suggestion-region';
            regionEl.textContent = [loc.admin1, loc.country].filter(Boolean).join(', ');

            li.append(nameEl, regionEl);
            li.addEventListener('mousedown', (event) => {
                event.preventDefault();
                selectSuggestion(loc);
            });
            dom.searchSuggestions.appendChild(li);
        });

        dom.searchSuggestions.classList.remove('hidden');
        if (dom.locationInput) {
            dom.locationInput.setAttribute('aria-expanded', 'true');
        }
    }

    function highlightSuggestion(index) {
        if (!dom.searchSuggestions) return;
        const items = dom.searchSuggestions.querySelectorAll('.suggestion-item');
        items.forEach((item, i) => item.classList.toggle('is-active', i === index));
        state.activeSuggestionIndex = index;
    }

    function selectSuggestion(loc) {
        closeSuggestions();
        if (dom.locationInput) {
            dom.locationInput.value = '';
            dom.locationInput.blur();
        }
        saveAndSetLocation(loc.latitude, loc.longitude, formatLocationLabel(loc));
    }

    async function fetchLocationSuggestions(query) {
        if (state.searchAbortController) {
            state.searchAbortController.abort();
        }
        const controller = new AbortController();
        state.searchAbortController = controller;

        const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=5&language=en&format=json`;
        try {
            const data = await fetchJson(url, controller.signal);
            if (controller.signal.aborted) return;
            renderSuggestions(data.results || []);
        } catch {
            if (!controller.signal.aborted) closeSuggestions();
        }
    }

    function saveAndSetLocation(lat, lon, name) {
        writeStorage(STORAGE_KEYS.location, JSON.stringify({ latitude: lat, longitude: lon, name }));
        setLocation(lat, lon, name);
    }

    function setLocation(lat, lon, name) {
        state.latitude = lat;
        state.longitude = lon;
        state.locationName = name;
        state.lastNotifiedKey = null;

        if (dom.locationDisplay) dom.locationDisplay.textContent = name;

        if (state.refreshTimerId) clearInterval(state.refreshTimerId);
        refreshWeatherData();
        state.refreshTimerId = setInterval(refreshWeatherData, CONFIG.refreshIntervalMs);
    }

    function loadSavedLocation() {
        const raw = readStorage(STORAGE_KEYS.location);
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                if (Number.isFinite(parsed?.latitude) && Number.isFinite(parsed?.longitude) && parsed?.name) {
                    setLocation(parsed.latitude, parsed.longitude, parsed.name);
                    return;
                }
            } catch {
                // Fall back to default location on malformed storage
            }
        }
        const { latitude, longitude, name } = CONFIG.defaultLocation;
        setLocation(latitude, longitude, name);
    }

    async function searchLocation(locationName) {
        closeSuggestions();
        setLoadingState('Finding location...');
        const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(locationName)}&count=1&language=en&format=json`;
        try {
            const data = await fetchJson(url);
            const loc = data.results?.[0];
            if (!loc) {
                handleFetchError(`Location "${locationName}" not found.`);
                return;
            }
            if (dom.locationInput) {
                dom.locationInput.value = '';
                dom.locationInput.blur();
            }
            saveAndSetLocation(loc.latitude, loc.longitude, formatLocationLabel(loc));
        } catch {
            handleFetchError('Failed to look up location.');
        }
    }

    async function reverseGeocode(lat, lon) {
        setLoadingState('Getting location name...');
        const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&accept-language=en`;
        try {
            const data = await fetchJson(url);
            const address = data.address;
            const displayName = address?.city || address?.town || address?.village || 'Current Location';
            saveAndSetLocation(lat, lon, displayName);
        } catch (error) {
            console.warn('Reverse geocoding failed:', error);
            saveAndSetLocation(lat, lon, `Lat: ${lat.toFixed(2)}, Lon: ${lon.toFixed(2)}`);
        }
    }

    function handleGpsClick() {
        if (!navigator.geolocation) {
            handleFetchError('Geolocation is not supported by this browser.');
            return;
        }
        setLoadingState('Getting GPS signal...');
        navigator.geolocation.getCurrentPosition(
            (position) => reverseGeocode(position.coords.latitude, position.coords.longitude),
            (error) => handleFetchError(`GPS Error: ${error.message}`)
        );
    }

    // --- Settings Persistence & Event Binding ---
    function loadSavedSettings() {
        state.threshold = clamp(
            parseInt(readStorage(STORAGE_KEYS.threshold), 10),
            CONFIG.limits.threshold.min,
            CONFIG.limits.threshold.max,
            CONFIG.defaults.threshold
        );
        state.forecastHours = clamp(
            parseInt(readStorage(STORAGE_KEYS.forecastHours), 10),
            CONFIG.limits.forecastHours.min,
            CONFIG.limits.forecastHours.max,
            CONFIG.defaults.forecastHours
        );
        state.alpha = clamp(
            parseFloat(readStorage(STORAGE_KEYS.alpha)),
            CONFIG.limits.alpha.min,
            CONFIG.limits.alpha.max,
            CONFIG.defaults.alpha
        );
        state.is24HourFormat = readStorage(STORAGE_KEYS.is24HourFormat) === 'true';
        state.showConfidenceBounds = readStorage(STORAGE_KEYS.showConfidenceBounds) === 'true';
        state.showEnsembleMembers = readStorage(STORAGE_KEYS.showEnsembleMembers) === 'true';
        state.showExpectedAmount = readStorage(STORAGE_KEYS.showExpectedAmount) === 'true';

        const savedUnit = readStorage(STORAGE_KEYS.unitSystem);
        state.unitSystem = savedUnit === 'imperial' ? 'imperial' : 'metric';

        if (dom.thresholdInput) dom.thresholdInput.value = state.threshold;
        if (dom.alphaInput) dom.alphaInput.value = state.alpha;
        if (dom.timeFormatToggle) dom.timeFormatToggle.checked = state.is24HourFormat;
        if (dom.unitSystemSelect) dom.unitSystemSelect.value = state.unitSystem;
        syncQuickControls();
    }

    function setForecastHours(hours) {
        state.forecastHours = clamp(
            hours,
            CONFIG.limits.forecastHours.min,
            CONFIG.limits.forecastHours.max,
            state.forecastHours
        );
        writeStorage(STORAGE_KEYS.forecastHours, state.forecastHours);
        syncQuickControls();
        renderForecast();
    }

    function bindEventListeners() {
        function bindNumberSetting(el, stateKey, storageKey, parser) {
            if (!el) return;
            const { min, max } = CONFIG.limits[stateKey];
            el.addEventListener('change', () => {
                state[stateKey] = clamp(parser(el.value), min, max, state[stateKey]);
                el.value = state[stateKey];
                writeStorage(storageKey, state[stateKey]);
                syncQuickControls();
                renderForecast();
            });
        }

        function bindToggleSetting(el, stateKey, storageKey, onToggle) {
            if (!el) return;
            el.addEventListener('change', () => {
                state[stateKey] = el.checked;
                writeStorage(storageKey, state[stateKey]);
                syncQuickControls();
                onToggle();
            });
        }

        bindNumberSetting(dom.thresholdInput, 'threshold', STORAGE_KEYS.threshold, (v) => parseInt(v, 10));
        bindNumberSetting(dom.forecastHoursInput, 'forecastHours', STORAGE_KEYS.forecastHours, (v) => parseInt(v, 10));
        bindNumberSetting(dom.alphaInput, 'alpha', STORAGE_KEYS.alpha, parseFloat);

        bindToggleSetting(dom.timeFormatToggle, 'is24HourFormat', STORAGE_KEYS.is24HourFormat, () => renderForecast());
        bindToggleSetting(dom.showEnsembleToggle, 'showEnsembleMembers', STORAGE_KEYS.showEnsembleMembers, () => renderForecast());
        bindToggleSetting(dom.confidenceToggle, 'showConfidenceBounds', STORAGE_KEYS.showConfidenceBounds, () => syncDatasetVisibility('none'));
        bindToggleSetting(dom.showAmountToggle, 'showExpectedAmount', STORAGE_KEYS.showExpectedAmount, () => syncDatasetVisibility('none'));

        // Quick horizon segmented controls
        for (const btn of dom.horizonButtons) {
            btn.addEventListener('click', () => {
                setForecastHours(parseInt(btn.dataset.hours, 10));
            });
        }

        // Quick chart layer toggle chips
        if (dom.chipModels) {
            dom.chipModels.addEventListener('click', () => {
                state.showEnsembleMembers = !state.showEnsembleMembers;
                writeStorage(STORAGE_KEYS.showEnsembleMembers, state.showEnsembleMembers);
                syncQuickControls();
                renderForecast();
            });
        }

        if (dom.chipConfidence) {
            dom.chipConfidence.addEventListener('click', () => {
                state.showConfidenceBounds = !state.showConfidenceBounds;
                writeStorage(STORAGE_KEYS.showConfidenceBounds, state.showConfidenceBounds);
                syncDatasetVisibility('none');
            });
        }

        if (dom.chipAmount) {
            dom.chipAmount.addEventListener('click', () => {
                state.showExpectedAmount = !state.showExpectedAmount;
                writeStorage(STORAGE_KEYS.showExpectedAmount, state.showExpectedAmount);
                syncDatasetVisibility('none');
            });
        }

        if (dom.unitSystemSelect) {
            dom.unitSystemSelect.addEventListener('change', () => {
                state.unitSystem = dom.unitSystemSelect.value === 'imperial' ? 'imperial' : 'metric';
                writeStorage(STORAGE_KEYS.unitSystem, state.unitSystem);
                renderForecast();
            });
        }

        // Location search + debounced autocomplete + keyboard navigation
        if (dom.locationInput) {
            dom.locationInput.addEventListener('input', () => {
                const query = dom.locationInput.value.trim();
                clearTimeout(state.searchDebounceId);
                if (query.length < 2) {
                    closeSuggestions();
                    return;
                }
                state.searchDebounceId = setTimeout(() => fetchLocationSuggestions(query), CONFIG.searchDebounceMs);
            });

            dom.locationInput.addEventListener('keydown', (event) => {
                if (!state.suggestions.length) return;
                if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    const next = (state.activeSuggestionIndex + 1) % state.suggestions.length;
                    highlightSuggestion(next);
                } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    const prev = (state.activeSuggestionIndex - 1 + state.suggestions.length) % state.suggestions.length;
                    highlightSuggestion(prev);
                } else if (event.key === 'Enter' && state.activeSuggestionIndex >= 0) {
                    event.preventDefault();
                    selectSuggestion(state.suggestions[state.activeSuggestionIndex]);
                } else if (event.key === 'Escape') {
                    closeSuggestions();
                }
            });

            dom.locationInput.addEventListener('blur', () => {
                setTimeout(closeSuggestions, 150);
            });
        }

        if (dom.locationForm) {
            dom.locationForm.addEventListener('submit', (event) => {
                event.preventDefault();
                if (state.activeSuggestionIndex >= 0 && state.suggestions[state.activeSuggestionIndex]) {
                    selectSuggestion(state.suggestions[state.activeSuggestionIndex]);
                    return;
                }
                const query = dom.locationInput?.value.trim();
                if (query) searchLocation(query);
            });
        }

        if (dom.gpsButton) dom.gpsButton.addEventListener('click', handleGpsClick);
        if (dom.refreshButton) dom.refreshButton.addEventListener('click', refreshWeatherData);
        if (dom.notificationBtn) dom.notificationBtn.addEventListener('click', requestNotificationPermission);
    }

    // --- Boot ---
    loadSavedSettings();
    initializeChart();
    bindEventListeners();
    syncNotificationStatus();
    loadSavedLocation();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initApp);
    } else {
        initApp();
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        CONFIG,
        MODEL_CONFIGS,
        clamp,
        getQuantile,
        estimateProbabilityFromPercentiles,
        parseUtcHourTimestamp,
        parseOpenMeteoForecast,
        parseWeatherNext3Forecast,
        parseNWSForecast,
        buildForecastSeries,
    };
}
