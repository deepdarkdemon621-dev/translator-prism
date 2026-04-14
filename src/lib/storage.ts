import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";

/**
 * Thin storage abstraction in front of `data/uploads/` and `data/exports/`.
 *
 * The point is not to build a general-purpose object-store wrapper —
 * it's to make the handful of filesystem sites in the app swap-friendly
 * when we move to R2/S3. Every call site should use these methods
 * (not `fs` directly) so the cloud backend lands in one file.
 *
 * Concrete backends live below this interface. `LocalFsStorage` is the
 * current default; once cloud lands, add `R2Storage` and pick between
 * them via env at factory time.
 */
export interface Storage {
  /** Write a blob at `key`, replacing any existing object. */
  put(key: string, data: Buffer | string): Promise<void>;

  /** Read a blob at `key`. Rejects if the object is missing. */
  get(key: string): Promise<Buffer>;

  /** Remove a blob. No-ops if the object was already gone. */
  delete(key: string): Promise<void>;

  /**
   * Escape hatch for producers that only know how to write through a
   * node stream (archiver, large-upload multiparts). Callers must close
   * the returned stream to finalize the write. The local backend pipes
   * through to `fs.createWriteStream`; a cloud backend will wrap a
   * PassThrough with an S3 multipart upload attached to its `finish`.
   */
  openWriteStream(key: string): fs.WriteStream;
}

class LocalFsStorage implements Storage {
  constructor(private readonly baseDir: string) {}

  private resolve(key: string): string {
    // Defense in depth against `..` and absolute paths. The routes already
    // validate filenames but we enforce it here too so a backend swap
    // doesn't silently widen the attack surface.
    const safe = path.basename(key);
    if (safe !== key) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return path.join(this.baseDir, safe);
  }

  private async ensureDir(): Promise<void> {
    await fsPromises.mkdir(this.baseDir, { recursive: true });
  }

  async put(key: string, data: Buffer | string): Promise<void> {
    await this.ensureDir();
    await fsPromises.writeFile(this.resolve(key), data);
  }

  async get(key: string): Promise<Buffer> {
    return fsPromises.readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    try {
      await fsPromises.unlink(this.resolve(key));
    } catch (err) {
      // Already gone is a no-op; rethrow anything else.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  openWriteStream(key: string): fs.WriteStream {
    // Directory must exist before the stream opens — createWriteStream
    // doesn't mkdir.
    fs.mkdirSync(this.baseDir, { recursive: true });
    return fs.createWriteStream(this.resolve(key));
  }
}

const BASE = path.join(process.cwd(), "data");

let _uploads: Storage | null = null;
let _exports: Storage | null = null;
let _covers: Storage | null = null;

export function getUploadsStorage(): Storage {
  if (!_uploads) _uploads = new LocalFsStorage(path.join(BASE, "uploads"));
  return _uploads;
}

export function getExportsStorage(): Storage {
  if (!_exports) _exports = new LocalFsStorage(path.join(BASE, "exports"));
  return _exports;
}

/**
 * Cover images extracted from EPUBs. Kept in its own bucket so we can
 * point a CDN at it (public, long cache) separately from the private
 * uploads bucket that holds the actual EPUB bytes.
 */
export function getCoversStorage(): Storage {
  if (!_covers) _covers = new LocalFsStorage(path.join(BASE, "covers"));
  return _covers;
}
