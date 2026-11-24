import type { Kysely } from "kysely";

/** Admin-controlled switch for accepting local/private origins while testing. */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("meta_pixel_access_tokens")
    .addColumn("allow_dev_origins", "integer", (col) =>
      col.notNull().defaultTo(0),
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("meta_pixel_access_tokens")
    .dropColumn("allow_dev_origins")
    .execute();
}
