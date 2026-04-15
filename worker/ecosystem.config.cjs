module.exports = {
  apps: [
    {
      name: "prism-worker",
      script: "tsx",
      args: "worker/index.ts",
      cwd: __dirname + "/..",
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
