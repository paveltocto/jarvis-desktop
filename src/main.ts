import { getPlatformInfo } from "./platform";
import { createToolRegistry } from "./tools";

function renderPlatform(rows: Record<string, string>): void {
  const list = document.querySelector<HTMLDListElement>("#platform");
  if (!list) return;
  list.replaceChildren(
    ...Object.entries(rows).flatMap(([label, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      return [dt, dd];
    }),
  );
}

async function init(): Promise<void> {
  try {
    const info = await getPlatformInfo();
    renderPlatform({
      OS: info.os,
      Architecture: info.arch,
      Capabilities: info.capabilities.length > 0 ? info.capabilities.join(", ") : "none yet",
    });

    const tools = document.querySelector<HTMLUListElement>("#tools");
    tools?.replaceChildren(
      ...createToolRegistry()
        .declarations(info)
        .map((tool) => {
          const item = document.createElement("li");
          item.textContent = tool.name;
          return item;
        }),
    );
  } catch (error) {
    renderPlatform({ Status: `Backend unavailable: ${String(error)}` });
  }
}

window.addEventListener("DOMContentLoaded", () => void init());
