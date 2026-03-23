/**
 * Rain Warning - Logic Controller
 */

window.onload = () => {
    // --- PWA Service Worker Registration ---
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./sw.js')
                .then(reg => console.log('Service Worker registered.'))
                .catch(err => console.log('Service Worker registration failed: ', err));
        });
    }

    // --- PWA Install Prompt ---
    let deferredPrompt;
    const installButton = document.getElementById('install-button');
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        if (installButton) installButton.style.display = 'block';
    });
    if (installButton) {
        installButton.addEventListener('click', async () => {
            if (deferredPrompt) {
                deferredPrompt.prompt();
                await deferredPrompt.userChoice;
                deferredPrompt = null;
                installButton.style.display = 'none';
            }
        });
    }

    // --- Configuration ---
    const REFRESH_INTERVAL = 1200000; // 20 minutes
    const WEATHER_MODELS = 'gfs_seamless,ecmwf_ifs,icon_seamless';

    // --- DOM Elements ---
    const weatherInfoDiv = document.getElementById('weather-info');
    const warningMessageDiv = document.getElementById('warning-message');
    const lastUpdatedSpan = document.getElementById('last-updated');
    const notificationStatusSpan = document.getElementById('notification-status');
    const locationForm = document.getElementById('location-form');
    const locationInput = document.getElementById('location-input');
    const locationDisplay = document.getElementById('location-display');
    const gpsButton = document.getElementById('gps-button');
    const chartCanvas = document.getElementById('rainChart');
    const thresholdInput = document.getElementById('threshold-input');
    const forecastHoursInput = document.getElementById('forecast-hours-input');
    const timeFormatToggle = document.getElementById('time-format-toggle');
    const confidenceToggle = document.getElementById('confidence-toggle');
    const showEnsembleToggle = document.getElementById('show-ensemble-toggle');
    const showAmountToggle = document.getElementById('show-amount-toggle');
    const alphaInput = document.getElementById('alpha-input');
    const unitSystemSelect = document.getElementById('unit-system-select');
    const dataSourceP = document.getElementById('data-source');

    // --- App State ---
    let currentLatitude, currentLongitude;
    let weatherInterval;
    let rainChart;
    let rainProbabilityThreshold = 25;
    let forecastHours = 12;
    let is24HourFormat = false;
    let showConfidenceBounds = false;
    let showEnsembleMembers = false;
    let showExpectedAmount = false;
    let unitSystem = 'metric';
    let alpha = 0.25;
    let lastEnsembleData = null;
    let processedModelData = { gfs: [], ecmwf: [], icon: [], nws: [] };

    // --- Chart Functions ---
    function initializeChart() {
        if (!chartCanvas) return;
        const ctx = chartCanvas.getContext('2d');
        
        // Chart.js Default styling tweaks for Dark Mode Overlay
        Chart.defaults.color = '#94a3b8';
        Chart.defaults.borderColor = 'rgba(255, 255, 255, 0.05)';

        rainChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: [],
                datasets: [
                    { label: 'Ensemble Avg', data: [], yAxisID: 'y', backgroundColor: 'rgba(56, 189, 248, 0.4)', borderColor: 'rgba(56, 189, 248, 1)', borderWidth: 1, order: 2 },
                    { label: 'GFS', data: [], yAxisID: 'y', type: 'line', borderColor: 'rgba(16, 185, 129, 0.5)', borderWidth: 1.5, fill: false, pointRadius: 0, order: 1 },
                    { label: 'ECMWF', data: [], yAxisID: 'y', type: 'line', borderColor: 'rgba(249, 115, 22, 0.5)', borderWidth: 1.5, fill: false, pointRadius: 0, order: 1 },
                    { label: 'ICON', data: [], yAxisID: 'y', type: 'line', borderColor: 'rgba(139, 92, 246, 0.5)', borderWidth: 1.5, fill: false, pointRadius: 0, order: 1 },
                    { label: 'NWS', data: [], yAxisID: 'y', type: 'line', borderColor: 'rgba(244, 63, 94, 0.5)', borderWidth: 1.5, fill: false, pointRadius: 0, order: 1 },
                    {
                        label: 'Confidence Bound',
                        data: [], // Upper bound
                        yAxisID: 'y',
                        fill: '+1',
                        backgroundColor: 'rgba(255, 255, 255, 0.04)',
                        borderColor: 'transparent',
                        pointRadius: 0,
                        type: 'line',
                        order: 0
                    },
                    {
                        label: 'Lower Bound',
                        data: [], // Lower bound
                        yAxisID: 'y',
                        fill: false,
                        borderColor: 'transparent',
                        pointRadius: 0,
                        type: 'line'
                    },
                    {
                        label: 'Forecast Amount',
                        data: [],
                        yAxisID: 'y1',
                        backgroundColor: 'rgba(250, 204, 21, 0.4)',
                        borderColor: 'rgba(250, 204, 21, 1)',
                        borderWidth: 1,
                        order: 3
                    }
                ]
            },
            options: {
                maintainAspectRatio: false,
                scales: {
                    y: { type: 'linear', position: 'left', beginAtZero: true, max: 100, grid: { color: 'rgba(255, 255, 255, 0.03)' }, title: { display: true, text: 'Rain Probability (%)', color: '#f8fafc' } },
                    y1: { type: 'linear', position: 'right', beginAtZero: true, title: { display: true, text: 'Forecast Amount (mm)', color: '#f8fafc' }, grid: { drawOnChartArea: false } },
                    x: { grid: { display: false } }
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'bottom',
                        labels: { boxWidth: 10, padding: 15, font: { size: 10 } },
                        onClick: (e, legendItem, legend) => {
                            const chart = legend.chart;
                            if (legendItem.text === 'Confidence Bound') {
                                showConfidenceBounds = !showConfidenceBounds;
                                if (confidenceToggle) confidenceToggle.checked = showConfidenceBounds;
                                
                                const hideBounds = !showConfidenceBounds;
                                chart.data.datasets[5].hidden = hideBounds;
                                chart.data.datasets[6].hidden = hideBounds;
                            } else {
                                Chart.defaults.plugins.legend.onClick.call(chart, e, legendItem, legend);
                            }
                            chart.update();
                        }
                    },
                    annotation: {
                        annotations: {
                            thresholdLine: { type: 'line', yMin: rainProbabilityThreshold, yMax: rainProbabilityThreshold, borderColor: 'rgba(244, 63, 94, 0.8)', borderWidth: 2, borderDash: [4, 4], scaleID: 'y' }
                        }
                    }
                }
            }
        });
    }

    function updateChart(labels, ensembleData, modelData, confidenceData, forecastAmountData, activeModels) {
        if (!rainChart) initializeChart();
        if (!rainChart) return;
        
        rainChart.options.plugins.legend.labels.filter = (item) => {
            const label = item.text;
            if (['Ensemble Avg', 'Confidence Bound', 'Forecast Amount'].includes(label)) return true;
            if (label === 'Lower Bound') return false;
            return activeModels.includes(label.toUpperCase()) && showEnsembleMembers;
        };

        rainChart.data.datasets.forEach(dataset => {
            const label = dataset.label;
            if (['Ensemble Avg', 'Confidence Bound', 'Lower Bound', 'Forecast Amount'].includes(label)) return;
            
            const isInactive = !activeModels.includes(label.toUpperCase());
            dataset.hidden = isInactive || !showEnsembleMembers;
        });

        rainChart.data.labels = labels;
        rainChart.data.datasets[0].data = ensembleData;
        rainChart.data.datasets[1].data = modelData.gfs;
        rainChart.data.datasets[2].data = modelData.ecmwf;
        rainChart.data.datasets[3].data = modelData.icon;
        rainChart.data.datasets[4].data = modelData.nws;
        rainChart.data.datasets[5].data = confidenceData.upper;
        rainChart.data.datasets[6].data = confidenceData.lower;
        rainChart.data.datasets[7].data = forecastAmountData;
        
        rainChart.data.datasets[5].hidden = !showConfidenceBounds;
        rainChart.data.datasets[6].hidden = !showConfidenceBounds;
        rainChart.data.datasets[7].hidden = !showExpectedAmount;

        if (rainChart.options.plugins.annotation) {
            rainChart.options.plugins.annotation.annotations.thresholdLine.yMin = rainProbabilityThreshold;
            rainChart.options.plugins.annotation.annotations.thresholdLine.yMax = rainProbabilityThreshold;
        }
        
        const y2Label = unitSystem === 'imperial' ? 'Forecast Amount (in)' : 'Forecast Amount (mm)';
        rainChart.options.scales.y1.title.text = y2Label;

        rainChart.update();
    }

    // --- Notification Functions ---
    function requestNotificationPermission() {
        if (!("Notification" in window)) {
            if (notificationStatusSpan) notificationStatusSpan.textContent = 'Not Supported';
            return;
        }
        Notification.requestPermission().then(permission => {
            if (notificationStatusSpan) notificationStatusSpan.textContent = permission === "granted" ? 'Enabled' : 'Disabled';
        });
    }
    
    function sendNotification(title, body) {
        if (Notification.permission === "granted") {
            navigator.serviceWorker.ready.then(reg => {
                reg.showNotification(title, { body: body, icon: 'icon.svg' });
            });
        }
    }

    // --- Location Functions ---
    async function getCoordinatesForLocation(locationName) {
        setLoadingState('Finding location...');
        const geocodeUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(locationName)}&count=1&language=en&format=json`;
        try {
            const response = await fetch(geocodeUrl);
            const data = await response.json();
            if (data.results && data.results.length > 0) {
                const loc = data.results[0];
                const displayName = `${loc.name}, ${loc.admin1 || loc.country}`;
                saveAndSetLocation(loc.latitude, loc.longitude, displayName);
            } else {
                alert('Location not found.');
                loadSavedLocation();
            }
        } catch (error) {
            alert('Failed to find location.');
            loadSavedLocation();
        }
    }

    async function getLocationNameForCoordinates(lat, lon) {
        setLoadingState('Getting location name...');
        const reverseGeocodeUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&accept-language=en`;
        try {
            const response = await fetch(reverseGeocodeUrl);
            const data = await response.json();
            const address = data.address;
            const displayName = address.city || address.town || address.village || 'Current Location';
            saveAndSetLocation(lat, lon, displayName);
        } catch (error) {
            console.error("Reverse geocoding failed:", error);
            saveAndSetLocation(lat, lon, `Lat: ${lat.toFixed(2)}, Lon: ${lon.toFixed(2)}`);
        }
    }
    
    function handleGpsClick() {
        if (navigator.geolocation) {
            setLoadingState('Getting GPS signal...');
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    getLocationNameForCoordinates(position.coords.latitude, position.coords.longitude);
                },
                (error) => {
                    alert('GPS Error: ' + error.message);
                    loadSavedLocation();
                }
            );
        } else {
            alert("Geolocation is not supported by this browser.");
        }
    }

    function saveAndSetLocation(lat, lon, name) {
        localStorage.setItem('weatherLocation', JSON.stringify({ latitude: lat, longitude: lon, name: name }));
        updateLocation(lat, lon, name);
    }

    function updateLocation(lat, lon, name) {
        currentLatitude = lat;
        currentLongitude = lon;
        if (locationDisplay) locationDisplay.textContent = name;
        
        if (weatherInterval) clearInterval(weatherInterval);
        getEnsembleWeatherData();
        weatherInterval = setInterval(getEnsembleWeatherData, REFRESH_INTERVAL);
    }

    function loadSavedLocation() {
        const savedLocation = localStorage.getItem('weatherLocation');
        if (savedLocation) {
            const { latitude, longitude, name } = JSON.parse(savedLocation);
            updateLocation(latitude, longitude, name);
        } else {
            updateLocation(49.2827, -123.1207, 'Vancouver, BC'); 
        }
    }

    // --- Weather Data Functions ---
    async function getNWSForecast(lat, lon) {
        try {
            const pointsResponse = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
            if (!pointsResponse.ok) return null;
            const pointsData = await pointsResponse.json();
            const hourlyUrl = pointsData.properties.forecastHourly;
            if (!hourlyUrl) return null;

            const hourlyResponse = await fetch(hourlyUrl);
            if (!hourlyResponse.ok) return null;
            const hourlyData = await hourlyResponse.json();
            
            return hourlyData.properties.periods.map(period => ({
                time: new Date(period.startTime),
                probability: period.probabilityOfPrecipitation.value || 0
            }));
        } catch (error) {
            return null;
        }
    }

    async function getEnsembleWeatherData() {
        if (currentLatitude === undefined || currentLongitude === undefined) return;
        setLoadingState('Fetching forecast...');

        const precipUnit = unitSystem === 'imperial' ? 'inch' : 'mm';
        const openMeteoUrl = `https://api.open-meteo.com/v1/forecast?latitude=${currentLatitude}&longitude=${currentLongitude}&hourly=precipitation_probability,precipitation&models=${WEATHER_MODELS}&precipitation_unit=${precipUnit}&forecast_days=2`;
        
        const [openMeteoResult, nwsResult] = await Promise.allSettled([
            fetch(openMeteoUrl).then(res => res.json()),
            getNWSForecast(currentLatitude, currentLongitude)
        ]);

        if (openMeteoResult.status === 'rejected') {
            handleFetchError('Could not retrieve weather data.');
            return;
        }

        lastEnsembleData = {
            openMeteo: openMeteoResult.value,
            nws: nwsResult.status === 'fulfilled' ? nwsResult.value : null
        };

        if (lastEnsembleData.openMeteo.error) {
            handleFetchError(`API Error: ${lastEnsembleData.openMeteo.reason}`);
            return;
        }
        
        processEnsembleData(lastEnsembleData);
    }

    function getQuantile(sortedArray, q) {
        const pos = (sortedArray.length - 1) * q;
        const base = Math.floor(pos);
        const rest = pos - base;
        return sortedArray[base + 1] !== undefined ? sortedArray[base] + rest * (sortedArray[base + 1] - sortedArray[base]) : sortedArray[base];
    }

    function processEnsembleData(data) {
        if (!data || !data.openMeteo || !data.openMeteo.hourly || !data.openMeteo.hourly.time) {
            handleFetchError('Invalid data format.');
            return;
        }
        if (weatherInfoDiv) weatherInfoDiv.style.display = 'none';
        
        const now = new Date();
        let rainChanceFound = false;
        
        const chartLabels = [];
        processedModelData = { gfs: [], ecmwf: [], icon: [], nws: [] };
        const activeModels = [];
        const ensembleAverageData = [];
        const forecastAmountData = [];
        const confidenceData = { upper: [], lower: [] };
        
        const hourly = data.openMeteo.hourly;
        const timeData = hourly.time;
        
        const gfsProbs = hourly.precipitation_probability_gfs_seamless;
        const ecmwfProbs = hourly.precipitation_probability_ecmwf_ifs;
        const iconProbs = hourly.precipitation_probability_icon_seamless;

        const gfsPrecip = hourly.precipitation_gfs_seamless;
        const ecmwfPrecip = hourly.precipitation_ecmwf_ifs;
        const iconPrecip = hourly.precipitation_icon_seamless;

        let startIndex = timeData.findLastIndex(timeStr => new Date(timeStr + 'Z') <= now);
        if (startIndex === -1) startIndex = 0;

        if (gfsProbs && gfsProbs.some(p => p !== null)) activeModels.push('GFS');
        if (ecmwfProbs && ecmwfProbs.some(p => p !== null)) activeModels.push('ECMWF');
        if (iconProbs && iconProbs.some(p => p !== null)) activeModels.push('ICON');
        if (data.nws && data.nws.some(p => p.probability !== null)) activeModels.push('NWS');
        if (dataSourceP) dataSourceP.innerHTML = `Sources: ${activeModels.join(', ') || 'None'}`;

        for (let i = 0; i < forecastHours; i++) {
            const dataIndex = startIndex + i;
            if (dataIndex >= timeData.length) continue;

            const forecastTime = new Date(timeData[dataIndex] + 'Z');
            chartLabels.push(forecastTime.toLocaleTimeString([], { hour: 'numeric', hour12: !is24HourFormat }));
            
            const probabilities = [];
            const precipitations = [];

            const gfsProb = gfsProbs && gfsProbs[dataIndex] != null ? gfsProbs[dataIndex] : NaN;
            processedModelData.gfs[i] = gfsProb;
            if (activeModels.includes('GFS') && !isNaN(gfsProb)) probabilities.push(gfsProb);
            
            const gfsPrecipVal = gfsPrecip && gfsPrecip[dataIndex] != null ? gfsPrecip[dataIndex] : NaN;
            if (activeModels.includes('GFS') && !isNaN(gfsPrecipVal)) precipitations.push(gfsPrecipVal);

            const ecmwfProb = ecmwfProbs && ecmwfProbs[dataIndex] != null ? ecmwfProbs[dataIndex] : NaN;
            processedModelData.ecmwf[i] = ecmwfProb;
            if (activeModels.includes('ECMWF') && !isNaN(ecmwfProb)) probabilities.push(ecmwfProb);

            const ecmwfPrecipVal = ecmwfPrecip && ecmwfPrecip[dataIndex] != null ? ecmwfPrecip[dataIndex] : NaN;
            if (activeModels.includes('ECMWF') && !isNaN(ecmwfPrecipVal)) precipitations.push(ecmwfPrecipVal);

            const iconProb = iconProbs && iconProbs[dataIndex] != null ? iconProbs[dataIndex] : NaN;
            processedModelData.icon[i] = iconProb;
            if (activeModels.includes('ICON') && !isNaN(iconProb)) probabilities.push(iconProb);

            const iconPrecipVal = iconPrecip && iconPrecip[dataIndex] != null ? iconPrecip[dataIndex] : NaN;
            if (activeModels.includes('ICON') && !isNaN(iconPrecipVal)) precipitations.push(iconPrecipVal);

            let nwsProb = NaN;
            if (data.nws) {
                const nwsPoint = data.nws.find(p => p.time.getTime() === forecastTime.getTime());
                if (nwsPoint && nwsPoint.probability !== null) nwsProb = nwsPoint.probability;
            }
            processedModelData.nws[i] = nwsProb;
            if (activeModels.includes('NWS') && !isNaN(nwsProb)) probabilities.push(nwsProb);
            
            const probAverage = probabilities.length > 0 ? probabilities.reduce((a, b) => a + b, 0) / probabilities.length : 0;
            ensembleAverageData.push(probAverage);

            const precipAverage = precipitations.length > 0 ? precipitations.reduce((a, b) => a + b, 0) / precipitations.length : 0;
            forecastAmountData.push(precipAverage);

            if (probabilities.length > 1) {
                probabilities.sort((a, b) => a - b);
                confidenceData.lower.push(getQuantile(probabilities, alpha));
                confidenceData.upper.push(getQuantile(probabilities, 1 - alpha));
            } else {
                const val = probabilities[0] || 0;
                confidenceData.lower.push(val);
                confidenceData.upper.push(val);
            }

            if (!rainChanceFound && probAverage >= rainProbabilityThreshold) {
                displayWarning(Math.round(probAverage), forecastTime);
                rainChanceFound = true;
            }
        }
        
        if (!rainChanceFound) displaySafeMessage();
        updateChart(chartLabels, ensembleAverageData, processedModelData, confidenceData, forecastAmountData, activeModels);
        if (lastUpdatedSpan) lastUpdatedSpan.textContent = now.toLocaleTimeString([], { hour12: !is24HourFormat });
    }

    // --- UI Helper Functions ---
    function setLoadingState(message) {
        if (!weatherInfoDiv) return;
        weatherInfoDiv.style.display = 'block';
        weatherInfoDiv.innerHTML = `<div class="loader"></div><p style="color:var(--text-muted); font-size:0.875rem;">${message}</p>`;
        if (warningMessageDiv) warningMessageDiv.style.display = 'none';
    }

    function handleFetchError(message) {
        if (weatherInfoDiv) weatherInfoDiv.style.display = 'none';
        if (warningMessageDiv) {
            warningMessageDiv.textContent = message;
            warningMessageDiv.className = 'warning';
            warningMessageDiv.style.display = 'block';
        }
    }

    function displayWarning(probability, time) {
        if (warningMessageDiv) {
            warningMessageDiv.innerHTML = `<strong>Warning!</strong> ${probability}% chance of rain around <strong>${time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: !is24HourFormat })}</strong>`;
            warningMessageDiv.className = 'warning';
            warningMessageDiv.style.display = 'block';
        }
        document.body.classList.add('state-warning');
        sendNotification('Rain Warning', `Warning! ${probability}% chance of rain close to ${time.toLocaleTimeString([], { hour: 'numeric' })}.`);
    }

    function displaySafeMessage() {
         if (warningMessageDiv) {
            warningMessageDiv.innerHTML = `No significant rain risks forecasts (≥${rainProbabilityThreshold}%) in the next ${forecastHours}h.`;
            warningMessageDiv.className = 'safe';
            warningMessageDiv.style.display = 'block';
        }
        document.body.classList.remove('state-warning');
    }

    // --- Settings Functions ---
    function loadSavedSettings() {
        if (thresholdInput) {
            const savedThreshold = localStorage.getItem('rainWarningThreshold');
            if (savedThreshold) rainProbabilityThreshold = parseInt(savedThreshold, 10);
            thresholdInput.value = rainProbabilityThreshold;
        }

        if (forecastHoursInput) {
            const savedHours = localStorage.getItem('forecastHours');
            if (savedHours) forecastHours = parseInt(savedHours, 10);
            forecastHoursInput.value = forecastHours;
        }

        if (timeFormatToggle) {
            is24HourFormat = localStorage.getItem('is24HourFormat') === 'true';
            timeFormatToggle.checked = is24HourFormat;
        }

        if (confidenceToggle) {
            showConfidenceBounds = localStorage.getItem('showConfidenceBounds') === 'true';
            confidenceToggle.checked = showConfidenceBounds;
        }

        if (showEnsembleToggle) {
            showEnsembleMembers = localStorage.getItem('showEnsembleMembers') === 'true';
            showEnsembleToggle.checked = showEnsembleMembers;
        }

        if (showAmountToggle) {
            showExpectedAmount = localStorage.getItem('showExpectedAmount') === 'true';
            showAmountToggle.checked = showExpectedAmount;
        }

        if (alphaInput) {
            const savedAlpha = localStorage.getItem('quantileAlpha');
            if (savedAlpha) alpha = parseFloat(savedAlpha);
            alphaInput.value = alpha;
        }
        
        if (unitSystemSelect) {
            const savedUnitSystem = localStorage.getItem('unitSystem') || 'metric';
            unitSystemSelect.value = savedUnitSystem;
            unitSystem = savedUnitSystem;
        }
    }

    // --- Event Handlers ---
    if (thresholdInput) {
        thresholdInput.addEventListener('change', () => {
            rainProbabilityThreshold = parseInt(thresholdInput.value, 10);
            localStorage.setItem('rainWarningThreshold', rainProbabilityThreshold);
            if (lastEnsembleData) processEnsembleData(lastEnsembleData);
        });
    }

    if (forecastHoursInput) {
        forecastHoursInput.addEventListener('change', () => {
            forecastHours = parseInt(forecastHoursInput.value, 10);
            localStorage.setItem('forecastHours', forecastHours);
            if (lastEnsembleData) processEnsembleData(lastEnsembleData);
        });
    }

    if (timeFormatToggle) {
        timeFormatToggle.addEventListener('change', () => {
            is24HourFormat = timeFormatToggle.checked;
            localStorage.setItem('is24HourFormat', is24HourFormat);
            if (lastEnsembleData) processEnsembleData(lastEnsembleData);
        });
    }

    if (confidenceToggle) {
        confidenceToggle.addEventListener('change', () => {
            showConfidenceBounds = confidenceToggle.checked;
            localStorage.setItem('showConfidenceBounds', showConfidenceBounds);
            if (rainChart) {
                rainChart.data.datasets[5].hidden = !showConfidenceBounds;
                rainChart.data.datasets[6].hidden = !showConfidenceBounds;
                rainChart.update('none');
            }
        });
    }

    if (showEnsembleToggle) {
        showEnsembleToggle.addEventListener('change', () => {
            showEnsembleMembers = showEnsembleToggle.checked;
            localStorage.setItem('showEnsembleMembers', showEnsembleMembers);
            if (lastEnsembleData) processEnsembleData(lastEnsembleData);
        });
    }

    if (showAmountToggle) {
        showAmountToggle.addEventListener('change', () => {
            showExpectedAmount = showAmountToggle.checked;
            localStorage.setItem('showExpectedAmount', showExpectedAmount);
            if (rainChart) {
                rainChart.data.datasets[7].hidden = !showExpectedAmount;
                rainChart.update('none');
            }
        });
    }

    if (alphaInput) {
        alphaInput.addEventListener('change', () => {
            alpha = parseFloat(alphaInput.value);
            localStorage.setItem('quantileAlpha', alpha);
            if (lastEnsembleData) processEnsembleData(lastEnsembleData);
        });
    }

    if (unitSystemSelect) {
        unitSystemSelect.addEventListener('change', () => {
            unitSystem = unitSystemSelect.value;
            localStorage.setItem('unitSystem', unitSystem);
            if (currentLatitude !== undefined && currentLongitude !== undefined) getEnsembleWeatherData();
        });
    }

    if (locationForm) {
        locationForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const locationName = locationInput ? locationInput.value.trim() : '';
            if (locationName) getCoordinatesForLocation(locationName);
        });
    }

    if (gpsButton) gpsButton.addEventListener('click', handleGpsClick);

    // --- Initial Operations ---
    initializeChart();
    loadSavedSettings();
    requestNotificationPermission();
    loadSavedLocation();
};
