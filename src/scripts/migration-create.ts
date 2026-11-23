import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rawName = process.argv[2];

if (!rawName) {
  console.error("Usage: yarn migration:create <migration_name>");
  process.exit(1);
}

const name = rawName
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "_")
  .replace(/^_+|_+$/g, "");

if (!name) {
  console.error("Migration name must contain at least one letter or digit");
  process.exit(1);
}

const prefix = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
const fileName = `${prefix}_${name}.ts`;
const migrationFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const filePath = path.join(migrationFolder, fileName);

const template = `import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // TODO: implement the migration
}

export async function down(db: Kysely<any>): Promise<void> {
  // TODO: undo the migration
}
`;

await mkdir(migrationFolder, { recursive: true });

try {
  await writeFile(filePath, template, { flag: "wx" });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "EEXIST") {
    console.error(`Migration already exists: ${fileName}`);
    process.exit(1);
  }

  throw error;
}

console.log(`Created migration: src/migrations/${fileName}`);
