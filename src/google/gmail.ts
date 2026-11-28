/** The parts of the Gmail REST API the tools use. */
import { requestJson } from "../net/json-api";
import type { GoogleClient } from "./accounts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_BODY_CHARS = 4_000;

interface Part {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string };
  parts?: Part[];
}

interface Message {
  id: string;
  snippet?: string;
  payload?: Part;
}

export interface MailSummary {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

async function call<T>(client: GoogleClient, path: string, body?: unknown): Promise<T | null> {
  const token = await client.accounts.accessToken("google", client.accountId);
  return requestJson<T>(client.fetch, `${API}${path}`, {
    service: "Gmail",
    token,
    ...(body === undefined ? {} : { method: "POST" as const, body }),
  });
}

function header(message: Message, name: string): string {
  const found = message.payload?.headers?.find(
    (item) => item.name.toLowerCase() === name.toLowerCase(),
  );
  return found?.value ?? "";
}

function summary(message: Message): MailSummary {
  return {
    id: message.id,
    from: header(message, "From") || "(unknown sender)",
    subject: header(message, "Subject") || "(no subject)",
    date: header(message, "Date"),
    snippet: message.snippet ?? "",
  };
}

/** Newest messages matching a Gmail search, such as `is:unread in:inbox`. */
export async function searchMail(
  client: GoogleClient,
  query: string,
  count: number,
): Promise<MailSummary[]> {
  const found = await call<{ messages?: { id: string }[] }>(
    client,
    `/messages?maxResults=${count}&q=${encodeURIComponent(query)}`,
  );
  return Promise.all(
    (found?.messages ?? []).map(async ({ id }) => {
      const message = await call<Message>(
        client,
        `/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      );
      return summary(message ?? { id });
    }),
  );
}

export function decodeBase64Url(data: string): string {
  const binary = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function plainText(part: Part): string | null {
  if (part.mimeType === "text/plain" && part.body?.data) return decodeBase64Url(part.body.data);
  for (const child of part.parts ?? []) {
    const text = plainText(child);
    if (text) return text;
  }
  return null;
}

export async function readMail(
  client: GoogleClient,
  id: string,
): Promise<MailSummary & { body: string }> {
  const message = await call<Message>(client, `/messages/${encodeURIComponent(id)}?format=full`);
  if (!message) throw new Error("Gmail sent no message.");
  const text = (message.payload && plainText(message.payload)) || message.snippet || "";
  return {
    ...summary(message),
    body: text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}…(truncated)` : text,
  };
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

/** An RFC 2047 header value, so any subject is safe on one line. */
function encodedWords(text: string): string {
  const words: string[] = [];
  const characters = Array.from(text.replace(/[\r\n]+/g, " "));
  // 12 characters are at most 48 UTF-8 bytes, which fits one encoded word.
  for (let start = 0; start < characters.length; start += 12) {
    words.push(`=?UTF-8?B?${base64(characters.slice(start, start + 12).join(""))}?=`);
  }
  return words.join("\r\n ");
}

/** The message in the base64url form `messages.send` takes. `to` must be validated. */
export function rawMessage(to: string, subject: string, body: string): string {
  if (/[\r\n]/.test(to)) throw new Error("The recipient may not contain line breaks.");
  const encodedBody = base64(body).replace(/.{76}/g, "$&\r\n");
  const message = [
    `To: ${to}`,
    `Subject: ${encodedWords(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodedBody,
  ].join("\r\n");
  return base64(message).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sendMail(
  client: GoogleClient,
  to: string,
  subject: string,
  body: string,
): Promise<void> {
  await call(client, "/messages/send", { raw: rawMessage(to, subject, body) });
}
