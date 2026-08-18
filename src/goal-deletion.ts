interface GoalDeletionPlugin {
  hasGoal(id: string): boolean;
  deleteGoal(id: string): Promise<void>;
}

export function isDeleteGoalAvailable(plugin: Pick<GoalDeletionPlugin, "hasGoal">, id: string): boolean {
  return plugin.hasGoal(id);
}

export class GoalDeletionAction {
  private state: "idle" | "running" | "settled" = "idle";

  constructor(
    private readonly plugin: Pick<GoalDeletionPlugin, "deleteGoal">,
    private readonly goalId: string
  ) {}

  cancel(): void {
    if (this.state === "idle") this.state = "settled";
  }

  async confirm(): Promise<boolean> {
    if (this.state !== "idle") return false;
    this.state = "running";
    try {
      await this.plugin.deleteGoal(this.goalId);
      this.state = "settled";
      return true;
    } catch (error) {
      this.state = "idle";
      throw error;
    }
  }
}
