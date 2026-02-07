/**
 * PM2 Ecosystem Configuration
 * 
 * This configuration runs the consolidated Speed Bot + Dashboard application.
 * 
 * polymarket-weather-web:
 * - Runs the SpeedArbitrageStrategy (SimulationRunner)
 * - HOSTS the Web Dashboard (port 8188)
 * - Handles Webhooks
 * 
 * To start: pm2 start ecosystem.config.cjs
 * To view logs: pm2 logs
 * To monitor: pm2 monit
 */
module.exports = {
    apps: [
        {
            name: "polymarket-weather-web",
            script: "dist/web/server.js",
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: "1G",
            env: {
                NODE_ENV: "production",
                DASHBOARD_PORT: 8034,
                LOG_LEVEL: "info",
                PATH: "/usr/local/bin:/usr/bin:/bin"
            }
        }
    ]
}