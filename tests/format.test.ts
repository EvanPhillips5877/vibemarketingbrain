import { describe, expect, it } from "vitest";
import { localDay, moneyText } from "../src/analytics/format.js";

describe("localDay", () => {
  it("reads the calendar in the brand's zone, not UTC", () => {
    const lateEvening = new Date("2026-11-01T01:30:00Z"); // 21:30 on Oct 31 in Toronto
    expect(localDay(lateEvening, "America/Toronto")).toBe("2026-10-31");
    expect(localDay(lateEvening, "UTC")).toBe("2026-11-01");
    expect(localDay(lateEvening, "America/Toronto", 7)).toBe("2026-10-24");
  });
});

describe("moneyText", () => {
  it("renders micros with two decimals and n/a for nothing", () => {
    expect(moneyText("CAD", 2_412_130_000)).toBe("CAD 2412.13");
    expect(moneyText("CAD", null)).toBe("n/a");
  });
});
