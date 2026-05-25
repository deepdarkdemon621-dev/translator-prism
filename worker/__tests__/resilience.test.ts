import { describe, expect, it, vi } from "vitest";
import {
  isRecoverableWorkerError,
  runRecoverableWorkerStep,
} from "../resilience";

describe("isRecoverableWorkerError", () => {
  it("treats DNS lookup failures as recoverable worker infrastructure errors", () => {
    const err = Object.assign(new Error("getaddrinfo ENOTFOUND turso.example"), {
      code: "ENOTFOUND",
    });

    expect(isRecoverableWorkerError(err)).toBe(true);
  });

  it("does not hide ordinary programming errors", () => {
    expect(isRecoverableWorkerError(new TypeError("bad state"))).toBe(false);
  });
});

describe("runRecoverableWorkerStep", () => {
  it("logs, sleeps, and reports failure instead of throwing recoverable errors", async () => {
    const err = Object.assign(new Error("temporary dns failure"), {
      code: "ENOTFOUND",
    });
    const onRecoverableError = vi.fn();
    const sleep = vi.fn(async () => {});

    const result = await runRecoverableWorkerStep({
      label: "claimOne",
      operation: async () => {
        throw err;
      },
      onRecoverableError,
      retryDelayMs: 123,
      sleep,
    });

    expect(result).toEqual({ ok: false });
    expect(onRecoverableError).toHaveBeenCalledWith("claimOne", err, 123);
    expect(sleep).toHaveBeenCalledWith(123);
  });

  it("returns successful operation values", async () => {
    const result = await runRecoverableWorkerStep({
      label: "claimOne",
      operation: async () => "translation-id",
      onRecoverableError: vi.fn(),
      retryDelayMs: 123,
      sleep: vi.fn(async () => {}),
    });

    expect(result).toEqual({ ok: true, value: "translation-id" });
  });

  it("rethrows non-recoverable errors", async () => {
    const err = new TypeError("bad state");

    await expect(
      runRecoverableWorkerStep({
        label: "claimOne",
        operation: async () => {
          throw err;
        },
        onRecoverableError: vi.fn(),
        retryDelayMs: 123,
        sleep: vi.fn(async () => {}),
      }),
    ).rejects.toBe(err);
  });
});
