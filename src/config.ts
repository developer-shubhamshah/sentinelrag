import "dotenv/config";
import { z } from "zod";

/**
 * Known embedding models -> output dimension.
 * Verified against provider docs:
 *   - OpenAI text-embedding-3-small = 1536, -3-large = 3072
 *   - Voyage voyage-3 = 1024
 * The DB column vector(N) and every stored embedding must match the active model.
 */
const EMBED_DIMS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "voyage-3": 1024,
  "voyage-3-lite": 512,
};

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // Claude: generation + judge only (never embeddings).
  ANTHROPIC_API_KEY: z.string().optional(),
  GEN_MODEL: z.string().default("claude-opus-5-5"),
  JUDGE_MODEL: z.string().default("claude-haiku-5-5"),
  ROUTER_MODEL: z.string().default("claude-haiku-5-5"),

  // Embeddings
  EMBED_PROVIDER: z.enum(["openai", "voyage"]).default("openai"),
  EMBED_MODEL: z.string().default("text-embedding-3-small"),
  OPENAI_API_KEY: z.string().optional(),
  VOYAGE_API_KEY: z.string().optional(),

  // Ingestion
  NVD_API_KEY: z.string().optional(),
  CVE_YEAR: z.coerce.number().int().min(1999).max(2100).default(2024),

  // Optional reranker (stretch)
  COHERE_API_KEY: z.string().optional(),

  // HTTP hardening (§9) — rate limiting + CORS, values from .env.
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60), // per-IP, per window
  RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().default(600), // all clients combined
  RATE_LIMIT_WINDOW: z.string().default("1 minute"), // "1 minute" | ms
  CORS_ORIGINS: z.string().default(""), // comma-separated; empty => cross-origin disabled
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment (.env):\n${issues}`);
}

export const config = parsed.data;

/** Allowed CORS origins from CORS_ORIGINS (comma-separated). Empty => disabled. */
export const corsOrigins: string[] = config.CORS_ORIGINS
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Embedding dimension for the active model. Single exported constant. */
export const EMBED_DIM: number = (() => {
  const dim = EMBED_DIMS[config.EMBED_MODEL];
  if (!dim) {
    throw new Error(
      `Unknown embedding model "${config.EMBED_MODEL}". Add it to EMBED_DIMS in src/config.ts with its verified dimension.`,
    );
  }
  return dim;
})();

/** Narrow helpers that fail loudly only when a feature actually needs the key. */
export function requireAnthropicKey(): string {
  if (!config.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required for generation/judge calls.");
  }
  return config.ANTHROPIC_API_KEY;
}

export function requireEmbeddingKey(): string {
  if (config.EMBED_PROVIDER === "openai") {
    if (!config.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required when EMBED_PROVIDER=openai.");
    }
    return config.OPENAI_API_KEY;
  }
  if (!config.VOYAGE_API_KEY) {
    throw new Error("VOYAGE_API_KEY is required when EMBED_PROVIDER=voyage.");
  }
  return config.VOYAGE_API_KEY;
}
