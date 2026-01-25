module.exports = {
    apps: [{
        name: "weather-racing",
        // Run the compiled web server
        script: "dist/web/server.js",
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
