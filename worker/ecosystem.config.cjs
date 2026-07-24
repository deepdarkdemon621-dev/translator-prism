const path = require("path");

module.exports = {
  apps: [
    {
      name: "prism-worker",
      script: "worker/index.ts",
      cwd: path.join(__dirname, ".."),
      interpreter: "node",
      node_args: "--import tsx",
      env_file: ".env.worker",
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
      shutdown_with_message: true,
      // Batch CLI calls can run for several minutes. Give SIGINT shutdown
      // enough time to finish the in-flight batch and release/commit leases.
      kill_timeout: 600000,
      out_file: "./logs/worker-out.log",
      error_file: "./logs/worker-err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
