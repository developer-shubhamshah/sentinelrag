-- 003_roles.sql — least-privilege Postgres roles for SentinelRAG.
--
-- Two roles, because the runtime API and the ingestion batch need different
-- privileges. Granting only what each query actually issues (audited in src/)
-- is the OWASP 2025 A01 (Broken Access Control) control at the database layer.
--
-- This file is the canonical, runnable version (apply with psql). The
-- CloudFormation template (infra/cloudformation.yaml) applies the SAME grants on
-- deploy via a custom resource — keep the two in sync.
--
-- Apply AFTER 001_schema.sql has created `documents` and `chunks`.

-- ─── Service (API) role: READ-ONLY ──────────────────────────────────────────
-- The HTTP service only ever runs SELECTs (src/strategies/*, src/retrieval/*,
-- src/db.ts). It never writes, so it gets SELECT and nothing else.
-- NOLOGIN here because on RDS the role authenticates via IAM (rds_iam), not a
-- password — see the scoped rds-db:connect grant in the CloudFormation template.
CREATE ROLE sentinel_api NOLOGIN;
GRANT CONNECT ON DATABASE sentinel TO sentinel_api;
GRANT USAGE  ON SCHEMA public       TO sentinel_api;
GRANT SELECT ON documents, chunks   TO sentinel_api;
-- Explicitly NOT granted: INSERT, UPDATE, DELETE, TRUNCATE, or any DDL.
-- (On RDS, also: GRANT rds_iam TO sentinel_api;  -- enables IAM DB auth)

-- ─── Ingestion role: READ + WRITE (no DDL) ──────────────────────────────────
-- The ingestion batch (src/ingest/run.ts) needs more than SELECT/INSERT:
--   • documents: INSERT ... ON CONFLICT DO UPDATE   → INSERT + UPDATE
--   • chunks:    DELETE FROM chunks WHERE ...        → DELETE (clean re-ingest)
--   • chunks:    INSERT INTO chunks ...              → INSERT
-- So the honest minimum is SELECT/INSERT/UPDATE on documents and
-- SELECT/INSERT/DELETE on chunks. Still NO DDL and NO TRUNCATE.
CREATE ROLE sentinel_ingest NOLOGIN;
GRANT CONNECT ON DATABASE sentinel            TO sentinel_ingest;
GRANT USAGE  ON SCHEMA public                 TO sentinel_ingest;
GRANT SELECT, INSERT, UPDATE ON documents     TO sentinel_ingest;
GRANT SELECT, INSERT, DELETE ON chunks        TO sentinel_ingest;
-- BIGSERIAL primary keys read from sequences on INSERT → USAGE on them.
GRANT USAGE, SELECT ON SEQUENCE documents_id_seq, chunks_id_seq TO sentinel_ingest;
-- Schema migrations (001/002) are run by the admin/master role at deploy time,
-- NOT by sentinel_ingest — that is why no CREATE/ALTER is granted here.
