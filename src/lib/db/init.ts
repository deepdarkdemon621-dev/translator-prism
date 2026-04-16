import { existsSync, mkdirSync } from "fs";
import path from "path";

export function ensureDataDir() {
  // Only the local fs storage driver needs these directories. In R2 mode
  // (Vercel production) the filesystem is read-only outside /tmp, so any
  // mkdir in process.cwd() throws ENOENT. We skip early for any non-fs
  // driver; STORAGE_DRIVER defaults to "fs" locally when unset.
  if ((process.env.STORAGE_DRIVER ?? "fs") !== "fs") return;

  const dataDir = path.join(process.cwd(), "data");
  const uploadsDir = path.join(process.cwd(), "data", "uploads");
  const exportsDir = path.join(process.cwd(), "data", "exports");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
  if (!existsSync(exportsDir)) mkdirSync(exportsDir, { recursive: true });
}
