-- Dense ANN index (HNSW; cosine distance -> pairs with the <=> operator).
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw
  ON chunks USING hnsw (embedding vector_cosine_ops);

-- Keyword index for full-text search.
CREATE INDEX IF NOT EXISTS chunks_tsv_gin
  ON chunks USING gin (tsv);

-- Exact-ID lookups for the deterministic path.
CREATE INDEX IF NOT EXISTS documents_ext_id
  ON documents (ext_id);

-- Join support.
CREATE INDEX IF NOT EXISTS chunks_document_id
  ON chunks (document_id);
