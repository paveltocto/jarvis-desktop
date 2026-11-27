/**
 * Questions waiting for the user's answer, shown one at a time. Nothing runs
 * unless the user confirms that particular question.
 */
import type { Approval, ApprovalsApi } from "../tools/types";

export const MAX_PENDING = 5;

export interface ApprovalOutcome {
  ok: boolean;
  text: string;
}

export interface ApprovalView {
  /** Shows a question with the number waiting behind it, or hides when `null`. */
  show(approval: Approval | null, waiting: number): void;
  report(outcome: ApprovalOutcome): void;
}

export class ApprovalQueue implements ApprovalsApi {
  readonly #pending: Approval[] = [];

  constructor(private readonly view: ApprovalView) {}

  async request(approval: Approval): Promise<void> {
    if (this.#pending.length >= MAX_PENDING) {
      throw new Error("Too many questions are already waiting for the user.");
    }
    this.#pending.push(approval);
    this.#update();
  }

  /**
   * Runs the question on screen. The caller passes the one the user saw, so a
   * second click cannot confirm the next question by accident.
   */
  async confirm(seen: Approval): Promise<void> {
    if (!this.#take(seen)) return;
    try {
      this.view.report({ ok: true, text: await seen.run() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.view.report({ ok: false, text: `Not done: ${message}` });
    }
  }

  cancel(seen: Approval): void {
    this.#take(seen);
  }

  #take(seen: Approval): boolean {
    if (this.#pending[0] !== seen) return false;
    this.#pending.shift();
    this.#update();
    return true;
  }

  #update(): void {
    this.view.show(this.#pending[0] ?? null, Math.max(0, this.#pending.length - 1));
  }
}
