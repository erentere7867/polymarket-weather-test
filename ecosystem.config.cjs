
module.exports = {
    apps: [{
        name: "polymarket-speed-bot",
        script: "npx",
        args: "tsx src/web/server.ts",
        interpreter: "none", // Let npx handle execution
        instances: 1,
        autorestart: true,
        watch: false,
        max_memory_restart: "1G",
        env: {
            NODE_ENV: "production",
            LOG_LEVEL: "info"
        }
    }]
}
