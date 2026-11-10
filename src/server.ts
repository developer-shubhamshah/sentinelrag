import { pathToFileURL } from "node:url";
import { argv } from "node:process";
import Fastify from "fastify";
import { z } from "zod";
import { runRouted } from "./router/route.js";
import { Answer as AnswerSchema } from "./schema.js";
import { Trace } from "./obs/trace.js";
import { closePool, dbReady } from "./db.js";

const AskBody = z.object({ query: z.string().min(1) });

export function buildServer() {
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({ ok: true }));

  app.post("/ask", async (req, reply) => {
    const parsed = AskBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Body must be { query: string }" };
    }
    const { query } = parsed.data;
    const trace = new Trace(query);

    const { answer, decision } = await runRouted(query, trace);
    const valid = AnswerSchema.parse(answer); // DoD: every response is a Zod-valid Answer

    // The decision log IS the "when to use what" evidence.
    const summary = trace.summary({ chosen: decision.chosen, reason: decision.reason });
    req.log.info({ query, ...summary }, "routed");

    return { answer: valid, decision, trace: summary };
  });

  return app;
}

async function main(): Promise<void> {
  await dbReady;
  const app = buildServer();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: "0.0.0.0" });

  const shutdown = async () => {
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Only start listening when run as the entrypoint — not when imported (tests).
const isEntrypoint = argv[1] ? import.meta.url === pathToFileURL(argv[1]).href : false;
if (isEntrypoint) {
  main().catch((err) => {
    console.error("server failed to start:", err);
    process.exit(1);
  });
}
