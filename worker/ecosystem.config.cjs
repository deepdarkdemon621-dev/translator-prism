const path = require("path");

module.exports = {
  apps: [
    {
      name: "prism-worker",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "worker/index.ts",
      cwd: path.join(__dirname, ".."),
      interpreter: "node",
      env_file: ".env.worker",
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
      out_file: "./logs/worker-out.log",
      error_file: "./logs/worker-err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
