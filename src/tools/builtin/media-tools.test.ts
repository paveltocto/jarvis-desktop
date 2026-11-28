import { describe, expect, it, vi } from "vitest";
import { testContext } from "../testing/context";
import { browserControl } from "./browser-control";
import { openrouterAgent } from "./openrouter-agent";
import { spotifyControl } from "./spotify-control";
import { systemMonitor } from "./system-monitor";
import { youtubeVideo } from "./youtube-video";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const connected = { ...testContext().accounts, accessToken: async () => "token" };

describe("youtube_video", () => {
  it("does not claim to play when no video was found", async () => {
    const openUrl = vi.fn().mockResolvedValue(undefined);
    const result = await youtubeVideo.execute(
      { query: "lo fi" },
      testContext({ web: { ...testContext().web, openUrl, youtubeSearch: async () => null } }),
    );
    expect(openUrl).toHaveBeenCalledWith("https://www.youtube.com/results?search_query=lo%20fi");
    expect(result).toMatchObject({ output: expect.stringContaining("Nothing is playing") });
  });

  it("fails when the browser cannot be opened", async () => {
    const result = await youtubeVideo.execute({ query: "x", action: "search" }, testContext());
    expect(result.ok).toBe(false);
  });
});

describe("browser_control", () => {
  it("passes a checked request to the backend", async () => {
    const browser = vi.fn().mockResolvedValue("Scrolled.");
    await browserControl.execute(
      { action: "scroll" },
      testContext({ web: { ...testContext().web, browser } }),
    );
    expect(browser).toHaveBeenCalledWith({ action: "scroll", direction: "down" });
  });

  it("requires what each action needs", async () => {
    const result = await browserControl.execute({ action: "go_to" }, testContext());
    expect(result).toMatchObject({ ok: false, code: "invalid_arguments" });
  });
});

describe("system_monitor", () => {
  it("formats the backend figures", async () => {
    const stats = vi.fn().mockResolvedValue({
      cpuPercent: 12.4,
      memoryUsedBytes: 8 * 1024 ** 3,
      memoryTotalBytes: 16 * 1024 ** 3,
      disks: [{ mountPoint: "/", totalBytes: 500 * 1024 ** 3, freeBytes: 100 * 1024 ** 3 }],
      processes: [],
    });
    const result = await systemMonitor.execute(
      { action: "status" },
      testContext({ system: { ...testContext().system, stats } }),
    );
    expect(result).toMatchObject({
      output: "CPU: 12%. Memory: 8.0 GB of 16.0 GB used.\nDisk /: 100.0 GB free of 500.0 GB",
    });
  });
});

describe("openrouter_agent", () => {
  it("fails without a key", async () => {
    const result = await openrouterAgent.execute({ query: "why" }, testContext());
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Settings") });
  });

  it("uses whichever provider has a key", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ choices: [{ message: { content: "42" } }] }));
    const result = await openrouterAgent.execute(
      { query: "why" },
      testContext({
        fetch,
        secrets: { get: async (name) => (name === "deepseek_api_key" ? "k" : null) },
      }),
    );
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.deepseek.com/chat/completions");
    expect(result).toMatchObject({ output: "DeepSeek answered:\n42" });
  });
});

describe("spotify_control", () => {
  it("picks an idle device when nothing is playing", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json({ tracks: { items: [null, { uri: "spotify:track:1", name: "Song" }] } }),
      )
      .mockResolvedValueOnce(
        json({ devices: [{ id: "mac", is_active: false, is_restricted: false }] }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const result = await spotifyControl.execute(
      { action: "play", query: "song" },
      testContext({ fetch, accounts: connected }),
    );
    expect(fetch.mock.calls[2]?.[0]).toBe(
      "https://api.spotify.com/v1/me/player/play?device_id=mac",
    );
    expect(result).toMatchObject({ ok: true, output: 'Playing "Song" on Spotify.' });
  });

  it("explains that playback control needs Premium", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(json({ error: { message: "no", reason: "PREMIUM_REQUIRED" } }, 403));
    const result = await spotifyControl.execute(
      { action: "pause" },
      testContext({ fetch, accounts: connected }),
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Premium") });
  });

  it("rejects a volume that is not 0 to 100", async () => {
    for (const value of ["", "loud", "140"]) {
      const result = await spotifyControl.execute({ action: "volume", value }, testContext());
      expect(result).toMatchObject({ ok: false, code: "invalid_arguments" });
    }
  });
});
