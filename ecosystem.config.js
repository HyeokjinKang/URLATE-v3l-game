module.exports = {
  apps: [
    {
      name: "URLATE-v3l-game",
      script: "./dist/index.js",

      // Restarts are handled by pm2 startOrReload in the deploy workflow.
      // Enabling watch risks a restart mid-rsync copy.
      watch: false,

      // Must exceed the graceful shutdown cap (10s).
      kill_timeout: 15000,
    },
  ],
};
