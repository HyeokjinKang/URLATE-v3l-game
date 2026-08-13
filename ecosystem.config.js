module.exports = {
  apps: [
    {
      name: "URLATE-v3l-game",
      script: "./dist/index.js",

      // 재시작은 배포 워크플로의 pm2 startOrReload가 담당합니다.
      // watch를 켜면 rsync 복사 도중 재시작이 걸릴 수 있습니다.
      watch: false,

      // graceful shutdown 상한(10초)보다 넉넉해야 합니다.
      kill_timeout: 15000,
    },
  ],
};
