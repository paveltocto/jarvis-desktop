/** The parts of the Spotify Web API the tool uses. Playback control needs Premium. */
import { ApiError, requestJson } from "../net/json-api";
import type { ToolContext } from "../tools/types";

const API = "https://api.spotify.com/v1";

type Client = Pick<ToolContext, "fetch" | "accounts">;

export type SearchType = "track" | "artist" | "album" | "playlist";
export const SEARCH_TYPES: readonly SearchType[] = ["track", "artist", "album", "playlist"];

interface Item {
  uri: string;
  name: string;
  artists?: { name: string }[];
}

interface Device {
  id: string | null;
  is_active: boolean;
  is_restricted: boolean;
}

async function call<T>(
  client: Client,
  path: string,
  method: "GET" | "POST" | "PUT" = "GET",
  body?: unknown,
): Promise<T | null> {
  const token = await client.accounts.accessToken("spotify");
  try {
    return await requestJson<T>(client.fetch, `${API}${path}`, {
      service: "Spotify",
      token,
      method,
      ...(body === undefined ? {} : { body }),
    });
  } catch (error) {
    if (error instanceof ApiError && error.reason === "PREMIUM_REQUIRED") {
      throw new Error("Spotify only allows playback control with Premium.", { cause: error });
    }
    if (error instanceof ApiError && error.reason === "NO_ACTIVE_DEVICE") {
      throw new Error("No active Spotify device. Open Spotify and play something once.", {
        cause: error,
      });
    }
    throw error;
  }
}

export const describeItem = (item: Item): string =>
  item.artists?.length
    ? `"${item.name}" by ${item.artists.map((artist) => artist.name).join(", ")}`
    : `"${item.name}"`;

export async function search(
  client: Client,
  query: string,
  type: SearchType,
): Promise<Item | null> {
  const params = new URLSearchParams({ q: query, type, limit: "5" });
  const result = await call<Record<string, { items?: (Item | null)[] }>>(
    client,
    `/search?${params}`,
  );
  // Spotify sometimes returns null entries.
  return result?.[`${type}s`]?.items?.find((item) => item !== null) ?? null;
}

/** `?device_id=…` for an idle device when none is playing, else nothing. */
async function target(client: Client): Promise<string> {
  const result = await call<{ devices?: Device[] }>(client, "/me/player/devices");
  const usable = (result?.devices ?? []).filter((device) => device.id && !device.is_restricted);
  if (usable.length === 0) {
    throw new Error("No Spotify device found. Open Spotify on this computer or a phone first.");
  }
  if (usable.some((device) => device.is_active)) return "";
  return `?device_id=${encodeURIComponent(usable[0]?.id ?? "")}`;
}

/** Plays a search result, or resumes when `item` is `null`. */
export async function play(client: Client, item: Item | null, type: SearchType): Promise<void> {
  const body =
    item === null ? undefined : type === "track" ? { uris: [item.uri] } : { context_uri: item.uri };
  await call(client, `/me/player/play${await target(client)}`, "PUT", body);
}

export const pause = (client: Client) => call(client, "/me/player/pause", "PUT");
export const next = (client: Client) => call(client, "/me/player/next", "POST");
export const previous = (client: Client) => call(client, "/me/player/previous", "POST");
export const setVolume = (client: Client, percent: number) =>
  call(client, `/me/player/volume?volume_percent=${percent}`, "PUT");

export const queue = async (client: Client, item: Item) =>
  call(client, `/me/player/queue?uri=${encodeURIComponent(item.uri)}`, "POST");

export async function current(client: Client): Promise<{ playing: boolean; item: Item } | null> {
  const result = await call<{ is_playing?: boolean; item?: Item | null }>(
    client,
    "/me/player/currently-playing",
  );
  return result?.item ? { playing: result.is_playing === true, item: result.item } : null;
}
