import { describe, expect, it } from "vitest";
import {
  formatLiveGoalDuration,
  getGoalCardClassNames,
  getGoalRuntimeUiState,
  type GoalRuntimeUiInput
} from "../src/goal-runtime-ui";

function runtime(overrides: Partial<GoalRuntimeUiInput> = {}) {
  return getGoalRuntimeUiState({
    goalId: "devops",
    liveGoalId: "devops",
    currentDay: true,
    activityAvailable: true,
    liveEligible: true,
    paused: false,
    ...overrides
  });
}

describe("goal runtime UI", () => {
  it("marks the resolver-selected goal live and activates its particles", () => {
    const state = runtime();

    expect(state).toMatchObject({
      live: true,
      paused: false,
      particlesActive: true,
      label: "Tracking now",
      actionLabel: "Pause"
    });
    expect(getGoalCardClassNames("progress", state)).toContain("is-live");
  });

  it("keeps non-live goals free of live feedback", () => {
    const state = runtime({ liveGoalId: "writing" });

    expect(state.live).toBe(false);
    expect(state.particlesActive).toBe(false);
    expect(state.label).toBeUndefined();
    expect(getGoalCardClassNames("progress", state)).not.toContain("is-live");
  });

  it("makes pause override live state and exposes Resume", () => {
    const state = runtime({ paused: true });

    expect(state).toMatchObject({
      live: false,
      paused: true,
      particlesActive: false,
      label: "Paused",
      actionLabel: "Resume"
    });
    expect(getGoalCardClassNames("progress", state)).toContain("is-paused");
  });

  it("keeps completion and runtime state independent", () => {
    const classes = getGoalCardClassNames("complete", runtime());

    expect(classes).toContain("is-complete");
    expect(classes).toContain("is-live");
  });

  it("never activates historical, offline, or ineligible goal cards", () => {
    for (const state of [
      runtime({ currentDay: false }),
      runtime({ activityAvailable: false }),
      runtime({ liveEligible: false })
    ]) {
      expect(state.live).toBe(false);
      expect(state.particlesActive).toBe(false);
    }
  });

  it("uses second precision only for the live display value", () => {
    expect(formatLiveGoalDuration(10_104.9)).toBe("168 min 24 sec");
    expect(formatLiveGoalDuration(-20)).toBe("0 min 0 sec");
  });
});
