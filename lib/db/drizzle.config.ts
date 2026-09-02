import { defineConfig } from "drizzle-kit";
import path from "path";

// SUPABASE_DB_URL is the direct Postgres connection string (Supabase project settings → Database → Connection string → URI).
// Falls back to DATABASE_URL (Replit-managed local DB) when SUPABASE_DB_URL is not set.
const dbUrl = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;

if (!dbUrl) {
  throw new Error("Set SUPABASE_DB_URL to the direct Supabase Postgres connection string.");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: dbUrl,
  },
});
