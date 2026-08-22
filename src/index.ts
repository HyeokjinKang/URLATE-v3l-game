import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { Signale } from "signale";
import { createClient } from "redis";
import { RedisStore } from "connect-redis";
import session from "express-session";
import { timingSafeEqual } from "crypto";

// config.json differs per deployment, so it isn't a static import target.
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
  // Required: with the default (offline queue), a dropped connection makes
  // commands wait for recovery instead of throwing. The session store uses
  // this same connection, so if Redis goes down, every cookie-bearing
  // request and socket handshake would hang with no response.
  disableOfflineQueue: true,
});

const redisStore = new RedisStore({
  client: client,
  prefix: "urlate:",
});

// secure cookies are disabled only outside production mode (for local HTTP development).
const isProduction = config.project.mode !== "test";

// Trusts X-Forwarded-Proto from the reverse proxy (which terminates HTTPS),
// so secure cookies work correctly.
app.set("trust proxy", 1);

// Shares the same session store as the backend, so the cookie options must
// match. Leaving them unset would fall back to express-session's defaults,
// which could re-issue the same session ID as a host-only cookie without
// the secure flag -- sent over plain HTTP, and potentially masking the
// cookie the backend set.
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

// Express 5 leaves req.body undefined when the body parser can't handle a
// request (Express 4 used {}). Routes read req.body.x directly, so a single
// mismatched Content-Type would turn what should be a 400 into a TypeError-driven 500.
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
 * Authentication is finished at the handshake stage.
 *
 * socket.use() only middlewares events arriving after a connection is
 * already established, so the connection handler body would run before
 * that check. Putting auth there would let an unauthenticated socket write
 * presence info to Redis and even receive the user:online broadcast.
 */
io.use((socket, next) => {
  const req = socket.request;
  if (!req.session?.userid) {
    const err = new Error("unauthorized") as Error & { data?: unknown };
    // Carries a code so the client can tell this isn't worth reconnecting for.
    err.data = { code: "unauthorized" };
    next(err);
    return;
  }
  next();
});

/**
 * Expiry for the presence keys (uid:*, sid:*).
 *
 * Cleanup is normally the disconnect handler's job, but if the process dies
 * abnormally that handler never runs, leaving stale presence info behind
 * permanently. Live sockets renew this on the interval below, so it doesn't
 * affect an actual connection.
 */
const PRESENCE_TTL_SEC = 60 * 60;
const PRESENCE_REFRESH_MS = (PRESENCE_TTL_SEC / 4) * 1000;

io.on("connection", async (socket) => {
  const req = socket.request;

  // Reloads the session on every event to reflect a logout or expiry that
  // happened mid-connection.
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

  // Reverts the presence entries and timer this connection registered.
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

  // Must be registered before the await below. If the connection drops during
  // a Redis round trip, disconnect would fire in that window, and a handler
  // registered afterward would never get called -- leaving the timer behind
  // to keep renewing a dead socket's TTL forever.
  socket.on("disconnect", async () => {
    await releasePresence();
    signale.disconnect(`User ${userid} disconnected with id ${socket.id}.`);
  });

  socket.on("ping", async () => {
    socket.emit("pong");
  });

  // A rejected promise in a socket handler has no caller to catch it and
  // becomes an unhandledRejection. Absorbed here so a Redis failure only
  // takes down this one socket.
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

  // If the connection dropped during the round trip above, the disconnect
  // handler has already run and passed. Revert the presence entries just
  // written and stop here.
  if (!socket.connected) {
    await releasePresence();
    return;
  }

  signale.connect(`User ${userid} connected with id ${socket.id}.`);
  io.emit("user:online", userid);
  announced = true;

  // Renews the TTL so it doesn't expire while the connection is alive.
  // Checks the socket itself and stops if it's dead. The disconnect handler
  // above normally handles cleanup, but any await between here and there
  // could let it run first. Having the timer verify its own condition means
  // that ordering doesn't turn into a leak.
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

/**
 * Compares the project secret in constant time.
 * A plain string comparison short-circuits at the first mismatched byte,
 * leaking how many leading characters matched through timing.
 */
const isValidSecret = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  const expected = Buffer.from(config.project.secretKey, "utf8");
  const actual = Buffer.from(value, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
};

app.post("/emit/achievement", async (req, res) => {
  // Validates the secret before the Redis lookup, so an unauthenticated
  // request doesn't spend resources.
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

// Without this handler, Express's default handler would put a stack trace in
// the response body (exposing absolute paths and dependency versions as-is).
// Express identifies an error handler by its 4-argument signature, so next must stay.
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
    // Preserves the 4xx that the body parser attaches (malformed JSON 400, oversized body 413).
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

// Node 15+ terminates the process on an unhandled promise rejection.
process.on("unhandledRejection", (reason) => {
  signale.error("Unhandled promise rejection:");
  signale.error(reason);
});

// State after uncaughtException can't be trusted, so let pm2 restart the process.
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
  // Connects before opening the port. Connecting inside the listen callback
  // would accept requests before Redis is ready, and an uncaught failure
  // there would only surface as an unhandledRejection.
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

  // Defaults to loopback since a reverse proxy sits in front. Binding to a
  // wildcard address would expose the port directly, regardless of firewall
  // policy.
  const host = config.project.host ?? "127.0.0.1";
  httpServer.listen(config.project.port, host, () => {
    signale.success(`Game server running at ${host}:${config.project.port}.`);
  });

  // Cleans up connections and exits on deploy/restart.
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
