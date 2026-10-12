/**
 * The list of open terminal tabs, without xterm.
 *
 * terminalSessions.ts owns the xterm instances and publishes their tab info
 * here, so light consumers (the task summary) can show running terminals
 * without pulling xterm into the main bundle.
 */
import { sameLocalPath } from "./pathIdentity";

export type TerminalStatus = "starting" | "running" | "exited" | "error";

export interface TerminalTabInfo {
  id: string;
  cwd: string;
  shell: string;
  title: string;
  status: TerminalStatus;
  /** The shell printed while no view showed this tab; cleared when one does. */
  unseenOutput?: boolean;
}

const subscribers = new Set<() => void>();
let tabs: TerminalTabInfo[] = [];

export function publishTerminalTabs(next: TerminalTabInfo[]) {
  tabs = next;
  for (const subscriber of subscribers) subscriber();
}

export function subscribeTerminalTabs(listener: () => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

export function terminalTabsSnapshot(): TerminalTabInfo[] {
  return tabs;
}

export function terminalTabsFor(list: TerminalTabInfo[], cwd: string): TerminalTabInfo[] {
  return list.filter((tab) => sameLocalPath(tab.cwd, cwd));
}

/** What the topbar's terminal toggle reports while the panel is hidden. */
export function backgroundTerminalsFor(list: TerminalTabInfo[], cwd: string): { count: number; unseenOutput: boolean } {
  const tabs = cwd ? terminalTabsFor(list, cwd) : [];
  return { count: tabs.length, unseenOutput: tabs.some((tab) => tab.unseenOutput) };
}
