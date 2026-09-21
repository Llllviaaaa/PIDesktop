import { useState } from "react";

/**
 * Run `sync` during render on the first render and whenever `deps` change.
 *
 * This is the render-time replacement for
 *
 *   useEffect(() => { setSomething(...) }, deps);
 *
 * It fires at exactly the same moments as that effect — mount, then each
 * change of a dependency — but updates state in the render that saw the
 * change. The effect version commits one frame with the stale state and
 * then renders again, which is what react-hooks/set-state-in-effect flags.
 *
 * `sync` may only set state owned by the calling component. It must not
 * touch refs, the DOM, timers or anything outside React; keep those in an
 * effect.
 */
export function useSyncOnChange(deps: readonly unknown[], sync: () => void): void {
  const [seen, setSeen] = useState<readonly unknown[] | null>(null);
  const changed = seen === null
    || seen.length !== deps.length
    || deps.some((value, index) => !Object.is(value, seen[index]));
  if (changed) {
    setSeen(deps);
    sync();
  }
}
