/** The accounts and keys shown in Settings › Services, and their checks. */
import { DISCORD_WEBHOOK } from "../tools/builtin/unified-communications";
import type { OAuthProvider } from "../tools/types";

/** Mirrors `MAX_ACCOUNTS` in `google_accounts.rs`. */
export const MAX_GOOGLE_ACCOUNTS = 5;

export type ServiceSecret =
  | "openrouter_api_key"
  | "deepseek_api_key"
  | "telegram_bot_token"
  | "telegram_chat_id"
  | "discord_webhook_url"
  | "google_client_id"
  | "google_client_secret"
  | "spotify_client_id";

export interface ServiceField {
  secret: ServiceSecret;
  label: string;
  /** An error message when the value cannot be right, else `null`. */
  check?(value: string): string | null;
}

export interface ServiceGroup {
  title: string;
  hint: string;
  fields: ServiceField[];
  /** Set when the group needs a sign-in after its fields are saved. */
  oauth?: OAuthProvider;
}

const matches = (pattern: RegExp, message: string) => (value: string) =>
  pattern.test(value) ? null : message;

export const SERVICE_GROUPS: readonly ServiceGroup[] = [
  {
    title: "Other AI models",
    hint: "For the second-opinion tool and Telegram chat.",
    fields: [
      { secret: "openrouter_api_key", label: "OpenRouter API key" },
      { secret: "deepseek_api_key", label: "DeepSeek API key" },
    ],
  },
  {
    title: "Telegram",
    hint: "Create a bot with @BotFather and send it a message. The chat id is your own numeric id.",
    fields: [
      {
        secret: "telegram_bot_token",
        label: "Bot token",
        check: matches(/^\d+:[\w-]+$/, "The bot token looks like 123456:ABC…"),
      },
      {
        secret: "telegram_chat_id",
        label: "Your chat id",
        check: matches(/^\d+$/, "The chat id of a private chat is a positive number."),
      },
    ],
  },
  {
    title: "Discord",
    hint: "A webhook URL of the channel JARVIS may post to.",
    fields: [
      {
        secret: "discord_webhook_url",
        label: "Webhook URL",
        check: matches(DISCORD_WEBHOOK, "Use a https://discord.com/api/webhooks/… URL."),
      },
    ],
  },
  {
    title: "Google (Gmail and Calendar)",
    hint: "Needs your own OAuth client of type “Desktop app”, with the Gmail and Calendar APIs enabled. One client serves all your accounts.",
    oauth: "google",
    fields: [
      { secret: "google_client_id", label: "Client ID" },
      { secret: "google_client_secret", label: "Client secret" },
    ],
  },
  {
    title: "Spotify",
    hint: "Needs your own Spotify app with the redirect URI http://127.0.0.1:43821/callback. Playback control needs Premium.",
    oauth: "spotify",
    fields: [{ secret: "spotify_client_id", label: "Client ID" }],
  },
];

/** The first problem among the typed values, or `null`. Empty fields are ignored. */
export function serviceProblem(values: ReadonlyMap<ServiceSecret, string>): string | null {
  for (const group of SERVICE_GROUPS) {
    for (const field of group.fields) {
      const value = values.get(field.secret);
      const problem = value ? field.check?.(value) : null;
      if (problem) return `${group.title}: ${problem}`;
    }
  }
  return null;
}
