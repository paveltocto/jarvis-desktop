import { describe, expect, it, vi } from "vitest";
import type { Approval } from "../tools/types";
import { ApprovalQueue, MAX_PENDING } from "./queue";

function setup() {
  const view = { show: vi.fn(), report: vi.fn() };
  return { view, queue: new ApprovalQueue(view) };
}

const approval = (run = vi.fn().mockResolvedValue("sent")): Approval => ({
  title: "Send?",
  detail: "hi",
  confirmLabel: "Send",
  run,
});

describe("ApprovalQueue", () => {
  it("runs nothing until the user confirms", async () => {
    const { view, queue } = setup();
    const item = approval();
    await queue.request(item);
    expect(item.run).not.toHaveBeenCalled();
    await queue.confirm(item);
    expect(item.run).toHaveBeenCalledOnce();
    expect(view.report).toHaveBeenCalledWith({ ok: true, text: "sent" });
  });

  it("never runs a cancelled question", async () => {
    const { queue } = setup();
    const item = approval();
    await queue.request(item);
    queue.cancel(item);
    await queue.confirm(item);
    expect(item.run).not.toHaveBeenCalled();
  });

  it("does not let a repeated click confirm the next question", async () => {
    const { queue } = setup();
    const first = approval();
    const second = approval();
    await queue.request(first);
    await queue.request(second);
    await Promise.all([queue.confirm(first), queue.confirm(first)]);
    expect(first.run).toHaveBeenCalledOnce();
    expect(second.run).not.toHaveBeenCalled();
  });

  it("reports a failure and limits how many questions wait", async () => {
    const { view, queue } = setup();
    const failing = approval(vi.fn().mockRejectedValue(new Error("offline")));
    await queue.request(failing);
    for (let i = 1; i < MAX_PENDING; i++) await queue.request(approval());
    await expect(queue.request(approval())).rejects.toThrow("Too many");
    await queue.confirm(failing);
    expect(view.report).toHaveBeenCalledWith({ ok: false, text: "Not done: offline" });
  });
});
