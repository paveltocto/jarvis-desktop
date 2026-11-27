import type { Approval, ToolContext, ToolResult } from "./types";
import { ok } from "./types";

/**
 * Asks the user and returns a result that cannot be mistaken for success:
 * nothing has happened until they confirm.
 */
export async function askUser(ctx: ToolContext, approval: Approval): Promise<ToolResult> {
  await ctx.approvals.request(approval);
  return ok(
    `NOT done yet. Asked the user to confirm in the JARVIS window: "${approval.title}". It happens only if they confirm, and you will not be told their answer. Tell the user to check the window.`,
  );
}
