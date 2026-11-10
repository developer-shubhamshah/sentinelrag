-- SentinelRAG schema
-- Embedding dimension 1536 = OpenAI text-embedding-3-small (verified from provider docs).
-- Keep this in sync with EMBED_DIM in src/config.ts.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (
  id        BIGSERIAL PRIMARY KEY,
  source    TEXT NOT NULL,                  -- 'nvd' | 'attack'
  ext_id    TEXT NOT NULL,                  -- e.g. 'CVE-2024-1234' or 'T1059'
  title     TEXT,
  metadata  JSONB NOT NULL DEFAULT '{}',
  UNIQUE (source, ext_id)
);

CREATE TABLE IF NOT EXISTS chunks (
  id           BIGSERIAL PRIMARY KEY,
  document_id  BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  content      TEXT NOT NULL,
  embedding    vector(1536),               -- match EMBED_DIM
  metadata     JSONB NOT NULL DEFAULT '{}',
  tsv          tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);
