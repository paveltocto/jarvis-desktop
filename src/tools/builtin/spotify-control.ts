import { InvalidInput } from "../../data/records";
import * as spotify from "../../spotify/api";
import { oneOf, optionalText, requiredText } from "../args";
import type { ToolDefinition } from "../types";
import { failureFrom, fail, ok } from "../types";

const ACTIONS = ["play", "pause", "next", "previous", "volume", "current", "queue"] as const;

/** Ported from legacy `spotify_control`. The legacy keyboard fallback is not ported. */
export const spotifyControl: ToolDefinition = {
  name: "spotify_control",
  description:
    "Controls Spotify through the user's account (playback control needs Spotify Premium). Actions: 'play' (with a query to play something, without one to resume), 'pause', 'next', 'previous', 'volume' (value 0-100), 'current' (what is playing) and 'queue' (adds a track).",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ACTIONS },
      query: { type: "string", description: "Song, artist, album or playlist." },
      type: {
        type: "string",
        enum: spotify.SEARCH_TYPES,
        description: "What the query names. Defaults to track.",
      },
      value: { type: "string", description: "Volume from 0 to 100." },
    },
    required: ["action"],
  },
  platforms: ["macos", "windows", "linux", "other"],
  async execute(args, ctx) {
    try {
      const action = oneOf(args.action, ACTIONS);
      switch (action) {
        case "play": {
          const query = optionalText(args, "query");
          if (!query) {
            await spotify.play(ctx, null, "track");
            return ok("Resumed Spotify.");
          }
          const type = oneOf(args.type ?? "track", spotify.SEARCH_TYPES, "type");
          const item = await spotify.search(ctx, query, type);
          if (!item) return fail("failed", `Spotify found no ${type} for "${query}".`);
          await spotify.play(ctx, item, type);
          return ok(`Playing ${spotify.describeItem(item)} on Spotify.`);
        }
        case "queue": {
          const query = requiredText(args, "query", 200);
          const item = await spotify.search(ctx, query, "track");
          if (!item) return fail("failed", `Spotify found no track for "${query}".`);
          await spotify.queue(ctx, item);
          return ok(`Added ${spotify.describeItem(item)} to the queue.`);
        }
        case "volume": {
          const text = String(args.value ?? "")
            .replace("%", "")
            .trim();
          const percent = Number(text);
          if (!text || !Number.isInteger(percent) || percent < 0 || percent > 100) {
            throw new InvalidInput("value must be a whole number from 0 to 100.");
          }
          await spotify.setVolume(ctx, percent);
          return ok(`Spotify volume set to ${percent}%.`);
        }
        case "current": {
          const now = await spotify.current(ctx);
          if (!now) return ok("Nothing is playing on Spotify.");
          return ok(`${now.playing ? "Playing" : "Paused"}: ${spotify.describeItem(now.item)}.`);
        }
        case "pause":
          await spotify.pause(ctx);
          return ok("Paused Spotify.");
        case "next":
          await spotify.next(ctx);
          return ok("Skipped to the next track.");
        case "previous":
          await spotify.previous(ctx);
          return ok("Went back to the previous track.");
      }
    } catch (error) {
      return failureFrom(error);
    }
  },
};
