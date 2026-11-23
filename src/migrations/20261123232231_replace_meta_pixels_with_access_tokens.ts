import { sql, type Kysely } from "kysely";

const old_indexes = [
  "meta_pixels_created_at_idx",
  "meta_pixels_updated_at_idx",
  "meta_pixels_name_idx",
  "meta_pixels_pixel_code_idx",
] as const;

const new_indexes = [
  "meta_pixel_access_tokens_created_at_idx",
  "meta_pixel_access_tokens_updated_at_idx",
] as const;

const new_index_columns = {
  meta_pixel_access_tokens_created_at_idx: "created_at",
  meta_pixel_access_tokens_updated_at_idx: "updated_at",
} as const;

const timestamp_default = () => sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export async function up(db: Kysely<any>): Promise<void> {
  for (const index of old_indexes) {
    await db.schema.dropIndex(index).ifExists().execute();
  }
  await db.schema.dropTable("meta_pixels").ifExists().execute();

  await db.schema
    .createTable("meta_pixel_access_tokens")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("pixel_id", "text", (col) => col.notNull().unique())
    .addColumn("access_token", "text", (col) => col.notNull().unique())
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo(timestamp_default()),
    )
    .addColumn("updated_at", "text", (col) =>
      col.notNull().defaultTo(timestamp_default()),
    )
    .execute();

  for (const index of new_indexes) {
    await db.schema
      .createIndex(index)
      .ifNotExists()
      .on("meta_pixel_access_tokens")
      .column(new_index_columns[index])
      .execute();
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const index of new_indexes) {
    await db.schema.dropIndex(index).ifExists().execute();
  }
  await db.schema.dropTable("meta_pixel_access_tokens").ifExists().execute();

  await db.schema
    .createTable("meta_pixels")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull().unique())
    .addColumn("pixel_code", "text", (col) => col.notNull().unique())
    .addColumn("pixel_script", "text", (col) => col.notNull().unique())
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo(timestamp_default()),
    )
    .addColumn("updated_at", "text", (col) =>
      col.notNull().defaultTo(timestamp_default()),
    )
    .execute();

  await db.schema
    .createIndex("meta_pixels_created_at_idx")
    .on("meta_pixels")
    .column("created_at")
    .execute();
  await db.schema
    .createIndex("meta_pixels_updated_at_idx")
    .on("meta_pixels")
    .column("updated_at")
    .execute();
  await db.schema
    .createIndex("meta_pixels_name_idx")
    .on("meta_pixels")
    .column("name")
    .execute();
  await db.schema
    .createIndex("meta_pixels_pixel_code_idx")
    .on("meta_pixels")
    .column("pixel_code")
    .execute();
}
