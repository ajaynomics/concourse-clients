import { keyText, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { clean } from "./format.ts";

export const DISPLAY_FILE = "display.json";
export interface Display { collapse: boolean }

// The model always receives the full message; collapsing only changes what the transcript draws.
// Collapsed: the provenance header and the first line the peer wrote.
// Both are peer-controlled, so terminal controls are replaced, as for the model.
export function summary(content: unknown): string {
  const lines = clean(typeof content === "string" ? content : "").split("\n");
  const header = lines[0].replace(/^A2A /, "").trim() || "message";
  const preview = lines.slice(1).map(l => l.trim()).find(l => /^> ?\S/.test(l))?.replace(/^> ?/, "");
  return preview ? `${header} · "${preview.slice(0, 100)}${preview.length > 100 ? "…" : ""}"` : header;
}

export function mailRenderer(display: () => Display): MessageRenderer {
  return (message, { expanded, outputPad }, theme) => {
    if (expanded || !display().collapse) return undefined;
    let key = "ctrl+o";
    try { key = keyText("app.tools.expand") || key; } catch { /* keybindings not initialised outside the TUI */ }
    const box = new Box(outputPad, 0, t => theme.bg("customMessageBg", t));
    const profile = (message.details as { profile?: unknown } | undefined)?.profile;
    box.addChild(new Text(`${theme.fg("customMessageLabel", "[concourse]")} ${typeof profile === "string" ? `${profile} · ` : ""}${summary(message.content)} ${theme.fg("dim", `(${key} to expand)`)}`, 0, 0));
    return box;
  };
}
