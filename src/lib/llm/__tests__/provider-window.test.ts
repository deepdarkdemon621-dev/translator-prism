import { describe, expect, it } from "vitest";
import {
  isWithinWeeklyWindow,
  parseWeeklyWindow,
} from "../provider-window";

describe("weekly provider window", () => {
  const windowSpec = "FRI 18:00-SAT 09:30";
  const timeZone = "Asia/Tokyo";

  it("allows times inside a weekly window", () => {
    expect(
      isWithinWeeklyWindow(
        windowSpec,
        timeZone,
        new Date("2026-06-05T09:00:00.000Z"),
      ),
    ).toBe(true);
    expect(
      isWithinWeeklyWindow(
        windowSpec,
        timeZone,
        new Date("2026-06-06T00:29:00.000Z"),
      ),
    ).toBe(true);
  });

  it("rejects times outside a weekly window", () => {
    expect(
      isWithinWeeklyWindow(
        windowSpec,
        timeZone,
        new Date("2026-06-06T01:00:00.000Z"),
      ),
    ).toBe(false);
    expect(
      isWithinWeeklyWindow(
        windowSpec,
        timeZone,
        new Date("2026-06-08T03:00:00.000Z"),
      ),
    ).toBe(false);
  });

  it("treats missing windows as unrestricted", () => {
    expect(
      isWithinWeeklyWindow("", timeZone, new Date("2026-06-08T03:00:00.000Z")),
    ).toBe(true);
  });

  it("treats invalid windows as unavailable", () => {
    expect(parseWeeklyWindow("FRIDAY AFTER WORK")).toBeNull();
    expect(
      isWithinWeeklyWindow(
        "FRIDAY AFTER WORK",
        timeZone,
        new Date("2026-06-05T09:00:00.000Z"),
      ),
    ).toBe(false);
  });

  it("treats invalid time zones as unavailable", () => {
    expect(
      isWithinWeeklyWindow(
        windowSpec,
        "Not/AZone",
        new Date("2026-06-05T09:00:00.000Z"),
      ),
    ).toBe(false);
  });
});
