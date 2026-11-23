import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { FileMigrationProvider, Migrator } from "kysely/migration";

import { db } from "./node-db.js";

const migrator = new Migrator({
  db,
  provider: new FileMigrationProvider({
    fs,
    path,
    migrationFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
    import: (filePath) => import(pathToFileURL(filePath).href),
  }),
});

const { error, results } = await migrator.migrateToLatest();

for (const result of results ?? []) {
  if (result.status === "Success") {
    console.log(`Applied migration: ${result.migrationName}`);
  } else if (result.status === "Error") {
    console.error(`Failed migration: ${result.migrationName}`);
  }
}

if (error) {
  console.error("Migration failed:", error);
  await db.destroy();
  process.exit(1);
}

await db.destroy();
