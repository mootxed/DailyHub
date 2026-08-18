import { describe, expect, it, vi } from "vitest";
import { GoalDeletionAction, isDeleteGoalAvailable } from "../src/goal-deletion";

describe("goal editor deletion action", () => {
  it("is available only while the goal exists", () => {
    const plugin = { hasGoal: vi.fn((id: string) => id === "existing") };

    expect(isDeleteGoalAvailable(plugin, "existing")).toBe(true);
    expect(isDeleteGoalAvailable(plugin, "new-goal")).toBe(false);
  });

  it("does not delete when confirmation is cancelled", async () => {
    const deleteGoal = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined);
    const deletion = new GoalDeletionAction({ deleteGoal }, "wiki");

    deletion.cancel();

    await expect(deletion.confirm()).resolves.toBe(false);
    expect(deleteGoal).not.toHaveBeenCalled();
  });

  it("deletes the goal exactly once after confirmation", async () => {
    const deleteGoal = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined);
    const deletion = new GoalDeletionAction({ deleteGoal }, "wiki");

    const firstConfirmation = deletion.confirm();
    const duplicateConfirmation = deletion.confirm();

    await expect(firstConfirmation).resolves.toBe(true);
    await expect(duplicateConfirmation).resolves.toBe(false);
    expect(deleteGoal).toHaveBeenCalledTimes(1);
    expect(deleteGoal).toHaveBeenCalledWith("wiki");
  });
});
