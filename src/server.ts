import { pathToFileURL } from "node:url";
import { argv } from "node:process";
import Fastify, { type FastifyReply } from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { runRouted } from "./router/route.js";
import { Answer as AnswerSchema } from "./schema.js";
import { Trace } from "./obs/trace.js";
import { closePool, dbReady } from "./db.js";
import { config, corsOrigins } from "./config.js";

/**
 * Request schemas — validated at every route boundary (OWASP 2025 A06 Insecure
 * Design; complements the Zod run on the Answer OUTPUT). `.strict()` rejects
 * unknown keys, so stray body fields or smuggled query params are 400s rather
 * than being silently ignored. The max length bounds prompt size (abuse/cost).
 */
const AskBody = z.object({ query: z.string().min(1).max(4000) }).strict();
const AskQuery = z.object({}).strict(); // POST /ask takes no query params
const HealthQuery = z.object({}).strict(); // GET /health takes no query params

/** Format a ZodError into a compact 400 response body. */
function badRequest(reply: FastifyReply, where: string, err: z.ZodError): FastifyReply {
  return reply.code(400).send({
    error: `Invalid request ${where}`,
    issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  });
}

export async function buildServer() {
  const app = Fastify({ logger: true });

  // Security headers (helmet defaults: HSTS, X-Content-Type-Options, frameguard,
  // CSP, etc.). OWASP 2025 A02 Security Misconfiguration.
  await app.register(helmet);

  // CORS locked to .env origins. No frontend yet => empty list disables
  // cross-origin entirely (documented N/A in SECURITY.md).
  await app.register(cors, {
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    methods: ["GET", "POST"],
  });

  // Tier 1 — per-IP limit (default keyGenerator uses request.ip), all routes.
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
  });

  // Tier 2 — global cap across ALL clients (one shared bucket via a constant
  // key). Protects LLM spend, not just per-IP abuse. OWASP 2025 A06.
  const globalLimiter = app.createRateLimit({
    keyGenerator: () => "global",
    max: config.RATE_LIMIT_GLOBAL_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
  });
  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health") return; // don't let LB probes trip the global cap
    const res = await globalLimiter(req);
    // `isAllowed` here means "allow-listed / exempt" — NOT "permitted". The real
    // breach flags are isExceeded / isBanned (present only on the non-exempt branch).
    if (!res.isAllowed && (res.isExceeded || res.isBanned)) {
      reply.header("retry-after", res.ttlInSeconds);
      reply.code(429);
      return reply.send({ error: "Global rate limit exceeded; retry later." });
    }
  });

  // Health check is exempt from the per-IP limiter too (LB probes).
  app.get("/health", { config: { rateLimit: false } }, async (req, reply) => {
    const q = HealthQuery.safeParse(req.query);
    if (!q.success) return badRequest(reply, "query parameters", q.error);
    return { ok: true };
  });

  app.post("/ask", async (req, reply) => {
    const q = AskQuery.safeParse(req.query);
    if (!q.success) return badRequest(reply, "query parameters", q.error);
    const b = AskBody.safeParse(req.body);
    if (!b.success) return badRequest(reply, "body", b.error);

    const { query } = b.data;
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
  const app = await buildServer();
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
