import { describe, expect, test } from "bun:test";
import { today } from "../../src/core/clock.ts";

describe("today", () => {
  test("LTM_TODAY wins over the system date", () => {
    expect(today({ LTM_TODAY: "2026-10-09" }, new Date(2030, 0, 1))).toBe("2026-10-09");
  });

  // Built with the local-time constructor, so the expected day holds in every timezone.
  test("unset or empty LTM_TODAY gives the local date", () => {
    const lateEvening = new Date(2026, 9, 9, 23, 30);
    expect(today({}, lateEvening)).toBe("2026-10-09");
    expect(today({ LTM_TODAY: "" }, lateEvening)).toBe("2026-10-09");
    expect(today({}, new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  // Date.UTC reads years 0-99 as 1900-1999, so these are the cases a round trip through Date gets wrong.
  test.each(["0001-01-01", "0099-12-31", "0000-02-29", "2000-02-29"])("LTM_TODAY %p is accepted", (value) => {
    expect(today({ LTM_TODAY: value })).toBe(value);
  });

  test.each(["2026-13-40", "2026-02-30", "1900-02-29", "2026-04-31", "2026-00-10", "2026-10-00", "26-10-09", "2026-10-9", "2026-10-09T00:00", "yesterday"])(
    "LTM_TODAY %p is refused",
    (value) => {
      expect(() => today({ LTM_TODAY: value })).toThrow(`LTM_TODAY '${value}' is not a YYYY-MM-DD date`);
    },
  );

  test("a leap day is a real date", () => {
    expect(today({ LTM_TODAY: "2028-02-29" })).toBe("2028-02-29");
  });
});
