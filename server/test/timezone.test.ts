import { describe, expect, it } from "vitest";
import { offsetFromE164, zoneFromE164, zoneOffsetMinutes } from "../src/safety/timezone.js";

// Fixed clock in summer so US DST is in effect (deterministic offsets).
const JUNE = new Date("2026-06-21T12:00:00Z");

describe("zoneFromE164", () => {
  it("maps a US Pacific area code (Bek's 650 number)", () => {
    expect(zoneFromE164("+16508859995")).toBe("America/Los_Angeles");
  });
  it("maps Bay Area overlay area codes (628 SF / 669 San Jose / 341 Oakland)", () => {
    expect(zoneFromE164("+16285551234")).toBe("America/Los_Angeles");
    expect(zoneFromE164("+16695551234")).toBe("America/Los_Angeles");
    expect(zoneFromE164("+13415551234")).toBe("America/Los_Angeles");
  });
  it("maps a US Eastern area code", () => {
    expect(zoneFromE164("+12125551234")).toBe("America/New_York");
  });
  it("fails closed (null) for an unlisted NANP area code instead of guessing Eastern", () => {
    expect(zoneFromE164("+19995551234")).toBeNull();
  });
  it("fails closed (null) for a malformed +1 number (not 11 digits)", () => {
    expect(zoneFromE164("+1650555123")).toBeNull();
    expect(zoneFromE164("+1650555123456")).toBeNull();
  });
  it("maps a Kazakhstan number to Almaty", () => {
    expect(zoneFromE164("+77771110474")).toBe("Asia/Almaty");
  });
  it("maps a UK number to London", () => {
    expect(zoneFromE164("+442071234567")).toBe("Europe/London");
  });
  it("returns null for a malformed number", () => {
    expect(zoneFromE164("650-885-9995")).toBeNull();
  });
});

describe("zoneOffsetMinutes (DST-correct via Intl)", () => {
  it("Pacific in June is PDT (-420)", () => {
    expect(zoneOffsetMinutes("America/Los_Angeles", JUNE)).toBe(-420);
  });
  it("Eastern in June is EDT (-240)", () => {
    expect(zoneOffsetMinutes("America/New_York", JUNE)).toBe(-240);
  });
  it("Phoenix has no DST (-420 year-round)", () => {
    expect(zoneOffsetMinutes("America/Phoenix", JUNE)).toBe(-420);
  });
  it("Almaty is UTC+5 (300)", () => {
    expect(zoneOffsetMinutes("Asia/Almaty", JUNE)).toBe(300);
  });
  it("London in June is BST (+60)", () => {
    expect(zoneOffsetMinutes("Europe/London", JUNE)).toBe(60);
  });
  it("returns null for an unknown zone", () => {
    expect(zoneOffsetMinutes("Mars/Olympus_Mons", JUNE)).toBeNull();
  });
});

describe("offsetFromE164", () => {
  it("derives -420 for Bek's 650 number in June (its nominal Pacific region)", () => {
    expect(offsetFromE164("+16508859995", JUNE)).toBe(-420);
  });
  it("derives +300 for a Kazakhstan number", () => {
    expect(offsetFromE164("+77771110474", JUNE)).toBe(300);
  });
  it("returns null for an unrecognized number", () => {
    expect(offsetFromE164("+9999999", JUNE)).toBeNull();
  });
});
