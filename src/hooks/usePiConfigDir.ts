import { usePiStore } from "../store";

/** Where Pi keeps providers, keys and add-ons right now, in the form the UI shows paths. */
export function usePiConfigDir(): { dir: string; shared: boolean } {
  const separate = usePiStore((state) => Boolean(state.settings?.separatePiConfig));
  return separate
    ? { dir: "%APPDATA%/pid-desktop/pi-agent", shared: false }
    : { dir: "~/.pi/agent", shared: true };
}
