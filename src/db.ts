import { LibsqlDialect } from "@libsql/kysely-libsql";
import { Kysely, type ColumnType } from "kysely";

export interface DbEnv {
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN: string;
}

/** Values provided by the Worker environment (wrangler vars/secrets). */
export interface Env extends DbEnv {
  ADMIN_TOKEN: string;
  META_GRAPH_API_VERSION?: string;
  META_GRAPH_API_BASE_URL?: string;
}

export interface Database {
  meta_pixel_access_tokens: {
    id: ColumnType<string, string, never>;
    pixel_id: string;
    access_token: string;
    created_at: ColumnType<string, string | undefined, never>;
    updated_at: ColumnType<string, string | undefined, string>;
  };
}

/** Creates a Kysely instance from Worker bindings. */
export function create_db(env: DbEnv): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new LibsqlDialect({
      url: env.TURSO_DATABASE_URL,
      authToken: env.TURSO_AUTH_TOKEN,
    }),
  });
}

const db_cache = new Map<string, Kysely<Database>>();

/** Reuses one client per set of credentials within a Worker isolate. */
export function get_db(env: DbEnv): Kysely<Database> {
  const key = `${env.TURSO_DATABASE_URL}|${env.TURSO_AUTH_TOKEN}`;

  let db = db_cache.get(key);
  if (!db) {
    db = create_db(env);
    db_cache.set(key, db);
  }

  return db;
}
