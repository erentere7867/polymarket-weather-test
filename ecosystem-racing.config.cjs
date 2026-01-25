module.exports = {
    apps: [{
        name: "weather-racing",
        // Run the web server to enable dashboard & reverse proxy support
        script: "npx",
        args: "tsx src/web/server.ts",
        interpreter: "none",
        instances: 1,
        autorestart: true,
        watch: false,
        max_memory_restart: "1G",
        env: {
            NODE_ENV: "production",
            LOG_LEVEL: "info",
            // Port 8035 for the racing instance (separate from 8034)
            PORT: 8035,
            SIMULATION_MODE: "true"
        }
    }]
}
