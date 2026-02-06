/**
 * Weather Ingestion Dashboard JavaScript
 * Handles real-time updates via WebSocket, charts, and dashboard interactivity
 */

// Manual test function - type in console: testSpeedArbToggle(true)
window.testSpeedArbToggle = async (enabled) => {
    console.log('[MANUAL TEST] Toggling speed arb to:', enabled);
    try {
        const res = await fetch('/api/speed-arb/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled }),
        });
        console.log('[MANUAL TEST] Response status:', res.status);
        const data = await res.json();
        console.log('[MANUAL TEST] Response:', data);
    } catch (err) {
        console.error('[MANUAL TEST] Error:', err);
    }
};

// Dashboard state
const dashboardState = {
    ws: null,
    reconnectAttempts: 0,
    maxReconnectAttempts: 5,
    reconnectDelay: 3000,
    isConnected: false,
    charts: {},
    latencyHistory: {
        detection: [],
        download: [],
        parse: [],
        endToEnd: [],
    },
    maxHistoryPoints: 50,
};

// API base URL
const API_BASE = '/api/dashboard';
// Handle both http and https protocols for WebSocket
const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = `${WS_PROTOCOL}//${window.location.host}/ws/dashboard`;

/**
 * Initialize dashboard
 */
function initDashboard() {
    console.log('[Dashboard] Initializing...');

    // Connect WebSocket
    connectWebSocket();

    // Initial data fetch
    fetchAllDashboardData();

    // Setup auto-refresh for non-WS data
    setInterval(fetchNonWsData, 5000);

    // Setup event listeners
    setupEventListeners();

    // Initialize charts
    initCharts();
}

/**
 * Connect WebSocket for real-time updates
 */
function connectWebSocket() {
    if (dashboardState.ws?.readyState === WebSocket.OPEN) {
        return;
    }

    try {
        dashboardState.ws = new WebSocket(WS_URL);

        dashboardState.ws.onopen = () => {
            console.log('[Dashboard] WebSocket connected');
            dashboardState.isConnected = true;
            dashboardState.reconnectAttempts = 0;
            updateConnectionStatus(true);
        };

        dashboardState.ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                handleWebSocketMessage(message);
            } catch (err) {
                console.error('[Dashboard] Error parsing WebSocket message:', err);
            }
        };

        dashboardState.ws.onclose = () => {
            console.log('[Dashboard] WebSocket disconnected');
            dashboardState.isConnected = false;
            updateConnectionStatus(false);
            attemptReconnect();
        };

        dashboardState.ws.onerror = (error) => {
            console.error('[Dashboard] WebSocket error:', error);
            dashboardState.isConnected = false;
            updateConnectionStatus(false);
        };
    } catch (err) {
        console.error('[Dashboard] Error creating WebSocket:', err);
        attemptReconnect();
    }
}

/**
 * Attempt to reconnect WebSocket
 */
function attemptReconnect() {
    if (dashboardState.reconnectAttempts >= dashboardState.maxReconnectAttempts) {
        console.log('[Dashboard] Max reconnect attempts reached');
        return;
    }

    dashboardState.reconnectAttempts++;
    console.log(`[Dashboard] Reconnecting... (${dashboardState.reconnectAttempts}/${dashboardState.maxReconnectAttempts})`);

    setTimeout(connectWebSocket, dashboardState.reconnectDelay);
}

/**
 * Update connection status indicator
 */
function updateConnectionStatus(connected) {
    const indicator = document.getElementById('ws-connection-indicator');
    if (indicator) {
        indicator.className = connected
            ? 'h-3 w-3 rounded-full bg-emerald-500 animate-pulse'
            : 'h-3 w-3 rounded-full bg-red-500';
        indicator.title = connected ? 'Connected' : 'Disconnected';
    }
}

/**
 * Handle WebSocket messages
 */
function handleWebSocketMessage(message) {
    switch (message.type) {
        case 'INITIAL_DATA':
            updateDashboard(message.payload);
            break;
        case 'FILE_DETECTED':
            handleFileDetected(message.payload);
            break;
        case 'FILE_CONFIRMED':
            handleFileConfirmed(message.payload);
            break;
        case 'API_DATA_RECEIVED':
            handleApiDataReceived(message.payload);
            break;
        case 'FORECAST_CHANGE':
            handleForecastChange(message.payload);
            break;
        case 'DETECTION_WINDOW_START':
            handleDetectionWindowStart(message.payload);
            break;
        default:
            console.log('[Dashboard] Unknown message type:', message.type);
    }
}

/**
 * Fetch all dashboard data via REST API
 */
async function fetchAllDashboardData() {
    console.log('[Dashboard] Fetching all dashboard data...');
    try {
        const response = await fetch(`${API_BASE}/all`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        console.log('[Dashboard] Received dashboard data:', data);
        updateDashboard(data);
    } catch (err) {
        console.error('[Dashboard] Error fetching dashboard data:', err);
        showError('Failed to load dashboard data: ' + err.message);
    }
}

/**
 * Show error message in UI
 */
function showError(message) {
    console.error('[Dashboard] Error:', message);
    // Update key elements to show error state
    const elements = [
        'fi-system-status',
        'city-coverage-container',
        'event-log-container'
    ];
    elements.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.innerHTML = `<div class="text-rose-400 text-sm">Error: ${message}</div>`;
        }
    });
}

/**
 * Fetch non-WebSocket data (periodic updates)
 */
async function fetchNonWsData() {
    try {
        // Fetch latency metrics (these update frequently)
        const latencyRes = await fetch(`${API_BASE}/latency`);
        const latencyData = await latencyRes.json();
        updateLatencyMetrics(latencyData);

        // Fetch events
        const eventsRes = await fetch(`${API_BASE}/events?limit=20`);
        const eventsData = await eventsRes.json();
        updateEventLog(eventsData);

        // Fetch confidence compression data (from /api/confidence, not /api/dashboard/confidence)
        try {
            const confidenceRes = await fetch('/api/confidence');
            const confidenceData = await confidenceRes.json();
            updateConfidencePanel(confidenceData);
        } catch (ccErr) {
            console.warn('[Dashboard] Confidence data not available:', ccErr);
        }
    } catch (err) {
        console.error('[Dashboard] Error fetching non-WS data:', err);
    }
}

/**
 * Update confidence compression strategy panel
 */
function updateConfidencePanel(data) {
    if (!data) return;

    const firstRunBlocksEl = document.getElementById('cc-first-run-blocks');
    const stabilityBlocksEl = document.getElementById('cc-stability-blocks');
    const confidenceBlocksEl = document.getElementById('cc-confidence-blocks');
    const signalsEl = document.getElementById('cc-signals');
    const tempThresholdEl = document.getElementById('cc-temp-threshold');
    const precipThresholdEl = document.getElementById('cc-precip-threshold');

    if (firstRunBlocksEl) firstRunBlocksEl.textContent = data.firstRunBlocks || 0;
    if (stabilityBlocksEl) stabilityBlocksEl.textContent = data.stabilityBlocks || 0;
    if (confidenceBlocksEl) confidenceBlocksEl.textContent = data.confidenceBlocks || 0;
    if (signalsEl) signalsEl.textContent = data.signalsGenerated || 0;

    if (tempThresholdEl && data.thresholds) {
        tempThresholdEl.textContent = `${Math.round((data.thresholds.temperature || 0.6) * 100)}%`;
    }
    if (precipThresholdEl && data.thresholds) {
        precipThresholdEl.textContent = `${Math.round((data.thresholds.precipitation || 0.75) * 100)}%`;
    }
}

/**
 * Update entire dashboard
 */
function updateDashboard(data) {
    if (data.status) updateSystemStatus(data.status);
    if (data.models) updateModelStatus(data.models);
    if (data.cities) updateCityCoverage(data.cities);
    if (data.latency) updateLatencyMetrics(data.latency);
    if (data.apiFallback) updateApiFallbackStatus(data.apiFallback);
    if (data.events) updateEventLog(data.events);
    if (data.windows) updateDetectionWindows(data.windows);
    if (data.upcoming) updateUpcomingRuns(data.upcoming);
}

/**
 * Update system status panel
 */
function updateSystemStatus(status) {
    console.log('[Dashboard] Updating system status:', status);
    const statusEl = document.getElementById('fi-system-status');
    const modeEl = document.getElementById('fi-operational-mode');
    const windowsEl = document.getElementById('fi-active-windows');
    const lastConfirmEl = document.getElementById('fi-last-confirmation');

    if (statusEl) {
        statusEl.textContent = status.status;
        statusEl.className = `text-2xl font-bold ${status.status === 'ACTIVE' ? 'text-emerald-400' : 'text-rose-400'}`;
    }

    if (modeEl) {
        modeEl.textContent = status.mode;
        const modeColors = {
            'FILE_PRIMARY': 'text-blue-400',
            'API_FALLBACK': 'text-amber-400',
            'BOTH': 'text-violet-400',
            'INACTIVE': 'text-slate-400',
        };
        modeEl.className = `text-lg font-mono ${modeColors[status.mode] || 'text-slate-400'}`;
    }

    if (windowsEl) {
        windowsEl.textContent = status.activeDetectionWindows;
    }

    if (lastConfirmEl) {
        if (status.lastFileConfirmation) {
            lastConfirmEl.textContent = formatTimeAgo(new Date(status.lastFileConfirmation));
        } else {
            lastConfirmEl.textContent = 'Never';
        }
    }
}

/**
 * Update model status grid
 */
function updateModelStatus(models) {
    console.log('[Dashboard] Updating model status:', models);
    if (!Array.isArray(models)) {
        console.error('[Dashboard] Invalid models data:', models);
        return;
    }

    models.forEach(model => {
        const card = document.getElementById(`model-card-${model.model}`);
        const statusEl = document.getElementById(`model-status-${model.model}`);
        const progressEl = document.getElementById(`model-progress-${model.model}`);
        const lastRunEl = document.getElementById(`model-last-${model.model}`);
        const nextExpectedEl = document.getElementById(`model-next-${model.model}`);

        if (statusEl) {
            statusEl.textContent = model.status;
            const statusColors = {
                'WAITING': 'text-slate-400',
                'DETECTING': 'text-amber-400 animate-pulse',
                'CONFIRMED': 'text-emerald-400',
                'TIMEOUT': 'text-rose-400',
                'ERROR': 'text-rose-500',
            };
            statusEl.className = `text-lg font-bold ${statusColors[model.status] || 'text-slate-400'}`;
        }

        if (progressEl) {
            progressEl.style.width = `${model.progress}%`;
            const progressColors = {
                'WAITING': 'bg-slate-600',
                'DETECTING': 'bg-amber-500',
                'CONFIRMED': 'bg-emerald-500',
                'TIMEOUT': 'bg-rose-500',
                'ERROR': 'bg-rose-600',
            };
            progressEl.className = `h-full rounded-full transition-all duration-500 ${progressColors[model.status] || 'bg-slate-600'}`;
        }

        if (lastRunEl) {
            if (model.lastRun) {
                try {
                    lastRunEl.textContent = formatTime(new Date(model.lastRun));
                } catch (e) {
                    lastRunEl.textContent = String(model.lastRun);
                }
            } else {
                lastRunEl.textContent = '--';
            }
        }

        if (nextExpectedEl) {
            if (model.nextExpected) {
                try {
                    nextExpectedEl.textContent = formatTimeAgo(new Date(model.nextExpected));
                } catch (e) {
                    nextExpectedEl.textContent = String(model.nextExpected);
                }
            } else {
                nextExpectedEl.textContent = '--';
            }
        }

        // Update card border color based on status
        if (card) {
            const borderColors = {
                'WAITING': 'border-slate-700',
                'DETECTING': 'border-amber-500/50',
                'CONFIRMED': 'border-emerald-500/50',
                'TIMEOUT': 'border-rose-500/50',
                'ERROR': 'border-rose-600/50',
            };
            card.className = `bg-slate-800/50 rounded-lg p-4 border ${borderColors[model.status] || 'border-slate-700'}`;
        }
    });
}

/**
 * Update city coverage table
 */
function updateCityCoverage(cities) {
    console.log('[Dashboard] Updating city coverage:', cities);
    const container = document.getElementById('city-coverage-container');
    if (!container) return;

    if (!Array.isArray(cities) || cities.length === 0) {
        container.innerHTML = '<div class="text-slate-500 text-sm italic">No city data available</div>';
        return;
    }

    container.innerHTML = cities.map(city => {
        // Handle both camelCase and snake_case property names
        const cityName = city.cityName || city.city_name || city.name || 'Unknown';
        const primaryModel = city.primaryModel || city.primary_model || 'N/A';
        const confirmationStatus = city.confirmationStatus || city.confirmation_status || 'STALE';
        const temperature = city.temperature !== undefined ? city.temperature : null;
        const windSpeed = city.windSpeed !== undefined ? city.windSpeed : city.wind_speed !== undefined ? city.wind_speed : null;
        const precipitation = city.precipitation !== undefined ? city.precipitation : city.precip !== undefined ? city.precip : null;
        const temperatureChange = city.temperatureChange !== undefined ? city.temperatureChange : city.temperature_change !== undefined ? city.temperature_change : null;
        const lastUpdate = city.lastUpdate || city.last_update || null;

        const statusIcon = confirmationStatus === 'FILE_CONFIRMED'
            ? '<span class="text-emerald-400">✓</span>'
            : confirmationStatus === 'API_UNCONFIRMED'
                ? '<span class="text-amber-400">~</span>'
                : '<span class="text-slate-600">○</span>';

        const tempChange = temperatureChange !== null && temperatureChange !== undefined
            ? `<span class="${temperatureChange > 0 ? 'text-rose-400' : 'text-blue-400'} text-xs">
                ${temperatureChange > 0 ? '↑' : '↓'} ${Math.abs(temperatureChange).toFixed(1)}
               </span>`
            : '';

        let lastUpdateStr = '--';
        if (lastUpdate) {
            try {
                lastUpdateStr = formatTimeAgo(new Date(lastUpdate));
            } catch (e) {
                lastUpdateStr = String(lastUpdate);
            }
        }

        return `
            <div class="bg-slate-800/30 rounded p-3 border border-slate-700/50 hover:border-slate-600 transition-colors">
                <div class="flex items-center justify-between mb-2">
                    <span class="font-medium text-slate-200">${cityName}</span>
                    <span class="text-xs text-slate-500">${primaryModel}</span>
                </div>
                <div class="flex items-center justify-between">
                    <div class="flex items-center space-x-2">
                        ${statusIcon}
                        <span class="text-xs text-slate-400">${confirmationStatus.replace(/_/g, ' ')}</span>
                    </div>
                    <span class="text-xs text-slate-500">${lastUpdateStr}</span>
                </div>
                <div class="mt-2 grid grid-cols-3 gap-2 text-xs">
                    <div class="text-center">
                        <span class="text-slate-500">Temp</span>
                        <div class="text-slate-200">${temperature !== null ? temperature.toFixed(1) + '°F' : '--'} ${tempChange}</div>
                    </div>
                    <div class="text-center">
                        <span class="text-slate-500">Wind</span>
                        <div class="text-slate-200">${windSpeed !== null ? windSpeed.toFixed(1) + ' mph' : '--'}</div>
                    </div>
                    <div class="text-center">
                        <span class="text-slate-500">Precip</span>
                        <div class="text-slate-200">${precipitation !== null ? precipitation.toFixed(2) + '"' : '--'}</div>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Update latency metrics panel
 */
function updateLatencyMetrics(metrics) {
    console.log('[Dashboard] Updating latency metrics:', metrics);
    if (!metrics) {
        console.error('[Dashboard] Invalid metrics data');
        return;
    }

    // Update text values
    const updateMetric = (type, data) => {
        if (!data) return;
        const lastEl = document.getElementById(`latency-${type}-last`);
        const avgEl = document.getElementById(`latency-${type}-avg`);
        const p95El = document.getElementById(`latency-${type}-p95`);

        if (lastEl) lastEl.textContent = `${data.last || 0}ms`;
        if (avgEl) avgEl.textContent = `${data.average || 0}ms`;
        if (p95El) p95El.textContent = `${data.p95 || 0}ms`;
    };

    // Handle both camelCase and snake_case property names
    const detection = metrics.detection || metrics.detectionLatency;
    const download = metrics.download || metrics.downloadLatency;
    const parse = metrics.parse || metrics.parseLatency;
    const endToEnd = metrics.endToEnd || metrics.endToEndLatency;

    if (detection) updateMetric('detection', detection);
    if (download) updateMetric('download', download);
    if (parse) updateMetric('parse', parse);

    // Update end-to-end gauge
    const e2eEl = document.getElementById('latency-e2e-value');
    const e2eIndicator = document.getElementById('latency-e2e-indicator');
    const e2eAvgEl = document.getElementById('latency-e2e-avg');
    const e2eP95El = document.getElementById('latency-e2e-p95');

    if (e2eEl && endToEnd) {
        e2eEl.textContent = `${endToEnd.last || 0}ms`;
    }

    if (e2eAvgEl && endToEnd) {
        e2eAvgEl.textContent = `${endToEnd.average || 0}ms`;
    }

    if (e2eP95El && endToEnd) {
        e2eP95El.textContent = `${endToEnd.p95 || 0}ms`;
    }

    if (e2eIndicator && endToEnd) {
        if (endToEnd.withinBudget) {
            e2eIndicator.className = 'text-emerald-400 text-xl';
            e2eIndicator.textContent = '✓';
        } else {
            e2eIndicator.className = 'text-rose-400 text-xl';
            e2eIndicator.textContent = '✗';
        }
    }

    // Update charts
    if (detection) updateLatencyChart('detection', detection.last);
    if (download) updateLatencyChart('download', download.last);
    if (parse) updateLatencyChart('parse', parse.last);
    if (endToEnd) updateLatencyChart('endToEnd', endToEnd.last);
}

/**
 * Update API fallback status panel
 */
function updateApiFallbackStatus(status) {
    console.log('[Dashboard] Updating API fallback status:', status);
    if (!status) return;

    const statusEl = document.getElementById('api-status');
    const pollsEl = document.getElementById('api-polls');
    const lastUpdateEl = document.getElementById('api-last-update');
    const ratioEl = document.getElementById('api-ratio');

    if (statusEl) {
        statusEl.textContent = status.status;
        const statusColors = {
            'ACTIVE': 'text-emerald-400',
            'INACTIVE': 'text-slate-400',
            'STANDBY': 'text-amber-400',
        };
        statusEl.className = `text-lg font-bold ${statusColors[status.status] || 'text-slate-400'}`;
    }

    if (pollsEl) pollsEl.textContent = status.totalPollsInWindow || 0;
    if (lastUpdateEl) {
        if (status.lastApiUpdate) {
            lastUpdateEl.textContent = formatTimeAgo(new Date(status.lastApiUpdate));
        } else {
            lastUpdateEl.textContent = 'Never';
        }
    }
    if (ratioEl) ratioEl.textContent = status.ratio || 'N/A';
}

/**
 * Update event log
 */
function updateEventLog(events) {
    console.log('[Dashboard] Updating event log:', events);
    const container = document.getElementById('event-log-container');
    if (!container) return;

    if (!Array.isArray(events) || events.length === 0) {
        container.innerHTML = '<div class="text-slate-500 text-sm italic">No events yet</div>';
        return;
    }

    container.innerHTML = events.map(event => {
        const severityColors = {
            'info': 'border-blue-500/30 bg-blue-500/10 text-blue-400',
            'success': 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
            'warning': 'border-amber-500/30 bg-amber-500/10 text-amber-400',
            'error': 'border-rose-500/30 bg-rose-500/10 text-rose-400',
        };

        const typeColors = {
            'FILE_DETECTED': 'text-blue-400',
            'FILE_CONFIRMED': 'text-emerald-400',
            'API_DATA_RECEIVED': 'text-amber-400',
            'FORECAST_CHANGE': 'text-violet-400',
            'DETECTION_WINDOW_START': 'text-cyan-400',
        };

        return `
            <div class="p-2 rounded border-l-2 ${severityColors[event.severity] || severityColors.info} mb-1 text-sm">
                <div class="flex items-center justify-between">
                    <span class="font-mono text-xs text-slate-500">${formatTime(new Date(event.timestamp))}</span>
                    <span class="text-xs ${typeColors[event.type] || 'text-slate-400'}">${event.type}</span>
                </div>
                <div class="mt-1 text-slate-200">${event.message}</div>
                ${event.confidence ? `<div class="text-xs mt-1">Confidence: ${event.confidence}</div>` : ''}
            </div>
        `;
    }).join('');

    // Auto-scroll to top (newest events)
    container.scrollTop = 0;
}

/**
 * Update detection windows display
 */
function updateDetectionWindows(windows) {
    console.log('[Dashboard] Updating detection windows:', windows);
    const container = document.getElementById('detection-windows-container');
    if (!container) return;

    if (!Array.isArray(windows) || windows.length === 0) {
        container.innerHTML = '<div class="text-slate-500 text-sm italic">No active detection windows</div>';
        return;
    }

    container.innerHTML = windows.map(window => {
        const statusColors = {
            'PENDING': 'text-slate-400',
            'ACTIVE': 'text-amber-400 animate-pulse',
            'DETECTED': 'text-blue-400',
            'CONFIRMED': 'text-emerald-400',
            'TIMEOUT': 'text-rose-400',
        };

        return `
            <div class="bg-slate-800/30 rounded p-2 border border-slate-700/50 text-sm">
                <div class="flex items-center justify-between">
                    <span class="font-medium">${window.model} ${String(window.cycleHour).padStart(2, '0')}Z</span>
                    <span class="${statusColors[window.status] || 'text-slate-400'}">${window.status}</span>
                </div>
                <div class="text-xs text-slate-500 mt-1">
                    ${formatTime(new Date(window.windowStart))} - ${formatTime(new Date(window.windowEnd))}
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Update upcoming runs display
 */
function updateUpcomingRuns(runs) {
    console.log('[Dashboard] Updating upcoming runs:', runs);
    const container = document.getElementById('upcoming-runs-container');
    if (!container) return;

    if (!Array.isArray(runs) || runs.length === 0) {
        container.innerHTML = '<div class="text-slate-500 text-sm italic">No upcoming runs scheduled</div>';
        return;
    }

    container.innerHTML = runs.slice(0, 5).map(run => `
        <div class="flex items-center justify-between text-sm py-1 border-b border-slate-800 last:border-0">
            <span class="text-slate-300">${run.model} ${String(run.cycleHour).padStart(2, '0')}Z</span>
            <span class="text-slate-500 text-xs">${formatTimeAgo(new Date(run.expectedPublishTime))}</span>
        </div>
    `).join('');
}

/**
 * Handle file detected event
 */
function handleFileDetected(payload) {
    console.log('[Dashboard] File detected:', payload);
    // Trigger a refresh of model status
    fetch(`${API_BASE}/models`).then(r => r.json()).then(updateModelStatus);
}

/**
 * Handle file confirmed event
 */
function handleFileConfirmed(payload) {
    console.log('[Dashboard] File confirmed:', payload);
    // Trigger refresh of model status and city coverage
    Promise.all([
        fetch(`${API_BASE}/models`).then(r => r.json()),
        fetch(`${API_BASE}/cities`).then(r => r.json()),
    ]).then(([models, cities]) => {
        updateModelStatus(models);
        updateCityCoverage(cities);
    });
}

/**
 * Handle API data received event
 */
function handleApiDataReceived(payload) {
    console.log('[Dashboard] API data received:', payload);
    fetch(`${API_BASE}/cities`).then(r => r.json()).then(updateCityCoverage);
}

/**
 * Handle forecast change event
 */
function handleForecastChange(payload) {
    console.log('[Dashboard] Forecast change:', payload);
    fetch(`${API_BASE}/cities`).then(r => r.json()).then(updateCityCoverage);
}

/**
 * Handle detection window start event
 */
function handleDetectionWindowStart(payload) {
    console.log('[Dashboard] Detection window start:', payload);
    fetch(`${API_BASE}/windows`).then(r => r.json()).then(updateDetectionWindows);
}

/**
 * Initialize charts
 */
function initCharts() {
    // Simple canvas-based latency charts
    const initChart = (canvasId, label, color) => {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;

        dashboardState.charts[canvasId] = {
            canvas,
            label,
            color,
            data: [],
        };
    };

    initChart('chart-detection', 'Detection', '#10b981');
    initChart('chart-download', 'Download', '#3b82f6');
    initChart('chart-parse', 'Parse', '#8b5cf6');
    initChart('chart-e2e', 'End-to-End', '#f59e0b');
}

/**
 * Update latency chart with new data point
 */
function updateLatencyChart(type, value) {
    const chartId = `chart-${type}`;
    const chart = dashboardState.charts[chartId];
    if (!chart || !value) return;

    // Add data point
    chart.data.push(value);
    if (chart.data.length > dashboardState.maxHistoryPoints) {
        chart.data.shift();
    }

    // Draw chart
    drawChart(chart);
}

/**
 * Draw chart on canvas
 */
function drawChart(chart) {
    const { canvas, data, color } = chart;
    const ctx = canvas.getContext('2d');
    const width = canvas.width = canvas.offsetWidth;
    const height = canvas.height = canvas.offsetHeight;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    if (data.length < 2) return;

    // Find min/max for scaling
    const max = Math.max(...data) * 1.1;
    const min = Math.min(...data) * 0.9;
    const range = max - min || 1;

    // Draw line
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;

    data.forEach((value, index) => {
        const x = (index / (data.length - 1)) * width;
        const y = height - ((value - min) / range) * height;

        if (index === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    });

    ctx.stroke();

    // Draw fill
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fillStyle = color + '20'; // Add transparency
    ctx.fill();
}

/**
 * Setup event listeners
 */
function setupEventListeners() {
    // Refresh button
    const refreshBtn = document.getElementById('refresh-dashboard-btn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', fetchAllDashboardData);
    }

    // Speed Arbitrage Toggle
    const speedArbToggle = document.getElementById('speed-arb-toggle');
    if (speedArbToggle) {
        speedArbToggle.addEventListener('change', async (e) => {
            const enabled = e.target.checked;
            try {
                const res = await fetch('/api/speed-arb/toggle', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled }),
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
            } catch (err) {
                console.error('Speed arb toggle failed:', err);
                e.target.checked = !enabled;
            }
        });
    }

    // Window resize for charts
    window.addEventListener('resize', () => {
        Object.values(dashboardState.charts).forEach(chart => {
            if (chart.canvas) drawChart(chart);
        });
    });
}

/**
 * Fetch speed arbitrage stats and toggle state
 */
async function fetchSpeedArbData() {
    try {
        // Fetch current settings to get toggle state
        const settingsRes = await fetch('/api/settings');
        const settings = await settingsRes.json();
        const toggle = document.getElementById('speed-arb-toggle');
        if (toggle && toggle.checked !== settings.speedArbEnabled) {
            toggle.checked = settings.speedArbEnabled;
        }

        // Fetch speed arb stats
        const statsRes = await fetch('/api/speed-arb/stats');
        const stats = await statsRes.json();

        const tradesEl = document.getElementById('speed-arb-trades');
        const oppsEl = document.getElementById('speed-arb-opportunities');
        const pnlEl = document.getElementById('speed-arb-pnl');
        const lastTradeEl = document.getElementById('speed-arb-last-trade');

        if (tradesEl) tradesEl.textContent = stats.trades || 0;
        if (oppsEl) oppsEl.textContent = `${stats.opportunities || 0} detected / ${stats.skipped || 0} skipped`;
        if (pnlEl) {
            const pnl = stats.pnl || 0;
            pnlEl.textContent = `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`;
            pnlEl.className = `text-2xl font-bold mt-1 ${pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`;
        }
        if (lastTradeEl) {
            if (stats.lastTradeTime) {
                lastTradeEl.textContent = formatTimeAgo(new Date(stats.lastTradeTime));
            } else {
                lastTradeEl.textContent = '--';
            }
        }
    } catch (err) {
        console.error('[Dashboard] Error fetching speed arb data:', err);
    }
}

/**
 * Format time
 */
function formatTime(date) {
    if (!date || isNaN(date.getTime())) return '--';
    return date.toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}

/**
 * Format time ago - handles both past and future times
 * For future times: shows "Expected in Xm Ys"
 * For past times: shows "Xm Ys ago"
 */
function formatTimeAgo(date) {
    if (!date || !(date instanceof Date) || isNaN(date.getTime())) return '--';

    const now = new Date();
    const diffMs = date.getTime() - now.getTime();
    const isFuture = diffMs > 0;
    const absSeconds = Math.floor(Math.abs(diffMs) / 1000);
    const absMinutes = Math.floor(absSeconds / 60);
    const absHours = Math.floor(absMinutes / 60);

    let timeStr;
    if (absSeconds < 60) {
        timeStr = `${absSeconds}s`;
    } else if (absMinutes < 60) {
        const secs = absSeconds % 60;
        timeStr = secs > 0 ? `${absMinutes}m ${secs}s` : `${absMinutes}m`;
    } else {
        const mins = absMinutes % 60;
        timeStr = mins > 0 ? `${absHours}h ${mins}m` : `${absHours}h`;
    }

    return isFuture ? `Expected in ${timeStr}` : `${timeStr} ago`;
}

/**
 * Fetch portfolio data from the API
 */
async function fetchPortfolioData() {
    console.log('[Dashboard] Fetching portfolio data...');
    try {
        const response = await fetch('/api/portfolio');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        console.log('[Dashboard] Received portfolio data:', data);
        updatePortfolioDisplay(data);
    } catch (err) {
        console.error('[Dashboard] Error fetching portfolio data:', err);
    }
}

/**
 * Fetch positions data from the API
 */
async function fetchPositionsData() {
    console.log('[Dashboard] Fetching positions data...');
    try {
        // Fetch active positions
        const activeResponse = await fetch('/api/positions/active');
        if (!activeResponse.ok) {
            throw new Error(`HTTP error! status: ${activeResponse.status}`);
        }
        const activePositions = await activeResponse.json();
        console.log('[Dashboard] Received active positions:', activePositions);

        // Fetch closed positions
        const closedResponse = await fetch('/api/positions/closed');
        if (!closedResponse.ok) {
            throw new Error(`HTTP error! status: ${closedResponse.status}`);
        }
        const closedPositions = await closedResponse.json();
        console.log('[Dashboard] Received closed positions:', closedPositions);

        updatePositionsDisplay(activePositions, closedPositions);
    } catch (err) {
        console.error('[Dashboard] Error fetching positions data:', err);
    }
}

/**
 * Update positions display elements
 */
function updatePositionsDisplay(activePositions, closedPositions) {
    const openPositionsEl = document.getElementById('open-positions-count');
    const positionsListEl = document.getElementById('positions-list');
    const closedPositionsEl = document.getElementById('closed-positions-list');

    if (openPositionsEl) {
        openPositionsEl.textContent = activePositions.length;
    }

    // Update open positions list
    if (positionsListEl) {
        if (!Array.isArray(activePositions) || activePositions.length === 0) {
            positionsListEl.innerHTML = '<div class="text-slate-500 text-sm italic">No open positions</div>';
        } else {
            positionsListEl.innerHTML = activePositions.map(pos => {
                const pnl = pos.unrealizedPnL || pos.pnl || 0;
                const pnlPercent = pos.pnlPercent || 0;
                const pnlClass = pnl >= 0 ? 'text-emerald-400' : 'text-rose-400';
                const pnlSign = pnl >= 0 ? '+' : '';

                return `
                    <div class="bg-slate-800/50 rounded p-3 border border-slate-700/50">
                        <div class="flex items-center justify-between mb-2">
                            <span class="font-medium text-slate-200 text-sm">${pos.marketQuestion || pos.marketTitle || pos.marketId}</span>
                            <span class="text-xs px-2 py-1 rounded ${pos.side === 'yes' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}">${pos.side.toUpperCase()}</span>
                        </div>
                        <div class="grid grid-cols-4 gap-2 text-xs">
                            <div>
                                <span class="text-slate-500">Shares</span>
                                <div class="text-slate-200">${pos.shares}</div>
                            </div>
                            <div>
                                <span class="text-slate-500">Entry</span>
                                <div class="text-slate-200">$${pos.entryPrice.toFixed(3)}</div>
                            </div>
                            <div>
                                <span class="text-slate-500">Current</span>
                                <div class="text-slate-200">$${(pos.currentPrice || pos.entryPrice).toFixed(3)}</div>
                            </div>
                            <div>
                                <span class="text-slate-500">P&L</span>
                                <div class="${pnlClass}">${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlPercent.toFixed(1)}%)</div>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        }
    }

    // Update closed positions list
    if (closedPositionsEl) {
        if (!Array.isArray(closedPositions) || closedPositions.length === 0) {
            closedPositionsEl.innerHTML = '<div class="text-slate-500 text-sm italic">No closed positions</div>';
        } else {
            // Show only the 5 most recent closed positions
            closedPositionsEl.innerHTML = closedPositions.slice(0, 5).map(pos => {
                const pnl = pos.realizedPnL || 0;
                const pnlPercent = pos.pnlPercent || 0;
                const pnlClass = pnl >= 0 ? 'text-emerald-400' : 'text-rose-400';
                const pnlSign = pnl >= 0 ? '+' : '';

                return `
                    <div class="bg-slate-800/30 rounded p-2 border border-slate-700/30 text-sm">
                        <div class="flex items-center justify-between">
                            <span class="text-slate-300 truncate max-w-[200px]">${pos.marketQuestion || pos.marketId}</span>
                            <span class="${pnlClass} font-mono">${pnlSign}$${pnl.toFixed(2)}</span>
                        </div>
                        <div class="text-xs text-slate-500 mt-1">
                            ${pos.side.toUpperCase()} • ${pos.shares} shares • ${pnlPercent.toFixed(1)}%
                        </div>
                    </div>
                `;
            }).join('');
        }
    }
}

/**
 * Update portfolio display elements
 */
function updatePortfolioDisplay(data) {
    const totalEquityEl = document.getElementById('total-equity');
    const totalPnlEl = document.getElementById('total-pnl');
    const cashBalanceEl = document.getElementById('cash-balance');
    const openPositionsEl = document.getElementById('open-positions-count');

    if (totalEquityEl) {
        const totalValue = data.totalValue || data.totalEquity || 0;
        totalEquityEl.textContent = `$${totalValue.toLocaleString()}`;
    }

    if (totalPnlEl) {
        const pnl = data.totalPnL || data.totalPnl || 0;
        const pnlPercent = data.totalPnLPercent || 0;
        const sign = pnl >= 0 ? '+' : '';
        totalPnlEl.textContent = `${sign}$${pnl.toFixed(2)} (${sign}${pnlPercent.toFixed(2)}%)`;
        totalPnlEl.className = `text-sm mt-2 ${pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`;
    }

    if (cashBalanceEl) {
        const currentCash = data.currentCash || data.cashBalance || 0;
        cashBalanceEl.textContent = `$${currentCash.toLocaleString()}`;
    }

    if (openPositionsEl) {
        // openPositions is now updated by fetchPositionsData, but we keep this as fallback
        if (!openPositionsEl.textContent || openPositionsEl.textContent === '--') {
            openPositionsEl.textContent = data.openPositions || '0';
        }
    }
}

/**
 * Fetch status data from the API
 */
async function fetchStatusData() {
    console.log('[Dashboard] Fetching status data...');
    try {
        const response = await fetch('/api/status');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        console.log('[Dashboard] Received status data:', data);
        updateStatusDisplay(data);
    } catch (err) {
        console.error('[Dashboard] Error fetching status data:', err);
    }
}

/**
 * Update status display elements
 */
function updateStatusDisplay(data) {
    console.log('[Dashboard] Updating status display:', data);
    const webhookCountEl = document.getElementById('webhook-count');
    const fetchCyclesEl = document.getElementById('fetch-cycles');
    const statusTextEl = document.getElementById('status-text');

    if (webhookCountEl) {
        // Try different possible property names for cycles
        const cycles = data.cycles || data.fetchCyclesCompleted || data.webhooksReceived || 0;
        webhookCountEl.textContent = cycles;
    }

    if (fetchCyclesEl) {
        const cycles = data.cycles || data.fetchCyclesCompleted || data.webhooksReceived || 0;
        fetchCyclesEl.textContent = `${cycles} cycles`;
    }

    if (statusTextEl) {
        const isOnline = data.online !== undefined ? data.online : true;
        statusTextEl.textContent = isOnline ? 'ONLINE' : 'OFFLINE';
        statusTextEl.className = isOnline ? 'text-emerald-400 font-mono font-bold' : 'text-rose-400 font-mono font-bold';
    }
}

// Initialize dashboard when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    console.log('[Dashboard] DOM ready, initializing...');

    // Initialize dashboard (WebSocket, event listeners, charts)
    initDashboard();

    // Fetch portfolio data immediately and periodically
    fetchPortfolioData();
    fetchStatusData();
    fetchPositionsData();

    // Fetch speed arb data
    fetchSpeedArbData();

    // Set up periodic refresh intervals
    setInterval(fetchPortfolioData, 5000);
    setInterval(fetchStatusData, 5000);
    setInterval(fetchPositionsData, 5000);
    setInterval(fetchSpeedArbData, 3000);

    console.log('[Dashboard] Initialization complete');
});

// Export for global access
window.dashboard = {
    refresh: fetchAllDashboardData,
    reconnect: connectWebSocket,
    fetchPortfolio: fetchPortfolioData,
    fetchStatus: fetchStatusData,
    fetchPositions: fetchPositionsData,
    fetchSpeedArb: fetchSpeedArbData,
};
