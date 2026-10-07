import type { FastifyReply, FastifyRequest } from "fastify";
import type { Turn } from "../tutor/turn.js";

/** Generating a reply is the expensive call: cap it per client in addition to the global limit. */
export const GENERATION_RATE_LIMIT = { max: 20, timeWindow: "1 minute" } as const;

/**
 * Streams a Turn as Server-Sent Events. Everything that can fail with a status code (auth,
 * validation, ownership, busy) has already run, so the response is always a 200 stream.
 */
export async function streamTurn(req: FastifyRequest, reply: FastifyReply, turn: Turn): Promise<void> {
  const abort = new AbortController();
  const raw = reply.raw;
  try {
    reply.hijack();
    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    });
    raw.flushHeaders();
    // If the browser disconnects mid-reply, stop the provider call; the student's message stays saved.
    raw.on("close", () => {
      if (!raw.writableEnded) abort.abort();
    });
    for await (const event of turn.events(abort.signal)) {
      raw.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } catch (err) {
    req.log.error(err, "stream failed");
    if (!raw.writableEnded) {
      raw.write(
        `data: ${JSON.stringify({ type: "error", code: "internal", message: "Something went wrong while answering. Please try again.", retryable: true })}\n\n`,
      );
    }
  } finally {
    turn.release();
    if (!raw.writableEnded) raw.end();
  }
}
