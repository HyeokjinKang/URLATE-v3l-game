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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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
  const prevSid = await client.get(`uid:${userid}`);

  if (prevSid) {
    signale.conflict(`User ${userid} is already connected, disconnecting...`);
    io.to(prevSid).emit("connection:conflict");
    await client.del(`uid:${userid}`);
    await client.del(`sid:${prevSid}`);
  }

  signale.connect(`User ${userid} connected with id ${socket.id}.`);
  await client.set(`uid:${userid}`, `${socket.id}`);
  await client.set(`sid:${socket.id}`, `${userid}`);
  io.emit("user:online", userid);

  socket.on("ping", async () => {
    socket.emit("pong");
  });

  socket.on("disconnect", async () => {
    const prevUid = await client.get(`sid:${socket.id}`);
    if (prevUid) {
      await client.del(`uid:${userid}`);
      await client.del(`sid:${socket.id}`);
      io.emit("user:offline", userid);
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

httpServer.listen(config.project.port, () => {
  signale.success(`Game server running at port ${config.project.port}.`);
  client.connect();
});
