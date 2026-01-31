/**
 * PM2 Ecosystem Configuration
 * 
 * This configuration runs two separate applications:
 * 
 * 1. polymarket-weather-bot: The main trading bot that handles:
 *    - Market scanning and opportunity detection
 *    - Weather data fetching and analysis
 *    - Trading logic and order execution
 *    - Portfolio management
 * 
 * 2. polymarket-weather-web: The web server that handles:
 *    - Tomorrow.io webhook endpoint for real-time forecast updates
 *    - Dashboard API for monitoring bot status
 *    - Portfolio and position endpoints
 *    - Static dashboard UI
 * 
 * BOTH apps need to be running for full functionality:
 * - The bot alone can trade but won't receive webhook-based forecast updates
 * - The web server alone can receive webhooks but won't execute trades
 * 
 * To start both apps: pm2 start ecosystem.config.cjs
 * To view logs: pm2 logs
 * To monitor: pm2 monit
 */
module.exports = {
    apps: [
        {
            name: "polymarket-weather-bot",
            script: "dist/index.js",
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: "1G",
            env: {
                NODE_ENV: "production",
                LOG_LEVEL: "info",
                SIMULATION_MODE: "true"
            }
        },
        {
            name: "polymarket-weather-web",
            script: "dist/web/server.js",
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: "512M",
            env: {
                NODE_ENV: "production",
                PORT: 8188,
                LOG_LEVEL: "info"
            }
        }
    ]
}
