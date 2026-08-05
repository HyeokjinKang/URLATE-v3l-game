module.exports = {
  apps: [
    {
      name: "URLATE-v3l-game",
      script: "./dist/index.js",

      // 재시작은 배포 워크플로가 pm2 startOrReload로 명시적으로 수행합니다
      // (.github/workflows/deploy.yml). watch는 켜지 않습니다.
      //
      // watch에 재시작을 맡기면 rsync가 파일을 순차 복사하는 도중 재시작이
      // 걸려 반쯤 복사된 트리로 기동할 수 있습니다.
      watch: false,
    },
  ],
};
