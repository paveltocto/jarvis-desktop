import { oneOf, requiredText } from "../args";
import type { ToolDefinition } from "../types";
import { failureFrom, ok } from "../types";

const resultsUrl = (query: string) =>
  `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;

/** Ported from legacy `youtube_video` (actions/youtube_video.py). */
export const youtubeVideo: ToolDefinition = {
  name: "youtube_video",
  description:
    "Opens YouTube in the default browser. Action 'play' opens the first video found for the query; 'search' opens the list of results.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["play", "search"] },
      query: { type: "string", description: "What to look for." },
    },
    required: ["query"],
  },
  platforms: ["macos", "windows", "linux", "other"],
  async execute(args, ctx) {
    try {
      const query = requiredText(args, "query", 200);
      const action = oneOf(args.action ?? "play", ["play", "search"]);
      const video = action === "play" ? await ctx.web.youtubeSearch(query) : null;
      await ctx.web.openUrl(video ?? resultsUrl(query));
      if (video) return ok(`Opened the first YouTube video for "${query}": ${video}`);
      return ok(
        action === "play"
          ? `Could not pick a video, so opened the YouTube results for "${query}". Nothing is playing yet.`
          : `Opened the YouTube results for "${query}".`,
      );
    } catch (error) {
      return failureFrom(error);
    }
  },
};
