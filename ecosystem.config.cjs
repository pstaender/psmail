// pm2 process definition for P.S.Mail (https://pm2.keymetrics.io).
//
//   pm2 start ecosystem.config.cjs           # start (production settings)
//   pm2 restart psmail / pm2 stop psmail     # manage it
//   pm2 logs psmail                          # tail its output
//   pm2 save && pm2 startup                  # keep it running across reboots
//
// .cjs (not .js) on purpose: package.json has "type": "module", and pm2 loads this file with
// require(), which needs plain CommonJS.
//
// The server itself is a single Bun process (Bun.serve, one bun:sqlite database file) — there is
// no cluster mode here, and running more than one instance against the same database is not
// supported. Its port and other settings come from its own settings.json (see README.md's
// Configuration section), not from environment variables here.
module.exports = {
  apps: [
    {
      name: "psmail",
      script: "src/server/main.ts",
      interpreter: "bun",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
      },
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      // The database and attachments live outside the repo (see getConfigDir in
      // src/server/config/paths.ts) — nothing here needs to trigger a restart.
      watch: false,
      max_memory_restart: "512M",
      min_uptime: "10s",
      max_restarts: 10,
      restart_delay: 3000,
      time: true,
      merge_logs: true,
      out_file: "logs/psmail-out.log",
      error_file: "logs/psmail-error.log",
    },
  ],
};
