<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Rain Warning</title>
    <!-- PWA Manifest Link -->
    <link rel="manifest" href="manifest.json">
    <!-- Theme Color for PWA -->
    <meta name="theme-color" content="#ffffff">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&display=swap" rel="stylesheet">
    <script src="https://cdn.tailwindcss.com"></script>
    <!-- Chart.js and the Annotation Plugin -->
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-annotation@3.0.1/dist/chartjs-plugin-annotation.min.js"></script>
    <style>
        /* Custom Styles */
        body {
            font-family: 'Inter', sans-serif;
        }
        .weather-card {
            box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
        }
        .warning {
            background-color: #fef2f2; /* Red-50 */
            border-left: 4px solid #ef4444; /* Red-500 */
            color: #b91c1c; /* Red-700 */
        }
        .safe {
            background-color: #f0fdf4; /* Green-50 */
            border-left: 4px solid #22c55e; /* Green-500 */
            color: #15803d; /* Green-700 */
        }
        .loader {
            border: 4px solid #f3f4f6;
            border-top: 4px solid #3b82f6;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
            margin: 20px auto;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        #install-button {
            display: none; /* Hidden by default */
        }
    </style>
</head>
<body class="bg-gray-100 flex items-center justify-center min-h-screen p-4">

    <div class="weather-card bg-white rounded-xl p-6 md:p-8 max-w-lg w-full">
        <div class="text-center">
            <h1 class="text-2xl font-bold text-gray-800">Rain Warning</h1>
            <p id="location-display" class="text-gray-500 mb-4 h-6">Loading location...</p>
        </div>

        <!-- Location Controls -->
        <div class="flex flex-col sm:flex-row gap-2 mb-2">
            <form id="location-form" class="flex-grow flex gap-2">
                <input type="text" id="location-input" placeholder="Enter a city..." class="flex-grow p-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                <button type="submit" class="bg-blue-500 hover:bg-blue-600 text-white font-bold py-2 px-4 rounded-lg transition-colors">Search</button>
            </form>
            <button id="gps-button" class="bg-gray-600 hover:bg-gray-700 text-white font-bold p-2 rounded-lg transition-colors flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>
                <span class="ml-2 sm:hidden lg:inline">Use My Location</span>
            </button>
        </div>
        
        <!-- Settings Controls -->
        <div class="flex flex-col sm:flex-row items-center justify-center gap-4 mb-4">
            <div class="flex items-center gap-2">
                <label for="threshold-input" class="text-sm font-medium text-gray-700">Warning Threshold (%):</label>
                <input type="number" id="threshold-input" min="0" max="100" class="w-20 p-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
            </div>
            <div class="flex items-center gap-2">
                <label for="time-format-toggle" class="text-sm font-medium text-gray-700">24-Hour Format</label>
                <input type="checkbox" id="time-format-toggle" class="h-4 w-4 rounded text-blue-600 focus:ring-blue-500">
            </div>
        </div>

        <div id="weather-info" class="text-center">
            <div class="loader"></div>
            <p class="text-gray-600">Fetching ensemble forecast...</p>
        </div>

        <div id="warning-message" class="mt-4 p-4 rounded-lg text-center font-medium" style="display: none;"></div>
        
        <!-- Rain Probability Graph -->
        <div class="mt-6">
            <canvas id="rainChart"></canvas>
        </div>

        <div class="text-center mt-6 space-y-2">
             <button id="install-button" class="w-full bg-indigo-500 hover:bg-indigo-600 text-white font-bold py-2 px-4 rounded-lg transition-colors">
                Install App
            </button>
            <p class="text-xs text-gray-500">Notification Status: <span id="notification-status" class="font-semibold">Pending</span></p>
            <p class="text-xs text-gray-400">Forecast updated: <span id="last-updated">Never</span></p>
            <p id="data-source" class="text-xs text-gray-400 mt-1">Weather data by <a href="https://open-meteo.com/" target="_blank" class="underline text-blue-600 hover:text-blue-800">Open-Meteo</a></p>
        </div>
    </div>

    <script>
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
            installButton.style.display = 'block';
        });
        installButton.addEventListener('click', async () => {
            if (deferredPrompt) {
                deferredPrompt.prompt();
                await deferredPrompt.userChoice;
                deferredPrompt = null;
                installButton.style.display = 'none';
            }
        });

        // --- Configuration ---
        const FORECAST_HOURS = 12;
        const REFRESH_INTERVAL = 1200000; // 20 minutes
        const WEATHER_MODELS = 'gfs_global,ecmwf_ifs,icon_global';

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
        const timeFormatToggle = document.getElementById('time-format-toggle');
        const dataSourceP = document.getElementById('data-source');

        // --- App State ---
        let currentLatitude, currentLongitude;
        let weatherInterval;
        let rainChart;
        let rainProbabilityThreshold = 25;
        let is24HourFormat = false;
        let lastEnsembleData = null;

        // --- Chart Functions ---
        function initializeChart() {
            const ctx = chartCanvas.getContext('2d');
            rainChart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: [],
                    datasets: [
                        {
                            label: 'Ensemble Avg',
                            data: [],
                            backgroundColor: 'rgba(59, 130, 246, 0.6)',
                            borderColor: 'rgba(59, 130, 246, 1)',
                            borderWidth: 1,
                            order: 2
                        },
                        {
                            label: 'GFS',
                            data: [],
                            type: 'line',
                            borderColor: 'rgba(16, 185, 129, 0.5)', // Green
                            borderWidth: 2,
                            fill: false,
                            pointRadius: 0,
                            order: 1
                        },
                        {
                            label: 'ECMWF',
                            data: [],
                            type: 'line',
                            borderColor: 'rgba(249, 115, 22, 0.5)', // Orange
                            borderWidth: 2,
                            fill: false,
                            pointRadius: 0,
                            order: 1
                        },
                        {
                            label: 'ICON',
                            data: [],
                            type: 'line',
                            borderColor: 'rgba(139, 92, 246, 0.5)', // Violet
                            borderWidth: 2,
                            fill: false,
                            pointRadius: 0,
                            order: 1
                        }
                    ]
                },
                options: {
                    scales: {
                        y: {
                            beginAtZero: true,
                            max: 100,
                            title: {
                                display: true,
                                text: 'Rain Probability (%)'
                            }
                        },
                        x: {
                           title: {
                                display: true,
                                text: 'Time'
                            }
                        }
                    },
                    plugins: {
                        legend: {
                            display: true,
                            position: 'bottom',
                             labels: {
                                boxWidth: 12,
                                font: {
                                    size: 10
                                }
                            }
                        },
                        annotation: {
                            annotations: {
                                thresholdLine: {
                                    type: 'line',
                                    yMin: rainProbabilityThreshold,
                                    yMax: rainProbabilityThreshold,
                                    borderColor: 'rgba(239, 68, 68, 0.8)',
                                    borderWidth: 2,
                                    borderDash: [5, 5]
                                }
                            }
                        }
                    }
                }
            });
        }

        function updateChart(labels, ensembleData, modelData) {
            if (!rainChart) initializeChart();
            rainChart.data.labels = labels;
            rainChart.data.datasets[0].data = ensembleData;
            rainChart.data.datasets[1].data = modelData.gfs;
            rainChart.data.datasets[2].data = modelData.ecmwf;
            rainChart.data.datasets[3].data = modelData.icon;
            
            rainChart.options.plugins.annotation.annotations.thresholdLine.yMin = rainProbabilityThreshold;
            rainChart.options.plugins.annotation.annotations.thresholdLine.yMax = rainProbabilityThreshold;
            rainChart.update();
        }

        // --- Notification Functions ---
        function requestNotificationPermission() {
            if (!("Notification" in window)) {
                notificationStatusSpan.textContent = "Not Supported";
                return;
            }
            Notification.requestPermission().then(permission => {
                notificationStatusSpan.textContent = permission === "granted" ? "Enabled" : "Disabled";
            });
        }
        
        function sendNotification(title, body) {
            if (Notification.permission === "granted") {
                navigator.serviceWorker.ready.then(reg => {
                    reg.showNotification(title, { body: body, icon: 'icon-192.png' });
                });
            }
        }

        // --- Location Functions ---
        async function getCoordinatesForLocation(locationName) {
            setLoadingState("Finding location...");
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
            setLoadingState("Getting location name...");
            const reverseGeocodeUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`;
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
                setLoadingState("Getting GPS signal...");
                navigator.geolocation.getCurrentPosition(
                    (position) => {
                        getLocationNameForCoordinates(position.coords.latitude, position.coords.longitude);
                    },
                    (error) => {
                        alert(`GPS Error: ${error.message}`);
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
            locationDisplay.textContent = name;
            
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
                updateLocation(-1.9441, 30.0619, 'Kigali, Rwanda');
            }
        }

        // --- Weather Data Functions ---
        async function getEnsembleWeatherData() {
            if (!currentLatitude || !currentLongitude) return;
            setLoadingState("Fetching ensemble forecast...");
            const apiUrl = `https://api.open-meteo.com/v1/forecast?latitude=${currentLatitude}&longitude=${currentLongitude}&hourly=precipitation_probability&models=${WEATHER_MODELS}&forecast_days=2`;
            try {
                const response = await fetch(apiUrl);
                const data = await response.json();

                if (data.error) {
                    handleFetchError(`API Error: ${data.reason}`);
                    return;
                }

                lastEnsembleData = data;
                processEnsembleData(lastEnsembleData);
            } catch (error) {
                handleFetchError();
            }
        }

        function processEnsembleData(data) {
            // **BUG FIX**: This is the final, corrected logic.
            if (!data || !data.hourly || !data.hourly.time) {
                handleFetchError("Invalid data format from API.");
                return;
            }
            weatherInfoDiv.style.display = 'none';
            dataSourceP.innerHTML = `Ensemble forecast by <a href="https://open-meteo.com/" target="_blank" class="underline text-blue-600 hover:text-blue-800">Open-Meteo</a> (GFS, ECMWF, ICON)`;

            const now = new Date();
            let rainChanceFound = false;
            
            const chartLabels = [];
            const ensembleAverageData = [];
            const modelData = { gfs: [], ecmwf: [], icon: [] };
            
            const hourly = data.hourly;
            const timeData = hourly.time;
            
            const gfsProbs = hourly.precipitation_probability_gfs_global;
            const ecmwfProbs = hourly.precipitation_probability_ecmwf_ifs;
            const iconProbs = hourly.precipitation_probability_icon_global;

            let currentHourIndex = timeData.findIndex(timeStr => new Date(timeStr) >= now);
            if (currentHourIndex === -1) { 
                updateChart([], [], { gfs: [], ecmwf: [], icon: [] });
                displaySafeMessage();
                return;
            }

            for (let i = 0; i < FORECAST_HOURS; i++) {
                const index = currentHourIndex + i;
                if (index < timeData.length) {
                    const forecastTime = new Date(timeData[index]);
                    chartLabels.push(forecastTime.toLocaleTimeString([], { hour: 'numeric', hour12: !is24HourFormat }));
                    
                    const probabilities = [];
                    if (gfsProbs && gfsProbs[index] != null) probabilities.push(gfsProbs[index]);
                    if (ecmwfProbs && ecmwfProbs[index] != null) probabilities.push(ecmwfProbs[index]);
                    if (iconProbs && iconProbs[index] != null) probabilities.push(iconProbs[index]);

                    modelData.gfs.push(gfsProbs ? gfsProbs[index] : NaN);
                    modelData.ecmwf.push(ecmwfProbs ? ecmwfProbs[index] : NaN);
                    modelData.icon.push(iconProbs ? iconProbs[index] : NaN);

                    const sum = probabilities.reduce((a, b) => a + b, 0);
                    const average = probabilities.length > 0 ? sum / probabilities.length : 0;
                    ensembleAverageData.push(average);

                    if (!rainChanceFound && average >= rainProbabilityThreshold) {
                        displayWarning(Math.round(average), forecastTime);
                        rainChanceFound = true;
                    }
                }
            }

            if (!rainChanceFound) {
                displaySafeMessage();
            }
            updateChart(chartLabels, ensembleAverageData, modelData);
            lastUpdatedSpan.textContent = now.toLocaleTimeString([], { hour12: !is24HourFormat });
        }

        // --- UI Helper Functions ---
        function setLoadingState(message) {
            weatherInfoDiv.style.display = 'block';
            weatherInfoDiv.innerHTML = `<div class="loader"></div><p class="text-gray-600">${message}</p>`;
            warningMessageDiv.style.display = 'none';
        }

        function handleFetchError(message = 'Could not retrieve weather data.') {
            weatherInfoDiv.style.display = 'none';
            warningMessageDiv.textContent = message;
            warningMessageDiv.className = 'mt-4 p-4 rounded-lg text-center font-medium warning';
            warningMessageDiv.style.display = 'block';
        }

        function displayWarning(probability, time) {
            const message = `Warning! There is a ${probability}% chance of rain around ${time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: !is24HourFormat })}.`;
            warningMessageDiv.innerHTML = `<strong>${message}</strong>`;
            warningMessageDiv.className = 'mt-4 p-4 rounded-lg text-center font-medium warning';
            warningMessageDiv.style.display = 'block';
            sendNotification("Rain Alert!", `A ${probability}% chance of rain is expected soon.`);
        }

        function displaySafeMessage() {
            warningMessageDiv.textContent = `No significant chance of rain (≥ ${rainProbabilityThreshold}%) in the next ${FORECAST_HOURS} hours.`;
            warningMessageDiv.className = 'mt-4 p-4 rounded-lg text-center font-medium safe';
            warningMessageDiv.style.display = 'block';
        }

        // --- Settings Functions ---
        function loadSavedSettings() {
            const savedThreshold = localStorage.getItem('rainWarningThreshold');
            if (savedThreshold) {
                rainProbabilityThreshold = parseInt(savedThreshold, 10);
            }
            thresholdInput.value = rainProbabilityThreshold;

            const savedTimeFormat = localStorage.getItem('is24HourFormat');
            if (savedTimeFormat) {
                is24HourFormat = savedTimeFormat === 'true';
            }
            timeFormatToggle.checked = is24HourFormat;
        }

        function handleThresholdChange() {
            const newThreshold = parseInt(thresholdInput.value, 10);
            if (!isNaN(newThreshold) && newThreshold >= 0 && newThreshold <= 100) {
                rainProbabilityThreshold = newThreshold;
                localStorage.setItem('rainWarningThreshold', newThreshold);
                processEnsembleData(lastEnsembleData);
            }
        }

        function handleTimeFormatChange() {
            is24HourFormat = timeFormatToggle.checked;
            localStorage.setItem('is24HourFormat', is24HourFormat);
            processEnsembleData(lastEnsembleData);
        }

        // --- Initial Load and Event Listeners ---
        locationForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const locationName = locationInput.value.trim();
            if (locationName) getCoordinatesForLocation(locationName);
        });
        
        gpsButton.addEventListener('click', handleGpsClick);
        thresholdInput.addEventListener('change', handleThresholdChange);
        timeFormatToggle.addEventListener('change', handleTimeFormatChange);
        
        initializeChart();
        requestNotificationPermission();
        loadSavedSettings();
        loadSavedLocation();
    </script>
</body>
</html>
