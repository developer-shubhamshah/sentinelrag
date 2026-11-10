import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "pg";
import { config } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(__dirname, "..", "sql");

// Applied in order. Add new migration files here as the schema evolves.
const MIGRATIONS = ["001_schema.sql", "002_indexes.sql"];

async function main(): Promise<void> {
  const client = new Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  try {
    for (const file of MIGRATIONS) {
      const sql = await readFile(join(SQL_DIR, file), "utf8");
      process.stdout.write(`applying ${file} ... `);
      await client.query(sql);
      console.log("ok");
    }
    console.log("migrations complete");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("migration failed:", err);
  process.exit(1);
});
