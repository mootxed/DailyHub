import { getLocalDateRange } from "./date";
import {
  createDefaultSchedule,
  WEEKDAYS,
  type DailyGoal,
  type GoalDayOverride,
  type GoalProgress,
  type GoalSchedule,
  type Weekday
} from "./models";

export type EffectiveGoalDaySource = "schedule" | "override";

export interface EffectiveGoalDay {
  goalId: string;
  scheduled: boolean;
  skipped: boolean;
  targetMinutes: number;
  source: EffectiveGoalDaySource;
}

export interface PlannedGoalProgress extends EffectiveGoalDay {
  activeSeconds: number;
  actualMinutes: number;
  completed: boolean;
  progressRatio: number | undefined;
}

export function isValidTargetMinutes(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1;
}

export function parseDefaultTargetInput(value: string): number | undefined {
  const targetMinutes = Number(value);
  return isValidTargetMinutes(targetMinutes) ? targetMinutes : undefined;
}

export function getWeekday(dateKey: string): Weekday {
  const day = getLocalDateRange(dateKey).start.getDay();
  const weekday = WEEKDAYS[(day + 6) % 7];
  if (weekday === undefined) throw new Error("Invalid weekday");
  return weekday;
}

export function getGoalSchedule(goal: Pick<DailyGoal, "targetMinutes" | "schedule">): GoalSchedule {
  return goal.schedule ?? createDefaultSchedule(goal.targetMinutes);
}

export function updateDefaultTarget(
  goal: DailyGoal,
  newTargetMinutes: number,
  protectedWeekdays?: ReadonlySet<Weekday>
): DailyGoal {
  if (!isValidTargetMinutes(newTargetMinutes)) throw new Error("Invalid default target");
  const oldTargetMinutes = goal.targetMinutes;
  const schedule = getGoalSchedule(goal);
  return {
    ...goal,
    targetMinutes: newTargetMinutes,
    schedule: Object.fromEntries(WEEKDAYS.map((weekday) => {
      const day = schedule[weekday];
      return [weekday, {
        ...day,
        targetMinutes: !protectedWeekdays?.has(weekday) && day.targetMinutes === oldTargetMinutes
          ? newTargetMinutes
          : day.targetMinutes
      }];
    })) as GoalSchedule
  };
}

export function applyDefaultTargetToAllDays(goal: DailyGoal): DailyGoal {
  const schedule = getGoalSchedule(goal);
  return {
    ...goal,
    schedule: Object.fromEntries(WEEKDAYS.map((weekday) => [weekday, {
      ...schedule[weekday],
      targetMinutes: goal.targetMinutes
    }])) as GoalSchedule
  };
}

export function getEffectiveGoalDay(goal: DailyGoal, dateKey: string): EffectiveGoalDay {
  const scheduled = getGoalSchedule(goal)[getWeekday(dateKey)];
  const override = goal.overrides?.[dateKey];
  if (override?.kind === "skip") {
    return {
      goalId: goal.id,
      scheduled: false,
      skipped: true,
      targetMinutes: scheduled.targetMinutes,
      source: "override"
    };
  }
  if (override?.kind === "target") {
    return {
      goalId: goal.id,
      scheduled: goal.enabled,
      skipped: false,
      targetMinutes: override.targetMinutes,
      source: "override"
    };
  }
  return {
    goalId: goal.id,
    scheduled: goal.enabled && scheduled.enabled,
    skipped: false,
    targetMinutes: scheduled.targetMinutes,
    source: "schedule"
  };
}

export function isGoalScheduled(goal: DailyGoal, dateKey: string): boolean {
  return getEffectiveGoalDay(goal, dateKey).scheduled;
}

export function getEffectiveTargetMinutes(goal: DailyGoal, dateKey: string): number {
  return getEffectiveGoalDay(goal, dateKey).targetMinutes;
}

export function applyScheduleToProgress(
  goals: DailyGoal[],
  progress: GoalProgress[],
  dateKey: string
): PlannedGoalProgress[] {
  const progressByGoal = new Map(progress.map((item) => [item.goalId, item]));
  return goals.map((goal) => {
    const effective = getEffectiveGoalDay(goal, dateKey);
    const raw = progressByGoal.get(goal.id);
    const activeSeconds = raw?.activeSeconds ?? 0;
    const targetSeconds = effective.targetMinutes * 60;
    return {
      ...effective,
      activeSeconds,
      actualMinutes: activeSeconds / 60,
      completed: effective.scheduled && activeSeconds >= targetSeconds,
      progressRatio: effective.scheduled ? activeSeconds / targetSeconds : undefined
    };
  });
}

export function parseTargetOverride(value: string): GoalDayOverride | undefined {
  const targetMinutes = parseDefaultTargetInput(value);
  return targetMinutes === undefined ? undefined : { kind: "target", targetMinutes };
}

export function withGoalDayOverride(
  goal: DailyGoal,
  dateKey: string,
  override: GoalDayOverride | undefined
): DailyGoal {
  getLocalDateRange(dateKey);
  if (override?.kind === "target" && !isValidTargetMinutes(override.targetMinutes)) {
    throw new Error("Invalid target override");
  }
  const overrides = Object.fromEntries(
    Object.entries(goal.overrides ?? {}).filter(([key]) => key !== dateKey)
  );
  if (override !== undefined) overrides[dateKey] = override;
  return { ...goal, overrides };
}
