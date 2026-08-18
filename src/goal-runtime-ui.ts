export type GoalProgressState =
  | "untracked"
  | "rest"
  | "future"
  | "unavailable"
  | "complete"
  | "progress"
  | "missed"
  | "not-started";

export interface GoalRuntimeUiInput {
  goalId: string;
  liveGoalId?: string;
  currentDay: boolean;
  activityAvailable: boolean;
  liveEligible: boolean;
  paused: boolean;
}

export interface GoalRuntimeUiState {
  live: boolean;
  paused: boolean;
  particlesActive: boolean;
  label?: "Tracking now" | "Paused";
  actionLabel: "Pause" | "Resume";
}

export function getGoalRuntimeUiState(input: GoalRuntimeUiInput): GoalRuntimeUiState {
  const paused = input.currentDay && input.paused;
  const live = input.currentDay
    && input.activityAvailable
    && input.liveEligible
    && !paused
    && input.liveGoalId === input.goalId;

  return {
    live,
    paused,
    particlesActive: live,
    label: paused ? "Paused" : live ? "Tracking now" : undefined,
    actionLabel: paused ? "Resume" : "Pause"
  };
}

export function getGoalCardClassNames(
  progressState: GoalProgressState,
  runtime: Pick<GoalRuntimeUiState, "live" | "paused">
): string {
  return [
    "daily-hub-goal",
    `is-${progressState}`,
    runtime.live ? "is-live" : undefined,
    runtime.paused ? "is-paused" : undefined
  ].filter((className): className is string => className !== undefined).join(" ");
}

export function formatLiveGoalDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(seconds / 60)} min ${seconds % 60} sec`;
}
