import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";

describe("next config", () => {
  it("allows EPUB upload bodies up to the route limit", () => {
    expect(nextConfig.experimental?.serverActions?.bodySizeLimit).toBe("50mb");
  });
});
