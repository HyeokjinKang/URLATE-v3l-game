import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import signale from "signale";

const config = require(__dirname + "/../config/config.json");

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

io.on("connection", (socket) => {
  console.log(socket);
});

httpServer.listen(config.project.port, () => {
  signale.success(`Game server running at port ${config.project.port}.`);
});
