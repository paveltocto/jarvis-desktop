/** The segmented tabs in Settings, following the ARIA tabs keyboard pattern. */

/** Tab to move to for a key press, or `null` when the key does not move between tabs. */
export function nextTabIndex(key: string, current: number, count: number): number | null {
  switch (key) {
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** Wires up a tab list and returns a function that selects a tab by its index. */
export function bindTabs(list: HTMLElement, onSelect: () => void): (index: number) => void {
  const tabs = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const select = (index: number) => {
    tabs.forEach((tab, position) => {
      const selected = position === index;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      const panel = document.getElementById(tab.getAttribute("aria-controls") ?? "");
      if (panel) panel.hidden = !selected;
    });
    onSelect();
  };
  tabs.forEach((tab, position) => {
    tab.addEventListener("click", () => select(position));
    tab.addEventListener("keydown", (event) => {
      const target = nextTabIndex(event.key, position, tabs.length);
      if (target === null) return;
      event.preventDefault();
      select(target);
      tabs[target]?.focus();
    });
  });
  return select;
}
