import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { PassThrough, type Writable } from "stream";
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
/**
 * Pair returned by `openWriteStream`. The `stream` is the writable sink
 * the producer pipes into; `done` resolves only once the underlying
 * backend has *durably* committed every byte (fs close / S3 multipart
 * complete). Awaiting `stream`'s `close` event is not enough on cloud
 * backends — for `R2Storage` that fires when the archiver closes the
 * PassThrough, well before `Upload.done()` finishes the multipart.
 */
export interface StorageWriteHandle {
  /**
   * The writable sink. Typed as `Writable` (not `NodeJS.WritableStream`)
   * so callers can `destroy(err)` on archiver errors to abort an
   * in-flight upload — both `fs.WriteStream` and `PassThrough` extend
   * `Writable`, so this works for both backends.
   */
  stream: Writable;
  /** Resolves when all bytes are durably written. Rejects on write failure. */
  done: Promise<void>;
}

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
   * the returned `stream` to finalize the write, then `await done` to
   * wait for the backend to confirm durability.
   */
  openWriteStream(key: string): StorageWriteHandle;
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

  openWriteStream(key: string): StorageWriteHandle {
    // Directory must exist before the stream opens — createWriteStream
    // doesn't mkdir.
    fs.mkdirSync(this.baseDir, { recursive: true });
    const stream = fs.createWriteStream(this.resolve(key));
    const done = new Promise<void>((resolve, reject) => {
      stream.on("close", () => resolve());
      stream.on("error", reject);
    });
    return { stream, done };
  }
}

class R2Storage implements Storage {
  private client: S3Client;
  private readonly bucket: string;
  constructor(private readonly prefix: string) {
    // All four R2 envs are read and validated here so a misconfigured
    // deploy fails fast at construction instead of deep in an S3 call
    // with a confusing "empty bucket" error.
    const endpoint = process.env.R2_ENDPOINT;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucket = process.env.R2_BUCKET;
    if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
      throw new Error(
        "R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET required",
      );
    }
    this.bucket = bucket;
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

  openWriteStream(key: string): StorageWriteHandle {
    const stream = new PassThrough();
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: this.keyOf(key),
        Body: stream,
      },
    });
    // `done` resolves when S3 multipart completes and rejects on upload
    // failure — this is the only safe signal the producer can await for
    // R2 durability. We also re-emit the error on the stream so writers
    // observing `error` events get notified (matching `fs.WriteStream`
    // disk-error behavior). The `queueMicrotask` defer preserves the
    // listener-race fix from Task 4: `upload.done()` can reject
    // synchronously (bad creds, invalid key, etc.) before the caller
    // has attached an `error` listener, and an un-listened `error`
    // event crashes the process.
    const done = upload.done().then(
      () => undefined,
      (err) => {
        queueMicrotask(() => stream.emit("error", err));
        throw err;
      },
    );
    return { stream, done };
  }
}

const BASE = path.join(process.cwd(), "data");
const DRIVER = process.env.STORAGE_DRIVER ?? "fs";

let _uploads: Storage | null = null;
let _exports: Storage | null = null;
let _covers: Storage | null = null;

function make(fsSubdir: string, r2Prefix: string): Storage {
  if (DRIVER === "r2") return new R2Storage(r2Prefix);
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
