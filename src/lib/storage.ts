import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { PassThrough } from "stream";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  NoSuchKey,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

/**
 * Thin storage abstraction in front of `data/uploads/` and `data/exports/`.
 *
 * The point is not to build a general-purpose object-store wrapper —
 * it's to make the handful of filesystem sites in the app swap-friendly
 * when we move to R2/S3. Every call site should use these methods
 * (not `fs` directly) so the cloud backend lands in one file.
 *
 * Concrete backends live below this interface. `LocalFsStorage` is the
 * current default; `R2Storage` is selected when `STORAGE_DRIVER=r2`.
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

class R2Storage implements Storage {
  private client: S3Client;
  constructor(private readonly bucket: string, private readonly prefix: string) {
    const endpoint = process.env.R2_ENDPOINT;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    if (!endpoint || !accessKeyId || !secretAccessKey) {
      throw new Error("R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY required");
    }
    this.client = new S3Client({
      region: "auto",
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  private keyOf(key: string): string {
    // Match LocalFsStorage.resolve: callers pass flat keys (e.g. `${bookId}.epub`).
    // Rejecting anything else keeps both backends' contracts identical so
    // a driver swap doesn't silently change what keys are accepted.
    const safe = path.basename(key);
    if (safe !== key) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return `${this.prefix}/${safe}`;
  }

  async put(key: string, data: Buffer | string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.keyOf(key),
        Body: typeof data === "string" ? Buffer.from(data) : data,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.keyOf(key) }),
      );
      const chunks: Buffer[] = [];
      for await (const chunk of res.Body as AsyncIterable<Buffer>) chunks.push(chunk);
      return Buffer.concat(chunks);
    } catch (err) {
      if (err instanceof NoSuchKey) {
        throw Object.assign(new Error(`Not found: ${key}`), { code: "ENOENT" });
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.keyOf(key) }),
    );
  }

  openWriteStream(key: string): fs.WriteStream {
    const pass = new PassThrough();
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: this.keyOf(key),
        Body: pass,
      },
    });
    upload.done().catch((err) => pass.emit("error", err));
    return pass as unknown as fs.WriteStream;
  }
}

const BASE = path.join(process.cwd(), "data");
const DRIVER = process.env.STORAGE_DRIVER ?? "fs";
const R2_BUCKET = process.env.R2_BUCKET ?? "";

let _uploads: Storage | null = null;
let _exports: Storage | null = null;
let _covers: Storage | null = null;

function make(fsSubdir: string, r2Prefix: string): Storage {
  if (DRIVER === "r2") return new R2Storage(R2_BUCKET, r2Prefix);
  return new LocalFsStorage(path.join(BASE, fsSubdir));
}

export function getUploadsStorage(): Storage {
  if (!_uploads) _uploads = make("uploads", "uploads");
  return _uploads;
}

export function getExportsStorage(): Storage {
  if (!_exports) _exports = make("exports", "exports");
  return _exports;
}

/**
 * Cover images extracted from EPUBs. Kept in its own bucket so we can
 * point a CDN at it (public, long cache) separately from the private
 * uploads bucket that holds the actual EPUB bytes.
 */
export function getCoversStorage(): Storage {
  if (!_covers) _covers = make("covers", "covers");
  return _covers;
}
