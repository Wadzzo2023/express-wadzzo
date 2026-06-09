module.exports = {
  apps: [
    {
      name: "express-bandcoin",
      script: "dist/index.js",
      cwd: "/home/ec2-user/code/express-bandcoin",
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
