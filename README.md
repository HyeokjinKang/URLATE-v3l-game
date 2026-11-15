## URLATE-v3l-game

Socket.IO server for [URLATE](https://github.com/HyeokjinKang/URLATE). It keeps one live connection per signed-in user, ends the older connection when the same account connects twice, and pushes achievement notices sent by the [backend](https://github.com/HyeokjinKang/URLATE-v3l-backend).

### Requirements

- Node.js 24 and pnpm 12
- Redis, shared with the backend for sessions

### Setup

```sh
pnpm install
cp config/config_example.json config/config.json
pnpm build
pnpm dev
```

`session` and `redis` in `config/config.json` must match the backend, because both servers read the same session store. `project.url` is the only origin allowed to open a socket. `project.secretKey` must match the backend's, since it authenticates `POST /emit/achievement`.

### Scripts

| Command                    | What it does                                   |
| -------------------------- | ---------------------------------------------- |
| `pnpm build`               | Compiles `src/` to `dist/`                     |
| `pnpm dev`                 | Runs `dist/index.js` and restarts it on change |
| `pnpm start` / `pnpm stop` | Starts or stops the server with pm2            |
| `pnpm lint`                | Runs eslint                                    |
| `pnpm format:check`        | Checks formatting with prettier                |

### Deployment

The `Build and Deploy` workflow is started by hand. It builds the project, copies it to the server with rsync, and reloads it with pm2.
