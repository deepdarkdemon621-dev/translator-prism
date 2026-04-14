import { existsSync, mkdirSync } from "fs";
import path from "path";

export function ensureDataDir() {
  const dataDir = path.join(process.cwd(), "data");
  const uploadsDir = path.join(process.cwd(), "data", "uploads");
  const exportsDir = path.join(process.cwd(), "data", "exports");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
  if (!existsSync(exportsDir)) mkdirSync(exportsDir, { recursive: true });
}
