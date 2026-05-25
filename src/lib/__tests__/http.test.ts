import { describe, expect, it } from "vitest";
import { readJsonOrText } from "../http";

describe("readJsonOrText", () => {
  it("reads JSON responses", async () => {
    const response = Response.json({ id: "book-1" });

    await expect(readJsonOrText<{ id: string }>(response)).resolves.toEqual({
      id: "book-1",
    });
  });

  it("turns non-JSON responses into readable errors", async () => {
    const response = new Response("Request Entity Too Large", {
      status: 413,
      statusText: "Payload Too Large",
      headers: { "content-type": "text/plain" },
    });

    await expect(readJsonOrText(response)).resolves.toEqual({
      error: "Request Entity Too Large",
    });
  });
});
