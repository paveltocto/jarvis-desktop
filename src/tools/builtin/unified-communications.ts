import { InvalidInput } from "../../data/records";
import { requestJson } from "../../net/json-api";
import { askUser } from "../approval";
import { oneOf, optionalText, requiredText } from "../args";
import type { ToolContext, ToolDefinition } from "../types";
import { failureFrom, fail, ok } from "../types";

const PLATFORMS = ["telegram", "discord", "email"] as const;
const MAX_DISCORD_CHARS = 2_000;
const MAX_MESSAGE_CHARS = 4_000;

/** One address, with nothing that could add recipients or headers. */
export const EMAIL_ADDRESS = /^[^\s@,;<>"()?&#%]+@[^\s@,;<>"()?&#%]+\.[^\s@,;<>"()?&#%]+$/;

export const DISCORD_WEBHOOK = /^https:\/\/discord\.com\/api\/webhooks\/\d+\/[\w-]+$/;

async function discord(ctx: ToolContext, message: string) {
  const webhook = await ctx.secrets.get("discord_webhook_url");
  if (!webhook || !DISCORD_WEBHOOK.test(webhook)) {
    return fail(
      "failed",
      "Discord is not set up: the user can add a webhook URL in Settings › Services.",
    );
  }
  if (message.length > MAX_DISCORD_CHARS) {
    throw new InvalidInput(`Discord messages are at most ${MAX_DISCORD_CHARS} characters.`);
  }
  return askUser(ctx, {
    title: "Send this message to your Discord channel?",
    detail: message,
    confirmLabel: "Send",
    run: async () => {
      await requestJson(ctx.fetch, `${webhook}?wait=true`, {
        service: "Discord",
        method: "POST",
        // Mentions are disabled so a message cannot ping the whole server.
        body: { content: message, username: "JARVIS", allowed_mentions: { parse: [] } },
      });
      return "Discord message sent.";
    },
  });
}

/** Ported from legacy `unified_communications` and the missing `send_message`. */
export const unifiedCommunications: ToolDefinition = {
  name: "unified_communications",
  description:
    "Sends a message. 'telegram' goes to the user's own Telegram chat and 'discord' to their configured channel (neither can message other people); both ask the user to confirm first. 'email' only opens a draft in the default mail app, which the user sends themselves; use gmail_control to send from Gmail. WhatsApp is not available yet.",
  parameters: {
    type: "object",
    properties: {
      platform: { type: "string", enum: PLATFORMS },
      message: { type: "string" },
      recipient: { type: "string", description: "Email address, for email only." },
      subject: { type: "string", description: "For email only." },
    },
    required: ["platform", "message"],
  },
  platforms: ["macos", "windows", "linux", "other"],
  async execute(args, ctx) {
    try {
      const platform = oneOf(args.platform, PLATFORMS, "platform");
      const message = requiredText(args, "message", MAX_MESSAGE_CHARS);
      switch (platform) {
        case "telegram":
          return await askUser(ctx, {
            title: "Send this message to your Telegram chat?",
            detail: message,
            confirmLabel: "Send",
            run: async () => {
              await ctx.messaging.telegram(message);
              return "Telegram message sent.";
            },
          });
        case "discord":
          return await discord(ctx, message);
        case "email": {
          const recipient = requiredText(args, "recipient", 320);
          if (!EMAIL_ADDRESS.test(recipient)) {
            throw new InvalidInput("recipient must be one email address.");
          }
          const subject = optionalText(args, "subject") || "Message from JARVIS";
          await ctx.web.openUrl(
            `mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`,
          );
          return ok(
            `Opened an email draft to ${recipient} in the mail app. It has NOT been sent; the user must send it.`,
          );
        }
      }
    } catch (error) {
      return failureFrom(error);
    }
  },
};
