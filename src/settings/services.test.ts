import { describe, expect, it } from "vitest";
import { serviceProblem } from "./services";

describe("serviceProblem", () => {
  it("accepts empty and well-formed values", () => {
    expect(serviceProblem(new Map())).toBeNull();
    expect(
      serviceProblem(
        new Map([
          ["telegram_bot_token", "123:Ab_c-d"],
          ["telegram_chat_id", "42"],
          ["discord_webhook_url", "https://discord.com/api/webhooks/1/a-b_c"],
        ]),
      ),
    ).toBeNull();
  });

  it("explains a wrong value", () => {
    expect(serviceProblem(new Map([["telegram_chat_id", "@me"]]))).toContain("Telegram");
    expect(serviceProblem(new Map([["discord_webhook_url", "https://x.test"]]))).toContain(
      "Discord",
    );
  });
});
