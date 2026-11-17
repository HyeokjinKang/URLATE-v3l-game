import { randomUUID } from "crypto";
import type { Socket } from "socket.io";
import type { createClient } from "redis";
import type { Signale } from "signale";

type RedisClient = ReturnType<typeof createClient>;

/** Must match the backend, which reads these hashes when a record is submitted. */
const PLAY_KEY = (playId: string) => `play:${playId}`;

const PLAY_TTL_SEC = 3 * 60 * 60;

const FILE_NAME = /^[A-Za-z0-9_-]{1,255}$/;

const MIN_RATE = 0.5;
const MAX_RATE = 2;

type Ack = (response: { ok: boolean; playId?: string }) => void;

const toAck = (value: unknown): Ack =>
  typeof value === "function" ? (value as Ack) : () => {};

const parseStart = (data: unknown) => {
  if (!data || typeof data !== "object") return null;
  const { fileName, difficultySelection, rate } = data as Record<
    string,
    unknown
  >;
  if (typeof fileName !== "string" || !FILE_NAME.test(fileName)) return null;
  if (
    typeof difficultySelection !== "number" ||
    !Number.isInteger(difficultySelection) ||
    difficultySelection < 1 ||
    difficultySelection > 16
  ) {
    return null;
  }
  if (
    typeof rate !== "number" ||
    !Number.isFinite(rate) ||
    rate < MIN_RATE ||
    rate > MAX_RATE
  ) {
    return null;
  }
  return { fileName, difficultySelection, rate };
};

const playIdOf = (data: unknown): string | null => {
  const playId = (data as { playId?: unknown } | null)?.playId;
  return typeof playId === "string" ? playId : null;
};

/**
 * Tracks one play per socket in Redis with server timestamps: start, pauses,
 * end and disconnects. The backend compares these with the submitted record.
 */
export const registerPlaySession = (
  socket: Socket,
  userid: string,
  client: RedisClient,
  signale: Signale,
) => {
  let active: string | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const serial = (task: () => Promise<void>) => {
    queue = queue.then(task).catch((err) => signale.error(err));
    return queue;
  };

  const closePause = async (key: string, now: number) => {
    const pausedAt = Number(await client.hGet(key, "pausedAt"));
    if (!pausedAt) return;
    await client.hIncrBy(key, "pausedMs", Math.max(now - pausedAt, 0));
    await client.hDel(key, "pausedAt");
  };

  const startPlay = async (
    play: NonNullable<ReturnType<typeof parseStart>>,
    reply: Ack,
  ) => {
    const now = Date.now();
    if (active) await client.hSet(PLAY_KEY(active), "abandonedAt", now);
    const playId = randomUUID();
    const key = PLAY_KEY(playId);
    await client.hSet(key, {
      userid,
      fileName: play.fileName,
      difficultySelection: play.difficultySelection,
      rate: play.rate,
      startedAt: now,
      pausedMs: 0,
      pauses: 0,
    });
    await client.expire(key, PLAY_TTL_SEC);
    active = playId;
    reply({ ok: true, playId });
  };

  socket.on("play:start", (data: unknown, ack: unknown) => {
    const reply = toAck(ack);
    const play = parseStart(data);
    if (!play) {
      reply({ ok: false });
      return;
    }
    void serial(async () => {
      try {
        await startPlay(play, reply);
      } catch (err) {
        signale.error(err);
        reply({ ok: false });
      }
    });
  });

  socket.on("play:pause", (data: unknown) => {
    const playId = playIdOf(data);
    if (!playId || playId !== active) return;
    void serial(async () => {
      const key = PLAY_KEY(playId);
      if (await client.hExists(key, "pausedAt")) return;
      await client.hSet(key, "pausedAt", Date.now());
      await client.hIncrBy(key, "pauses", 1);
    });
  });

  socket.on("play:resume", (data: unknown) => {
    const playId = playIdOf(data);
    if (!playId || playId !== active) return;
    void serial(() => closePause(PLAY_KEY(playId), Date.now()));
  });

  socket.on("play:end", (data: unknown, ack: unknown) => {
    const reply = toAck(ack);
    const playId = playIdOf(data);
    if (!playId || playId !== active) {
      reply({ ok: false });
      return;
    }
    void serial(async () => {
      try {
        const now = Date.now();
        const key = PLAY_KEY(playId);
        await closePause(key, now);
        await client.hSet(key, "endedAt", now);
        active = null;
        reply({ ok: true });
      } catch (err) {
        signale.error(err);
        reply({ ok: false });
      }
    });
  });

  socket.on("disconnect", () => {
    const playId = active;
    if (!playId) return;
    active = null;
    void serial(async () => {
      await client.hSet(PLAY_KEY(playId), "interruptedAt", Date.now());
    });
  });
};
