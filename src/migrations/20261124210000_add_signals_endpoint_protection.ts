import { sql, type Kysely } from "kysely";

const timestamp_default = () => sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("meta_pixel_access_tokens")
    .addColumn("site_token", "text")
    .execute();

  await db.schema
    .alterTable("meta_pixel_access_tokens")
    .addColumn("enforce_browser_checks", "integer", (col) =>
      col.notNull().defaultTo(0),
    )
    .execute();

  await db.schema
    .createTable("meta_pixel_allowed_origins")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("pixel_id", "text", (col) => col.notNull())
    .addColumn("origin", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo(timestamp_default()),
    )
    .execute();

  await db.schema
    .createIndex("meta_pixel_allowed_origins_pixel_id_idx")
    .ifNotExists()
    .on("meta_pixel_allowed_origins")
    .column("pixel_id")
    .execute();

  await db.schema
    .createIndex("meta_pixel_allowed_origins_unique")
    .ifNotExists()
    .on("meta_pixel_allowed_origins")
    .columns(["pixel_id", "origin"])
    .unique()
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .dropIndex("meta_pixel_allowed_origins_unique")
    .ifExists()
    .execute();
  await db.schema
    .dropIndex("meta_pixel_allowed_origins_pixel_id_idx")
    .ifExists()
    .execute();
  await db.schema.dropTable("meta_pixel_allowed_origins").ifExists().execute();

  await db.schema
    .alterTable("meta_pixel_access_tokens")
    .dropColumn("enforce_browser_checks")
    .execute();
  await db.schema
    .alterTable("meta_pixel_access_tokens")
    .dropColumn("site_token")
    .execute();
}
