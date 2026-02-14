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
    // Change-detection hashes to skip redundant DOM rebuilds
    _hashes: {},
    // Abort controller for request deduplication
    abortController: null,
    // Request in flight flag
    isFetching: false,
    // Last successful fetch timestamp
    lastFetchTime: 0,
    // Minimum time between fetches (ms)
    minFetchInterval: 1000,
};

/**
 * Simple hash for change detection — returns true if data changed since last call for this key
 */
function hasChanged(key, data) {
    const hash = JSON.stringify(data);
    if (dashboardState._hashes[key] === hash) return false;
    dashboardState._hashes[key] = hash;
    return true;
}

// API base URL
const API_BASE = '/api/dashboard';
// Handle both http and https protocols for WebSocket
const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = `${WS_PROTOCOL}//${window.location.host}/ws/dashboard`;

/**
 * Initialize dashboard
 */
function initDashboard() {
    // Connect WebSocket
    connectWebSocket();

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
            // WebSocket connected
            dashboardState.isConnected = true;
            dashboardState.reconnectAttempts = 0;
            updateConnectionStatus(true);
        };

        dashboardState.ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                handleWebSocketMessage(message);
            } catch (err) {
                // Parse error on WS message
            }
        };

        dashboardState.ws.onclose = () => {
            // WebSocket disconnected
            dashboardState.isConnected = false;
            updateConnectionStatus(false);
            attemptReconnect();
        };

        dashboardState.ws.onerror = (error) => {
            // WebSocket error
            dashboardState.isConnected = false;
            updateConnectionStatus(false);
        };
    } catch (err) {
        // WebSocket creation error
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
 * NOTE: WebSocket only shows inline event notifications, NOT dashboard data
 * Dashboard data comes from HTTP polling to avoid race conditions
 */
function handleWebSocketMessage(message) {
    switch (message.type) {
        case 'INITIAL_DATA':
            // Ignore - we use HTTP polling for data
            console.log('[Dashboard] WebSocket INITIAL_DATA ignored - using HTTP polling');
            break;
        case 'FILE_DETECTED':
            handleFileDetected(message.payload);
            // Trigger poll refresh for latest data
            setTimeout(fetchAllDashboardData, 100);
            break;
        case 'FILE_CONFIRMED':
            handleFileConfirmed(message.payload);
            setTimeout(fetchAllDashboardData, 100);
            break;
        case 'API_DATA_RECEIVED':
            handleApiDataReceived(message.payload);
            break;
        case 'FORECAST_CHANGE':
            handleForecastChange(message.payload);
            setTimeout(fetchAllDashboardData, 100);
            break;
        case 'DETECTION_WINDOW_START':
            handleDetectionWindowStart(message.payload);
            break;
        default:
            console.log('[Dashboard] Unknown message type:', message.type);
    }
}

/**
 * Single consolidated poll — replaces all individual fetch intervals
 * Fetches everything from /api/poll in one request
 * Includes request deduplication and error handling
 */
async function fetchAllDashboardData() {
    // Prevent concurrent requests
    if (dashboardState.isFetching) {
        console.log('[Dashboard] Fetch already in progress, skipping');
        return;
    }

    // Rate limiting - don't fetch more than once per second
    const now = Date.now();
    if (now - dashboardState.lastFetchTime < dashboardState.minFetchInterval) {
        return;
    }

    // Cancel any previous in-flight request
    if (dashboardState.abortController) {
        dashboardState.abortController.abort();
    }
    dashboardState.abortController = new AbortController();
    dashboardState.isFetching = true;

    try {
        const response = await fetch('/api/poll', {
            signal: dashboardState.abortController.signal,
            headers: { 'Cache-Control': 'no-cache' }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        dashboardState.lastFetchTime = Date.now();
        
        // Update status display
        if (data.status) updateStatusDisplay(data.status);
        
        // Update portfolio
        if (data.portfolio) updatePortfolioDisplay(data.portfolio);
        
        // Update positions
        if (data.activePositions || data.closedPositions) {
            updatePositionsDisplay(data.activePositions || [], data.closedPositions || []);
        }
        
        // Update speed arb
        if (data.speedArb) updateSpeedArbDisplay(data.speedArb);
        
        // Update webhook/cycle counts
        if (data.webhook) updateWebhookDisplay(data.webhook);
        
        // Update confidence compression
        if (data.confidence) updateConfidencePanel(data.confidence);
        
        // Update weather dashboard sections
        if (data.weather) updateDashboard(data.weather);

        // Update market edge analysis (pass active positions for context)
        if (data.marketAnalysis) updateMarketEdge(data.marketAnalysis, data.activePositions || []);
        
        // Update win/lose ratio
        if (data.winLossStats) updateWinLossDisplay(data.winLossStats);
        
        // Clear any error state on success
        clearErrorState();
        
    } catch (err) {
        if (err.name === 'AbortError') {
            console.log('[Dashboard] Fetch aborted (newer request started)');
        } else {
            console.error('[Dashboard] Poll error:', err.message);
            showErrorState(`Data refresh failed: ${err.message}`);
        }
    } finally {
        dashboardState.isFetching = false;
    }
}

/**
 * Show error state in UI when data fetching fails
 */
function showErrorState(message) {
    const statusTextEl = document.getElementById('status-text');
    if (statusTextEl) {
        statusTextEl.textContent = 'ERROR';
        statusTextEl.className = 'text-amber-500 font-mono font-bold';
        statusTextEl.title = message;
    }
}

/**
 * Clear error state when data fetching succeeds
 */
function clearErrorState() {
    const statusTextEl = document.getElementById('status-text');
    if (statusTextEl && statusTextEl.textContent === 'ERROR') {
        statusTextEl.textContent = 'ONLINE';
        statusTextEl.className = 'text-emerald-400 font-mono font-bold';
        statusTextEl.title = '';
    }
}

/**
 * Update Market Edge Overview
 */
function updateMarketEdge(analysis, activePositions = []) {
    const list = document.getElementById('market-edge-list');
    if (!list) return;

    if (!Array.isArray(analysis) || analysis.length === 0) {
        list.innerHTML = '<tr><td colspan="8" class="p-4 text-center text-slate-500 italic">No active markets analyzed</td></tr>';
        return;
    }

    // Filter out clutter (stability check failures, first run blocks, invalid prices)
    // Only show: non-blocked trades, or blocked with meaningful edge (>2%)
    const filtered = analysis.filter(item => {
        // Skip invalid prices (market closed, no base price, $0)
        const hasValidPrice = item.marketProbability > 0 && item.marketProbability < 1;
        if (!hasValidPrice) return false;
        
        // Skip stability/first-run noise unless it's a real trade opportunity
        if (!item.blocked) return true;
        
        return item.blockReason !== 'STABILITY_CHECK_FAILED' && 
               item.blockReason !== 'FIRST_RUN' &&
               item.blockReason !== 'NOT_PRIMARY_MODEL' &&
               (item.rawEdge || 0) > 0.02;
    });
    
    // Calculate hidden count for UI feedback
    const hiddenCount = analysis.length - filtered.length;
    
    // Sort by edge magnitude descending
    const sorted = filtered.sort((a, b) => (b.rawEdge || 0) - (a.rawEdge || 0));
    
    // Show empty state with hidden count if everything filtered
    if (sorted.length === 0) {
        list.innerHTML = `<tr><td colspan="8" class="p-4 text-center text-slate-500 italic">No actionable markets (${hiddenCount} filtered: stability/first-run checks)</td></tr>`;
        return;
    }

    list.innerHTML = sorted.map(item => {
        const mktProb = (item.marketProbability || 0) * 100;
        const modelProb = (item.modelProbability || 0) * 100;
        const edge = (item.rawEdge || 0) * 100;
        const conf = (item.confidenceScore || 0) * 100;
        
        // Find position
        const position = activePositions.find(p => p.marketId === item.marketId);
        const posText = position ? `${position.shares} ${position.side.toUpperCase()}` : '--';
        const posClass = position ? (position.side === 'yes' ? 'text-emerald-400' : 'text-rose-400') : 'text-slate-600';

        // Target Date
        let targetText = '--';
        if (item.targetDate) {
            const d = new Date(item.targetDate);
            targetText = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        }

        let statusClass = 'text-slate-500';
        let statusText = 'Tracking';
        
        if (!item.blocked) {
            statusClass = 'text-emerald-400 font-bold animate-pulse';
            statusText = 'TRADING';
        } else if (item.blockReason === 'EDGE_TOO_SMALL') {
            statusClass = 'text-slate-500';
            statusText = 'No Edge';
        } else if (item.blockReason === 'CONFIDENCE_BELOW_THRESHOLD') {
            statusClass = 'text-amber-500';
            statusText = 'Low Conf';
        } else {
            statusClass = 'text-rose-400';
            statusText = item.blockReason?.replace(/_/g, ' ') || 'Blocked';
        }

        // Highlight edge
        const edgeClass = edge > 5 ? 'text-emerald-400 font-bold' : (edge > 2 ? 'text-emerald-300' : 'text-slate-400');

        return `
            <tr class="border-b border-slate-700/50 hover:bg-slate-800/30 transition-colors">
                <td class="p-3">
                    <div class="font-mono text-xs text-slate-400">${item.marketId.substring(0, 8)}...</div>
                    <div class="text-xs text-slate-500">${item.blockReason ? '' : (item.signal?.side?.toUpperCase() || '')}</div>
                </td>
                <td class="p-3 text-right font-mono text-xs ${posClass}">${posText}</td>
                <td class="p-3 text-right font-mono text-xs text-slate-400">${targetText}</td>
                <td class="p-3 text-right font-mono text-slate-300">${mktProb.toFixed(1)}%</td>
                <td class="p-3 text-right font-mono text-blue-300">${modelProb.toFixed(1)}%</td>
                <td class="p-3 text-right font-mono ${edgeClass}">${edge.toFixed(1)}%</td>
                <td class="p-3 text-right font-mono text-violet-300">${conf.toFixed(0)}%</td>
                <td class="p-3 text-center text-xs ${statusClass}">${statusText}</td>
            </tr>
        `;
    }).join('');
}

/**
 * Update Model Intelligence Panel (part of dashboard update)
 */
function updateModelIntelligence(models) {
    const grid = document.getElementById('model-intelligence-grid');
    if (!grid) return;
    
    // We reuse the data from 'models' passed to updateDashboard
    // But we render it differently here (more compact/intelligence focused)
    
    if (!Array.isArray(models)) return;

    grid.innerHTML = models.map(m => {
        const lastRunTime = m.lastRun ? new Date(m.lastRun) : null;
        const nextRunTime = m.nextExpected ? new Date(m.nextExpected) : null;
        
        // Calculate delay/freshness
        let status = 'Unknown';
        let statusColor = 'text-slate-500';
        
        if (m.status === 'CONFIRMED') {
            status = 'Fresh';
            statusColor = 'text-emerald-400';
        } else if (m.status === 'DETECTING') {
            status = 'Ingesting...';
            statusColor = 'text-amber-400 animate-pulse';
        } else if (m.status === 'WAITING') {
            status = 'Waiting';
            statusColor = 'text-blue-400';
        }
        
        return `
            <div class="flex items-center justify-between p-2 bg-slate-800/30 rounded border border-slate-700/30">
                <div class="flex items-center space-x-3">
                    <div class="w-2 h-2 rounded-full ${m.status === 'CONFIRMED' ? 'bg-emerald-500' : (m.status === 'DETECTING' ? 'bg-amber-500' : 'bg-slate-600')}"></div>
                    <span class="font-bold text-slate-200">${m.model}</span>
                </div>
                <div class="text-right">
                    <div class="text-xs ${statusColor}">${status}</div>
                    <div class="text-[10px] text-slate-500 font-mono">${m.lastRun ? formatTimeAgo(lastRunTime) : 'No data'}</div>
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Show error message in UI
 */
function showError(message) {
    const elements = [
        'fi-system-status',
        'city-coverage-container',
        'event-log-container',
        'market-edge-list'
    ];
    elements.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.innerHTML = `<div class="text-rose-400 text-sm p-2">Error: ${message}</div>`;
        }
    });
}

/**
 * Update speed arb display from batched poll data
 */
function updateSpeedArbDisplay(stats) {
    const toggle = document.getElementById('speed-arb-toggle');
    if (toggle && toggle.checked !== stats.enabled) {
        toggle.checked = stats.enabled;
    }
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
        lastTradeEl.textContent = stats.lastTradeTime ? formatTimeAgo(new Date(stats.lastTradeTime)) : '--';
    }
}

/**
 * Update webhook/cycle display from batched poll data
 */
function updateWebhookDisplay(webhook) {
    const webhookCountEl = document.getElementById('webhook-count');
    const fetchCyclesEl = document.getElementById('fetch-cycles');
    if (webhookCountEl) webhookCountEl.textContent = webhook.webhooksReceived || 0;
    if (fetchCyclesEl) fetchCyclesEl.textContent = `${webhook.fetchCyclesCompleted || 0} fetch cycles`;
}

/**
 * Update win/lose ratio display from batched poll data
 */
function updateWinLossDisplay(stats) {
    const winsEl = document.getElementById('wins-count');
    const lossesEl = document.getElementById('losses-count');
    const winRateEl = document.getElementById('win-rate');
    
    if (winsEl) winsEl.textContent = stats.wins || 0;
    if (lossesEl) lossesEl.textContent = stats.losses || 0;
    if (winRateEl) winRateEl.textContent = stats.winRate || '0.0';
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
    if (data.models) {
        updateModelStatus(data.models);
        updateModelIntelligence(data.models);
    }
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
    const container = document.getElementById('city-coverage-container');
    if (!container) return;
    if (!hasChanged('cities', cities)) return;

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
    const container = document.getElementById('event-log-container');
    if (!container) return;
    if (!hasChanged('events', events)) return;

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
    const container = document.getElementById('detection-windows-container');
    if (!container) return;
    if (!hasChanged('windows', windows)) return;

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
    const container = document.getElementById('upcoming-runs-container');
    if (!container) return;
    if (!hasChanged('upcoming', runs)) return;

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
    // Model status will be refreshed on next poll cycle
    // Add inline event indicator for immediate feedback
    addInlineEvent('FILE_DETECTED', payload.model ? `${payload.model} file detected` : 'File detected', 'info');
}

/**
 * Handle file confirmed event
 */
function handleFileConfirmed(payload) {
    addInlineEvent('FILE_CONFIRMED', payload.model ? `${payload.model} confirmed` : 'File confirmed', 'success');
}

/**
 * Handle API data received event
 */
function handleApiDataReceived(payload) {
    addInlineEvent('API_DATA_RECEIVED', payload.cityName ? `${payload.cityName} data received` : 'API data received', 'info');
}

/**
 * Handle forecast change event
 */
function handleForecastChange(payload) {
    const msg = payload.cityName && payload.variable
        ? `${payload.cityName}: ${payload.variable} ${payload.changeAmount > 0 ? '+' : ''}${(payload.changeAmount || 0).toFixed(1)}`
        : 'Forecast changed';
    addInlineEvent('FORECAST_CHANGE', msg, payload.confidence === 'HIGH' ? 'success' : 'warning');
}

/**
 * Handle detection window start event
 */
function handleDetectionWindowStart(payload) {
    addInlineEvent('DETECTION_WINDOW_START', payload.model ? `${payload.model} detection window started` : 'Detection window started', 'info');
}

/**
 * Add an inline event to the event log without a full re-render
 */
function addInlineEvent(type, message, severity) {
    const container = document.getElementById('event-log-container');
    if (!container) return;
    // Remove "no events" placeholder
    const placeholder = container.querySelector('.text-slate-500.italic');
    if (placeholder) placeholder.remove();

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
    const div = document.createElement('div');
    div.className = `p-2 rounded border-l-2 ${severityColors[severity] || severityColors.info} mb-1 text-sm`;
    div.innerHTML = `
        <div class="flex items-center justify-between">
            <span class="font-mono text-xs text-slate-500">${formatTime(new Date())}</span>
            <span class="text-xs ${typeColors[type] || 'text-slate-400'}">${type}</span>
        </div>
        <div class="mt-1 text-slate-200">${message}</div>
    `;
    container.insertBefore(div, container.firstChild);
    // Cap at 30 visible events
    while (container.children.length > 30) {
        container.removeChild(container.lastChild);
    }
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
 * Update positions display elements
 */
function updatePositionsDisplay(activePositions, closedPositions) {
    if (!hasChanged('positions', { activePositions, closedPositions })) return;

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
            // Show the 25 most recent closed positions
            closedPositionsEl.innerHTML = closedPositions.slice(0, 25).map(pos => {
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
        // Always update - don't skip if already has value
        // This ensures HTTP polling updates override WebSocket initial data
        openPositionsEl.textContent = data.openPositions || '0';
    }

    // Update Risk Panel
    const riskCashEl = document.getElementById('risk-cash');
    const riskAllocatedEl = document.getElementById('risk-allocated');
    const riskBarEl = document.getElementById('risk-bar');
    const riskTextEl = document.getElementById('risk-text');

    if (riskCashEl) riskCashEl.textContent = `$${(data.currentCash || 0).toLocaleString()}`;
    if (riskAllocatedEl) {
        const allocated = (data.totalValue || 0) - (data.currentCash || 0);
        riskAllocatedEl.textContent = `$${allocated.toLocaleString()}`;
        
        if (riskBarEl && riskTextEl && data.totalValue > 0) {
            const percent = (allocated / data.totalValue) * 100;
            riskBarEl.style.width = `${percent}%`;
            riskTextEl.textContent = `${percent.toFixed(1)}% utilized`;
        }
    }
}


/**
 * Update status display elements
 */
function updateStatusDisplay(data) {
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
    // Initialize dashboard (WebSocket, event listeners, charts)
    initDashboard();

    // Single consolidated poll — fetch everything in one request
    fetchAllDashboardData();
    setInterval(fetchAllDashboardData, 5000);
});

// Export for global access
window.dashboard = {
    refresh: fetchAllDashboardData,
    reconnect: connectWebSocket,
};
