import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { Signale } from "signale";
import { createClient } from "redis";
import RedisStore from "connect-redis";
import session from "express-session";

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

const sessionMiddleware = session({
  store: redisStore,
  resave: config.session.resave,
  saveUninitialized: config.session.saveUninitialized,
  secret: config.session.secret,
  name: "urlate",
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

io.on("connection", async (socket) => {
  const req = socket.request;

  socket.use((__, next) => {
    req.session.reload((err: any) => {
      if (err) {
        socket.disconnect();
      } else {
        next();
      }
    });
  });

  socket.use((__, next) => {
    if (!req.session.userid) {
      socket.emit("connection:unauthorized");
    } else {
      next();
    }
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

app.post("/emit/achievement", async (req, res) => {
  const sid = await client.get(`uid:${req.body.userid}`);
  if (req.body.secret !== config.project.secretKey) {
    res.status(400).json({
      result: "failed",
      error: "Authorize failed",
      description: "Project secret key is not vaild.",
    });
    return;
  }
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
