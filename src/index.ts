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

  if (!req.session.userid) return socket.disconnect();

  const userid = req.session.userid;
  const id = await client.get(userid);

  if (id) {
    signale.conflict(`User ${userid} is already connected, disconnecting...`);
    io.to(id).emit("connection:conflict");
    await client.del(id);
    await client.del(userid);
  }

  signale.connect(`User ${userid} connected with id ${socket.id}.`);
  await client.set(`${userid}`, `${socket.id}`);
  await client.set(`${socket.id}`, `${userid}`);
  io.emit("user:online", userid);

  socket.on("disconnect", async () => {
    signale.disconnect(`User ${userid} disconnected with id ${socket.id}.`);
    await client.del(`${userid}`);
    await client.del(`${socket.id}`);
  });
});

app.get("/", (req, res) => {
  res.send("Hello from game server!");
});

httpServer.listen(config.project.port, () => {
  signale.success(`Game server running at port ${config.project.port}.`);
  client.connect();
});
