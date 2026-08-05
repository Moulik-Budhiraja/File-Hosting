import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

function hexChannel(pair: string): number {
  const value = Number.parseInt(pair, 16) / 255;
  return value <= 0.04045
    ? value / 12.92
    : Math.pow((value + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/iu.exec(hex);
  if (!match) throw new Error(`invalid color: ${hex}`);
  return (
    0.2126 * hexChannel(match[1]!) +
    0.7152 * hexChannel(match[2]!) +
    0.0722 * hexChannel(match[3]!)
  );
}

function contrast(foreground: string, background: string): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function cssToken(source: string, name: string): string {
  const match = new RegExp(`${name}:\\s*(#[\\da-f]{6})`, "iu").exec(source);
  if (!match) throw new Error(`missing token: ${name}`);
  return match[1]!.toLowerCase();
}

describe("slate text contrast", () => {
  const css = readFileSync("src/styles/globals.css", "utf8");
  const unavailable = readFileSync("src/server/files/unavailable.ts", "utf8");
  const slate = cssToken(css, "--color-slate");

  test("uses the approved AA-safe exact token on ground and surface", () => {
    expect(slate).toBe("#828c94");
    expect(
      contrast(slate, cssToken(css, "--color-ground")),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(slate, cssToken(css, "--color-surface")),
    ).toBeGreaterThanOrEqual(4.5);
  });

  test("keeps the branded unavailable page exact and AA-safe", () => {
    const codeColor = /\.code\{[^}]*color:(#[\da-f]{6})/iu.exec(
      unavailable,
    )?.[1];
    expect(codeColor?.toLowerCase()).toBe(slate);
    expect(contrast(codeColor!, "#101214")).toBeGreaterThanOrEqual(4.5);
  });

  test("keeps blocking danger notices distinct from warning notices", () => {
    expect(css).toMatch(
      /\.notice-danger\s*\{[^}]*border-color:\s*var\(--color-danger\)/su,
    );
  });
});

describe("non-text control boundary contrast", () => {
  const css = readFileSync("src/styles/globals.css", "utf8");

  test("keeps control boundaries at 3:1 on every adjacent ground", () => {
    const strong = cssToken(css, "--color-hairline-strong");
    expect(strong).toBe("#5a6773");
    for (const ground of [
      "--color-ground",
      "--color-surface",
      "--color-ground-sunk",
    ]) {
      expect(contrast(strong, cssToken(css, ground))).toBeGreaterThanOrEqual(3);
    }
  });

  test("keeps decorative hairlines unchanged", () => {
    expect(cssToken(css, "--color-hairline")).toBe("#23282d");
  });
});
