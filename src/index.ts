import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { Signale } from "signale";
import { createClient } from "redis";
import { RedisStore } from "connect-redis";
import session from "express-session";
import { timingSafeEqual } from "crypto";

// eslint-disable-next-line @typescript-eslint/no-require-imports
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
  // Without this, commands queue instead of throwing while disconnected, and
  // every cookie-bearing request and socket handshake hangs until Redis returns.
  disableOfflineQueue: true,
});

const redisStore = new RedisStore({
  client: client,
  prefix: "urlate:",
});

const isProduction = config.project.mode !== "test";

app.set("trust proxy", 1);

// Must match the backend's cookie options: they share a session store, and
// express-session's defaults would re-issue the session ID as an insecure
// host-only cookie that masks the backend's.
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
    maxAge: 1000 * 60 * 60 * 24 * 14, // 14 days, matching the backend.
  },
});

io.engine.use(sessionMiddleware);

app.disable("x-powered-by");

app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: true, limit: "64kb" }));

// Express 5 leaves req.body undefined when the parser can't handle a request
// (Express 4 used {}), turning what should be a 400 into a TypeError 500.
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

// Authenticates at the handshake. socket.use() only covers events after the
// connection is established, so auth there would let an unauthenticated socket
// write presence to Redis and receive the user:online broadcast first.
io.use((socket, next) => {
  const req = socket.request;
  if (!req.session?.userid) {
    const err = new Error("unauthorized") as Error & { data?: unknown };
    err.data = { code: "unauthorized" };
    next(err);
    return;
  }
  next();
});

// Expiry for the presence keys (uid:*, sid:*). The disconnect handler normally
// clears them, but an abnormal exit would leave them behind forever. Live
// sockets renew on the interval below.
const PRESENCE_TTL_SEC = 60 * 60;
const PRESENCE_REFRESH_MS = (PRESENCE_TTL_SEC / 4) * 1000;

io.on("connection", async (socket) => {
  const req = socket.request;

  socket.use((__, next) => {
    req.session.reload((err: unknown) => {
      if (err || !req.session.userid) {
        socket.disconnect();
      } else {
        next();
      }
    });
  });

  const userid = req.session.userid;

  let refresh: NodeJS.Timeout | undefined;
  let announced = false;

  const releasePresence = async () => {
    if (refresh) {
      clearInterval(refresh);
      refresh = undefined;
    }
    try {
      // If another socket has already taken over this slot, don't clear its entry.
      if ((await client.get(`uid:${userid}`)) === socket.id) {
        await client.del(`uid:${userid}`);
      }
      if (await client.get(`sid:${socket.id}`)) {
        await client.del(`sid:${socket.id}`);
        if (announced) io.emit("user:offline", userid);
      }
    } catch (err) {
      signale.error(err);
    }
  };

  // Registered before the await below: a drop during the Redis round trip fires
  // disconnect in that window, and a later handler would never run, leaving the
  // timer renewing a dead socket's TTL forever.
  socket.on("disconnect", async () => {
    await releasePresence();
    signale.disconnect(`User ${userid} disconnected with id ${socket.id}.`);
  });

  socket.on("ping", async () => {
    socket.emit("pong");
  });

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

  // Dropped during the round trip above means disconnect already ran; revert
  // what was just written.
  if (!socket.connected) {
    await releasePresence();
    return;
  }

  signale.connect(`User ${userid} connected with id ${socket.id}.`);
  io.emit("user:online", userid);
  announced = true;

  // Renews the TTL while the connection is alive. Checks the socket itself
  // rather than trusting the disconnect handler above, which any await between
  // here and there could let run first.
  refresh = setInterval(() => {
    if (!socket.connected) {
      void releasePresence();
      return;
    }
    Promise.all([
      client.expire(`uid:${userid}`, PRESENCE_TTL_SEC),
      client.expire(`sid:${socket.id}`, PRESENCE_TTL_SEC),
    ]).catch((err) => signale.error(err));
  }, PRESENCE_REFRESH_MS);
});

app.get("/", (req, res) => {
  res.send("Hello from game server!");
});

const isValidSecret = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  const expected = Buffer.from(config.project.secretKey, "utf8");
  const actual = Buffer.from(value, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
};

app.post("/emit/achievement", async (req, res) => {
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

// Without this, Express's default handler puts a stack trace in the response
// body. Express identifies an error handler by its 4-argument signature, so
// next must stay.
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

process.on("unhandledRejection", (reason) => {
  signale.error("Unhandled promise rejection:");
  signale.error(reason);
});

process.on("uncaughtException", (err) => {
  signale.fatal("Uncaught exception, shutting down:");
  signale.fatal(err);
  process.exit(1);
});

// node-redis retries forever, so awaiting it directly would keep the port
// from ever opening while Redis is down.
const REDIS_CONNECT_TIMEOUT_MS = 5000;

// Force exit if shutdown doesn't finish in time; must be shorter than pm2's kill_timeout.
const SHUTDOWN_TIMEOUT_MS = 10000;

const closeRedis = async () => {
  try {
    // A reconnecting client can have isOpen true but never settle quit(), so
    // only attempt it when isReady.
    if (client.isReady) {
      await Promise.race([
        client.quit(),
        // Don't use unref() here -- if every remaining handle is unref'd, the
        // process could exit before this timer fires, cutting shutdown short.
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
  } catch (err) {
    signale.error(err);
  }
  try {
    if (client.isOpen) client.destroy();
  } catch {
    // Already closed.
  }
};

const start = async () => {
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

  // Loopback by default since a reverse proxy sits in front; a wildcard bind
  // would expose the port directly regardless of firewall policy.
  const host = config.project.host ?? "127.0.0.1";
  httpServer.listen(config.project.port, host, () => {
    signale.success(`Game server running at ${host}:${config.project.port}.`);
  });

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
