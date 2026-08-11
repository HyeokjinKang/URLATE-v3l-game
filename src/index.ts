import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { Signale } from "signale";
import { createClient } from "redis";
import { RedisStore } from "connect-redis";
import session from "express-session";
import { timingSafeEqual } from "crypto";

const config = require(__dirname + "/../config/config.json");

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const options = {
  disabled: false,
  interactive: false,
  stream: process.stdout,
  types: {
    conflict: {
      badge: "⚠",
      color: "yellow",
      label: "Conflict",
      logLevel: "warning",
    },
    connect: {
      badge: "⚑",
      color: "green",
      label: "Connect",
      logLevel: "info",
    },
    disconnect: {
      badge: "⎋",
      color: "red",
      label: "Disconnect",
      logLevel: "info",
    },
  },
};

const signale = new Signale(options);

const client = createClient({
  socket: {
    host: config.redis.host,
    port: config.redis.port,
  },
  username: config.redis.username,
  password: config.redis.password,
  // 필수: 기본값(오프라인 큐)에서는 연결이 끊겨도 명령이 예외를 던지지 않고
  // 복구될 때까지 대기합니다. 세션 저장소가 이 커넥션을 쓰므로, Redis가 죽으면
  // 쿠키를 가진 모든 요청과 소켓 핸드셰이크가 응답 없이 매달립니다.
  disableOfflineQueue: true,
});

const redisStore = new RedisStore({
  client: client,
  prefix: "urlate:",
});

// production 이외의 모드에서만 secure 쿠키를 해제합니다(로컬 HTTP 개발용).
const isProduction = config.project.mode !== "test";

// 리버스 프록시(HTTPS 종단) 뒤에서 X-Forwarded-Proto를 신뢰하여
// secure 쿠키가 정상 동작하도록 합니다.
app.set("trust proxy", 1);

// 백엔드와 같은 세션 저장소를 공유하므로 쿠키 옵션도 같아야 합니다.
// 옵션을 비워 두면 express-session의 기본값이 적용되어, 같은 세션 ID가
// secure 플래그 없이 이 호스트 전용 쿠키로 다시 내려갈 수 있습니다.
// 그러면 평문 HTTP로도 전송되고 백엔드가 심은 쿠키를 가릴 수 있습니다.
const sessionMiddleware = session({
  store: redisStore,
  resave: config.session.resave ?? false,
  saveUninitialized: config.session.saveUninitialized ?? false,
  secret: config.session.secret,
  name: "urlate",
  cookie: {
    domain: config.session.domain,
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24 * 14, // 14일. 백엔드와 동일하게 맞춥니다.
  },
});

io.engine.use(sessionMiddleware);

app.disable("x-powered-by");

app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: true, limit: "64kb" }));

// Express 5는 본문 파서가 처리하지 못한 요청의 req.body를 undefined로 둡니다
// (Express 4는 {}). 라우트가 req.body.x를 곧바로 읽으므로 Content-Type 하나만
// 어긋나도 400이어야 할 응답이 TypeError로 500이 됩니다.
app.use((req, __, next) => {
  if (req.body === undefined) req.body = {};
  next();
});

app.use(sessionMiddleware);

client.on("connect", () => {
  signale.success("Connected to redis server.");
});

client.on("error", (err) => {
  signale.error(err);
});

/**
 * 인증은 핸드셰이크 단계에서 끝냅니다.
 *
 * socket.use()는 연결이 성립한 뒤 들어오는 이벤트에만 걸리는 미들웨어라,
 * connection 핸들러 본문은 그 검사보다 먼저 실행됩니다. 여기에 인증을 두면
 * 미인증 소켓이 접속 정보를 Redis에 남기고 user:online 브로드캐스트까지
 * 수신합니다.
 */
io.use((socket, next) => {
  const req = socket.request;
  if (!req.session?.userid) {
    const err = new Error("unauthorized") as Error & { data?: unknown };
    // 클라이언트가 재연결 대상이 아님을 구분할 수 있도록 코드를 실어 보냅니다.
    err.data = { code: "unauthorized" };
    next(err);
    return;
  }
  next();
});

/**
 * 접속 상태 키(uid:*, sid:*)의 만료 시간입니다.
 *
 * 정리는 disconnect 핸들러가 담당하지만, 프로세스가 비정상 종료하면 그 핸들러가
 * 돌지 않아 유령 접속 정보가 영구히 남습니다. 살아 있는 소켓은 아래 주기로
 * 연장하므로 실제 접속에는 영향이 없습니다.
 */
const PRESENCE_TTL_SEC = 60 * 60;
const PRESENCE_REFRESH_MS = (PRESENCE_TTL_SEC / 4) * 1000;

io.on("connection", async (socket) => {
  const req = socket.request;

  // 연결 중 로그아웃·세션 만료를 반영하기 위해 이벤트마다 세션을 다시 읽습니다.
  socket.use((__, next) => {
    req.session.reload((err: any) => {
      if (err || !req.session.userid) {
        socket.disconnect();
      } else {
        next();
      }
    });
  });

  const userid = req.session.userid;

  // 소켓 핸들러의 거부된 프로미스는 받아 줄 곳이 없어 unhandledRejection이
  // 됩니다. Redis 장애가 소켓 하나의 실패로 끝나도록 여기서 흡수합니다.
  try {
    const prevSid = await client.get(`uid:${userid}`);
    if (prevSid) {
      signale.conflict(`User ${userid} is already connected, disconnecting...`);
      io.to(prevSid).emit("connection:conflict");
      await client.del(`uid:${userid}`);
      await client.del(`sid:${prevSid}`);
    }
    await client.set(`uid:${userid}`, `${socket.id}`, { EX: PRESENCE_TTL_SEC });
    await client.set(`sid:${socket.id}`, `${userid}`, { EX: PRESENCE_TTL_SEC });
  } catch (err) {
    signale.error(err);
    socket.disconnect();
    return;
  }

  signale.connect(`User ${userid} connected with id ${socket.id}.`);
  io.emit("user:online", userid);

  // 접속이 유지되는 동안 만료되지 않도록 연장합니다.
  const refresh = setInterval(() => {
    Promise.all([
      client.expire(`uid:${userid}`, PRESENCE_TTL_SEC),
      client.expire(`sid:${socket.id}`, PRESENCE_TTL_SEC),
    ]).catch((err) => signale.error(err));
  }, PRESENCE_REFRESH_MS);

  socket.on("ping", async () => {
    socket.emit("pong");
  });

  socket.on("disconnect", async () => {
    clearInterval(refresh);
    try {
      const prevUid = await client.get(`sid:${socket.id}`);
      if (prevUid) {
        await client.del(`uid:${userid}`);
        await client.del(`sid:${socket.id}`);
        io.emit("user:offline", userid);
      }
    } catch (err) {
      signale.error(err);
    }
    signale.disconnect(`User ${userid} disconnected with id ${socket.id}.`);
  });
});

app.get("/", (req, res) => {
  res.send("Hello from game server!");
});

/**
 * project secret을 상수 시간에 비교합니다.
 * 일반 문자열 비교는 첫 불일치 바이트에서 끝나므로, 비교에 걸린 시간이
 * "앞에서 몇 글자가 맞았는지"를 흘립니다.
 */
const isValidSecret = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  const expected = Buffer.from(config.project.secretKey, "utf8");
  const actual = Buffer.from(value, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
};

app.post("/emit/achievement", async (req, res) => {
  // secret 검증을 Redis 조회보다 먼저 수행하여 미인증 요청의 자원 소모를 막습니다.
  if (!isValidSecret(req.body.secret)) {
    res.status(400).json({
      result: "failed",
      error: "Authorize failed",
      description: "Project secret key is not vaild.",
    });
    return;
  }
  const sid = await client.get(`uid:${req.body.userid}`);
  if (!sid) {
    res.status(400).json({
      result: "failed",
      error: "User not found",
      description: "User is not connected to game server.",
    });
    return;
  }
  io.to(sid).emit(`achievement`, JSON.stringify(req.body.achievement));
  res.status(200).json({ result: "sent" });
});

app.use((__, res) => {
  res.status(404).json({
    result: "failed",
    error: "Not Found",
    description: "Unknown endpoint.",
  });
});

// 이 핸들러가 없으면 Express 기본 핸들러가 응답 본문에 스택 트레이스를 실어
// 보냅니다(절대 경로와 의존성 버전이 그대로 노출됩니다).
// Express는 인자 4개인 미들웨어를 에러 핸들러로 인식하므로 next를 유지해야 합니다.
app.use(
  (
    err: unknown,
    __: express.Request,
    res: express.Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    next: express.NextFunction,
  ) => {
    signale.error(err);
    if (res.headersSent) return;
    // 본문 파서가 붙이는 4xx(깨진 JSON 400, 크기 초과 413)는 그대로 씁니다.
    const status = (err as { status?: number; statusCode?: number } | null)
      ?.status;
    const isClientError =
      typeof status === "number" && status >= 400 && status < 500;
    res.status(isClientError ? status : 500).json({
      result: "failed",
      error: isClientError ? "Bad Request" : "Internal Server Error",
      description: isClientError
        ? "Request could not be processed."
        : "An unexpected error occurred.",
    });
  },
);

// Node 15+는 처리되지 않은 프로미스 거부에서 프로세스를 종료합니다.
process.on("unhandledRejection", (reason) => {
  signale.error("Unhandled promise rejection:");
  signale.error(reason);
});

// uncaughtException 이후의 상태는 신뢰할 수 없어 pm2 재시작에 맡깁니다.
process.on("uncaughtException", (err) => {
  signale.fatal("Uncaught exception, shutting down:");
  signale.fatal(err);
  process.exit(1);
});

// node-redis는 무한히 재시도하므로 그대로 await하면 Redis가 죽어 있는 동안
// 포트가 아예 열리지 않습니다.
const REDIS_CONNECT_TIMEOUT_MS = 5000;

// 종료가 끝나지 않으면 강제 종료합니다. pm2의 kill_timeout보다 짧아야 합니다.
const SHUTDOWN_TIMEOUT_MS = 10000;

const closeRedis = async () => {
  try {
    // 재연결 중인 클라이언트는 isOpen이 true여도 quit()이 정착하지 않으므로
    // isReady일 때만 시도합니다.
    if (client.isReady) {
      await Promise.race([
        client.quit(),
        // unref()를 쓰면 안 됩니다. 남은 핸들이 모두 unref면 타이머가 발화하기
        // 전에 프로세스가 빠져나가 종료 절차가 중간에 끊깁니다.
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
  } catch (err) {
    signale.error(err);
  }
  try {
    if (client.isOpen) client.destroy();
  } catch {
    // 이미 닫혀 있습니다.
  }
};

const start = async () => {
  // 포트를 열기 전에 연결합니다. listen 콜백 안에서 연결하면 Redis가 준비되기
  // 전에 요청을 받게 되고, catch가 없어 실패가 unhandledRejection이 됐습니다.
  const connecting = client.connect().catch((err) => {
    signale.error("Failed to connect to redis on startup.");
    signale.error(err);
  });
  await Promise.race([
    connecting,
    new Promise<void>((resolve) =>
      setTimeout(resolve, REDIS_CONNECT_TIMEOUT_MS).unref(),
    ),
  ]);
  if (!client.isReady) {
    signale.warn("Starting without redis. Sockets fail until it recovers.");
  }

  httpServer.listen(config.project.port, () => {
    signale.success(`Game server running at port ${config.project.port}.`);
  });

  // 배포·재시작 시 연결을 정리하고 나갑니다.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    signale.pending(`Received ${signal}, shutting down...`);

    await new Promise<void>((resolve) => io.close(() => resolve()));
    await closeRedis();

    signale.success("Shutdown complete.");
    process.exit(0);
  };

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      setTimeout(() => {
        signale.error("Shutdown timed out, forcing exit.");
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS).unref();
      shutdown(signal).catch((err) => {
        signale.error(err);
        process.exit(1);
      });
    });
  }
};

start().catch((err) => {
  signale.fatal("Failed to start the server.");
  signale.fatal(err);
  process.exit(1);
});
