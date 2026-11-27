import { activateProtocol } from "./builtin/activate-protocol";
import { getCurrentTime } from "./builtin/get-current-time";
import { goals } from "./builtin/goals";
import { jarvisUiControl } from "./builtin/jarvis-ui-control";
import { openApp } from "./builtin/open-app";
import { removeProtocolTool } from "./builtin/remove-protocol";
import { reminder } from "./builtin/reminder";
import { rulesEngine } from "./builtin/rules-engine";
import { saveProtocolTool } from "./builtin/save-protocol";
import { shutdownJarvis } from "./builtin/shutdown-jarvis";
import { saveMemory } from "./builtin/save-memory";
import { userProfile } from "./builtin/user-profile";
import { weatherReport } from "./builtin/weather-report";
import { browserControl } from "./builtin/browser-control";
import { documentCreator } from "./builtin/document-creator";
import { fileController } from "./builtin/file-controller";
import { gmailControl } from "./builtin/gmail-control";
import { googleCalendar } from "./builtin/google-calendar";
import { morningBrief } from "./builtin/morning-brief";
import { openrouterAgent } from "./builtin/openrouter-agent";
import { smartFileOrganizer } from "./builtin/smart-file-organizer";
import { spotifyControl } from "./builtin/spotify-control";
import { systemMonitor } from "./builtin/system-monitor";
import { unifiedCommunications } from "./builtin/unified-communications";
import { youtubeVideo } from "./builtin/youtube-video";
import { ToolRegistry } from "./registry";

/** Builds the registry with every tool that has been ported so far. */
export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(getCurrentTime)
    .register(openApp)
    .register(weatherReport)
    .register(saveMemory)
    .register(activateProtocol)
    .register(userProfile)
    .register(goals)
    .register(reminder)
    .register(shutdownJarvis)
    .register(saveProtocolTool)
    .register(removeProtocolTool)
    .register(jarvisUiControl)
    .register(rulesEngine)
    .register(browserControl)
    .register(documentCreator)
    .register(fileController)
    .register(gmailControl)
    .register(googleCalendar)
    .register(morningBrief)
    .register(openrouterAgent)
    .register(smartFileOrganizer)
    .register(spotifyControl)
    .register(systemMonitor)
    .register(unifiedCommunications)
    .register(youtubeVideo);
}
