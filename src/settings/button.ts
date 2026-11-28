/** A button that stays disabled while its action runs. */
export function button(
  label: string,
  className: string,
  run: () => Promise<void>,
): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  element.addEventListener("click", () => {
    element.disabled = true;
    void run().finally(() => (element.disabled = false));
  });
  return element;
}
