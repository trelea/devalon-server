import "dotenv/config";

import { Kysely } from "kysely";

import { create_db } from "../db.js";

function require_env(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

/** Node-only database handle for the migration scripts. */
export const db = create_db({
  TURSO_DATABASE_URL: require_env("TURSO_DATABASE_URL"),
  TURSO_AUTH_TOKEN: require_env("TURSO_AUTH_TOKEN"),
});
