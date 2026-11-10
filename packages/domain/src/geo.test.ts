import { describe, expect, it } from "vitest";
import { haversineMeters, impliedSpeedKmh, isInPolygon, isWithinRadius } from "./geo.js";

const ruiru = { lat: -1.1489, lng: 36.9612 };
const kitengela = { lat: -1.4772, lng: 36.9589 };

describe("haversineMeters", () => {
  it("measures the Ruiru–Kitengela distance (about 36.5 km)", () => {
    const d = haversineMeters(ruiru, kitengela);
    expect(d).toBeGreaterThan(36_000);
    expect(d).toBeLessThan(37_000);
  });

  it("is zero for the same point", () => {
    expect(haversineMeters(ruiru, ruiru)).toBe(0);
  });
});

describe("isWithinRadius", () => {
  it("accepts points inside a 120 m site radius", () => {
    expect(isWithinRadius({ lat: ruiru.lat + 0.0009, lng: ruiru.lng }, ruiru, 120)).toBe(true);
  });

  it("flags a check-in about 412 m away, unless tolerance covers it", () => {
    const point = { lat: ruiru.lat + 0.0037, lng: ruiru.lng };
    expect(isWithinRadius(point, ruiru, 120)).toBe(false);
    expect(isWithinRadius(point, ruiru, 120, 300)).toBe(true);
  });
});

describe("isInPolygon", () => {
  const square = [
    { lat: -1.148, lng: 36.96 },
    { lat: -1.148, lng: 36.962 },
    { lat: -1.15, lng: 36.962 },
    { lat: -1.15, lng: 36.96 },
  ];

  it("detects inside and outside points", () => {
    expect(isInPolygon(ruiru, square)).toBe(true);
    expect(isInPolygon(kitengela, square)).toBe(false);
  });

  it("returns false for degenerate polygons", () => {
    expect(isInPolygon(ruiru, square.slice(0, 2))).toBe(false);
  });
});

describe("impliedSpeedKmh", () => {
  it("shows Kitengela 06:55 → Ruiru 07:20 is impossible travel (> 80 km/h straight-line)", () => {
    expect(impliedSpeedKmh(kitengela, ruiru, 25)).toBeGreaterThan(80);
  });

  it("treats simultaneous check-ins as infinitely fast", () => {
    expect(impliedSpeedKmh(kitengela, ruiru, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});
