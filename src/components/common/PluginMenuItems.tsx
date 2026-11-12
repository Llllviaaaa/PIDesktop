import {
  useClientContributions,
  type ClientMenuContextMap,
  type ClientMenuItemContribution,
  type ClientMenuItemFor,
  type ClientMenuLocation,
} from "../../lib/clientContributions";
import { recordClientRenderError } from "../../lib/clientPluginRuntime";
import { runPluginCallback } from "../../lib/pluginKeybindings";

/** Evaluate a plugin predicate; a throw counts as `fallback` and is reported against the plugin. */
function safePredicate<C>(
  item: { id: string; pluginId?: string },
  predicate: ((context: C) => boolean) | undefined,
  context: C,
  fallback: boolean,
): boolean {
  if (predicate === undefined) return fallback;
  try {
    return predicate(context);
  } catch (error) {
    recordClientRenderError(item.pluginId, `menu:${item.id}`, error);
    return !fallback;
  }
}

/** Visible plugin items for `location`, already filtered through each item's `when`. */
export function visibleMenuItems<L extends ClientMenuLocation>(
  items: readonly ClientMenuItemContribution[],
  location: L,
  context: ClientMenuContextMap[L],
): ClientMenuItemFor<L>[] {
  // Items are keyed by `location`, so each one matching `location` is a `ClientMenuItemFor<L>`.
  const atLocation = items.filter((item) => item.location === location) as readonly unknown[] as readonly ClientMenuItemFor<L>[];
  return atLocation.filter((item) => safePredicate(item, item.when, context, true));
}

export interface PluginMenuItemsProps<L extends ClientMenuLocation> {
  location: L;
  context: ClientMenuContextMap[L];
  /** Close the host menu; called before the item's `onSelect`. */
  onClose: () => void;
  /** Class for a separator drawn before the items (none when omitted). */
  separatorClassName?: string;
  /** Class for each item button (the host menu's own item class, if it has one). */
  itemClassName?: string;
  /** Keep an empty icon cell for icon-less items, for menus laid out as an icon/label grid. */
  reserveIconSlot?: boolean;
}

/**
 * Plugin items for one host menu (`ctx.contributions.registerMenuItem`).
 * Renders nothing when no item targets `location`, so host menus look
 * unchanged without plugins. `when`, `disabled` and `onSelect` run guarded:
 * a throw hides or greys out the item and is reported as the plugin's `clientError`.
 * Items are host chrome, so they deliberately sit outside the plugin's
 * `[data-qj-plugin]` style scope.
 */
export function PluginMenuItems<L extends ClientMenuLocation>({
  location,
  context,
  onClose,
  separatorClassName,
  itemClassName,
  reserveIconSlot = false,
}: PluginMenuItemsProps<L>) {
  const { menuItems } = useClientContributions();
  const items = visibleMenuItems(menuItems, location, context);
  if (items.length === 0) return null;
  return (
    <>
      {separatorClassName !== undefined && <div className={separatorClassName} role="separator" />}
      {items.map((item) => {
        const disabled = safePredicate(item, item.disabled, context, false);
        const classes = [itemClassName, item.danger === true ? "danger" : ""].filter(Boolean).join(" ");
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={classes || undefined}
            disabled={disabled}
            data-qj-contributed-by={item.pluginId ?? "builtin"}
            data-qj-menu-item={item.id}
            onClick={() => {
              onClose();
              runPluginCallback(item.pluginId, `menu:${item.id}`, () => item.onSelect(context));
            }}
          >
            {item.icon ?? (reserveIconSlot ? <span className="qj-plugin-menu-icon" aria-hidden="true" /> : null)}
            <span>{item.label}</span>
            {item.shortcut !== undefined && item.shortcut !== "" && <kbd className="qj-plugin-menu-shortcut">{item.shortcut}</kbd>}
          </button>
        );
      })}
    </>
  );
}

/** True when at least one plugin item targets `location` (used to show the optional "工具" menu). */
export function hasMenuItems(items: readonly ClientMenuItemContribution[], location: ClientMenuLocation): boolean {
  return items.some((item) => item.location === location);
}
