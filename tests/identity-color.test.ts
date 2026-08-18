import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getIdentityColor,
  getIdentityColorIndex,
  getIdentityKey,
  IDENTITY_COLOR_COUNT,
  IDENTITY_COLOR_NAMES,
  resolveIdentityColorIndex
} from "../src/identity-color";

describe("identity colors", () => {
  it("builds normalized, kind-specific identity keys", () => {
    expect(getIdentityKey("app", " Google Chrome ")).toBe("app:google-chrome");
    expect(getIdentityKey("site", "GitHub.com")).toBe("site:github.com");
    expect(getIdentityKey("category", "Development")).toBe("category:development");
    expect(getIdentityKey("goal", "Development")).toBe("goal:development");
  });

  it("keeps an application stable across breakdown, timeline, and chart inputs", () => {
    const breakdownColor = getIdentityColor("app", "Obsidian");
    const timelineColor = getIdentityColor("app", "obsidian");
    const chartColor = getIdentityColor("app", " OBSIDIAN ");
    expect(timelineColor).toBe(breakdownColor);
    expect(chartColor).toBe(breakdownColor);
    expect(getIdentityColorIndex("app", "Obsidian")).toBe(getIdentityColorIndex("app", "obsidian"));
  });

  it("gives the representative application set distinct curated identities", () => {
    const colors = ["Sober", "Google Chrome", "Obsidian", "Visual Studio Code", "Spectacle"]
      .map((application) => getIdentityColor("app", application));
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("honors explicit goal and category palette indexes", () => {
    expect(resolveIdentityColorIndex("goal", "writing", 2)).toBe(2);
    expect(resolveIdentityColorIndex("category", "development", 2)).toBe(2);
    expect(getIdentityColor("goal", "writing", 2)).toBe("var(--dh-identity-color-3)");
    expect(getIdentityColor("category", "development", 2)).toBe("var(--dh-identity-color-3)");
  });

  it("keeps Other and site identities deterministic", () => {
    expect(getIdentityKey("app", "Other")).toBe("app:__other__");
    expect(getIdentityColor("app", "Other")).toBe(getIdentityColor("app", "__other__"));
    expect(getIdentityColor("site", "github.com")).toBe(getIdentityColor("site", "GitHub.com"));
  });

  it("defines one complete, distinct palette for both themes", () => {
    expect(IDENTITY_COLOR_COUNT).toBe(10);
    expect(new Set(IDENTITY_COLOR_NAMES).size).toBe(IDENTITY_COLOR_COUNT);

    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const presets = [...css.matchAll(/--dh-identity-color-(\d+):\s*(#[\da-f]{6});/giu)]
      .map((match) => ({ index: Number(match[1]), color: match[2]?.toLowerCase() }));
    expect(presets).toHaveLength(IDENTITY_COLOR_COUNT * 2);
    for (let index = 1; index <= IDENTITY_COLOR_COUNT; index += 1) {
      expect(presets.filter((preset) => preset.index === index)).toHaveLength(2);
    }
    expect(new Set(presets.slice(0, IDENTITY_COLOR_COUNT).map((preset) => preset.color)).size)
      .toBe(IDENTITY_COLOR_COUNT);
    expect(new Set(presets.slice(IDENTITY_COLOR_COUNT).map((preset) => preset.color)).size)
      .toBe(IDENTITY_COLOR_COUNT);
    expect(presets.map((preset) => preset.color)).not.toContain("#a86100");
    expect(presets.map((preset) => preset.color)).not.toContain("#b34e3d");
    expect(css).not.toContain("--dh-goal-color-");
  });
});
