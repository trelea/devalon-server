import { sql, type Kysely } from "kysely";

const timestampDefault = () => sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("meta_pixels")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull().unique())
    .addColumn("pixel_code", "text", (col) => col.notNull().unique())
    .addColumn("pixel_script", "text", (col) => col.notNull().unique())
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo(timestampDefault()),
    )
    .addColumn("updated_at", "text", (col) =>
      col.notNull().defaultTo(timestampDefault()),
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("meta_pixels").execute();
}
