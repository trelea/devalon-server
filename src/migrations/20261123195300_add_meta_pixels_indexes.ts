import type { Kysely } from "kysely";

const indexes = [
  "meta_pixels_created_at_idx",
  "meta_pixels_updated_at_idx",
  "meta_pixels_name_idx",
  "meta_pixels_pixel_code_idx",
] as const;

const columns = {
  meta_pixels_created_at_idx: "created_at",
  meta_pixels_updated_at_idx: "updated_at",
  meta_pixels_name_idx: "name",
  meta_pixels_pixel_code_idx: "pixel_code",
} as const;

export async function up(db: Kysely<any>): Promise<void> {
  for (const index of indexes) {
    await db.schema
      .createIndex(index)
      .on("meta_pixels")
      .column(columns[index])
      .execute();
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const index of indexes) {
    await db.schema.dropIndex(index).execute();
  }
}
