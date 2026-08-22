declare module "http" {
  interface IncomingMessage {
    session?: Express.Session;
  }
}
