/**
 * Stand-in for `@deepseek-ai/dsh-client-shortcuts/client`: the command
 * registry behind `ctx.shortcuts`. Commands declare default bindings per
 * platform profile and resolve against the focused region; PIDesktop is a
 * Windows desktop app, so the `desktop:windows` profile applies, with no
 * user rebinding.
 */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

export type ShortcutCommandId = Branded<'ShortcutCommandId'>
export type ShortcutModifier = 'primary' | 'control' | 'alt' | 'shift' | 'meta'
export type ShortcutProfile = 'desktop:macos' | 'desktop:windows' | 'desktop:linux' | 'web:macos' | 'web:windows' | 'web:linux'
export type ShortcutPlatform = 'macos' | 'windows' | 'linux'
export type ShortcutRuntime = 'desktop' | 'web'

/** A key chord: a physical key code plus modifiers. */
export interface ShortcutBinding {
  readonly code: string
  readonly secondCode?: string
  readonly modifiers: readonly ShortcutModifier[]
}

export type NormalizedBinding = ShortcutBinding
export type BindingIssue = string
export type ShortcutRegion = 'page' | 'editable' | 'terminal'

export interface ShortcutContext {
  readonly source?: 'keyboard' | 'menu' | 'iframe' | 'webview'
  readonly region: ShortcutRegion
  readonly modal: string | null
  readonly target: Element | null
}

export type ShortcutResolution = { status: 'handled'; run(): void }
  | { status: 'blocked'; reason: string }
  | { status: 'pass' }

export interface ShortcutCommand {
  readonly id: ShortcutCommandId
  readonly label: () => string
  readonly aliases: readonly string[]
  readonly defaults: Readonly<Partial<Record<ShortcutProfile, ShortcutBinding>>>
  readonly regions: readonly ShortcutRegion[]
  readonly modals: readonly string[]
  resolve(context: ShortcutContext): ShortcutResolution
}

export interface ShortcutCatalogEntry {
  readonly id: ShortcutCommandId
  readonly label: string
  readonly aliases: readonly string[]
  /** Display keys, e.g. `['Ctrl', 'Alt', 'B']`. */
  readonly keys: readonly string[]
  readonly aria: string | undefined
  readonly binding: NormalizedBinding | null
  readonly modified: boolean
  readonly conflicts: readonly ShortcutCommandId[]
  readonly issue: BindingIssue | null
}

export interface Shortcuts {
  readonly runtime: ShortcutRuntime
  readonly platform: ShortcutPlatform
  readonly catalog: ObservableSnapshot<readonly ShortcutCatalogEntry[]>
  register(command: ShortcutCommand): () => void
  describeBinding(binding: ShortcutBinding | null): {
    binding: NormalizedBinding | null
    keys: readonly string[]
    issue: BindingIssue | null
    conflicts: readonly ShortcutCommandId[]
  }
  closeWindow(): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    shortcuts: Shortcuts
  }
}

const PROFILE: ShortcutProfile = 'desktop:windows'

const KEY_NAMES: Record<string, string> = {
  Backslash: '\\', Slash: '/', Period: '.', Comma: ',', Semicolon: ';', Quote: "'",
  BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`',
  Enter: 'Enter', Escape: 'Esc', Space: 'Space', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
}

function keyName(code: string): string {
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  return KEY_NAMES[code] ?? code
}

/** Display keys of a binding on Windows. */
export function bindingKeys(binding: ShortcutBinding | null): string[] {
  if (binding === null) return []
  const keys: string[] = []
  const mods = new Set(binding.modifiers)
  if (mods.has('primary') || mods.has('control')) keys.push('Ctrl')
  if (mods.has('alt')) keys.push('Alt')
  if (mods.has('shift')) keys.push('Shift')
  if (mods.has('meta')) keys.push('Win')
  keys.push(keyName(binding.code))
  if (binding.secondCode !== undefined) keys.push(keyName(binding.secondCode))
  return keys
}

function regionOf(target: Element | null): ShortcutRegion {
  if (target?.closest('.xterm') != null) return 'terminal'
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return 'editable'
  if (target instanceof HTMLElement && target.isContentEditable) return 'editable'
  return 'page'
}

function matches(binding: ShortcutBinding, event: KeyboardEvent): boolean {
  if (binding.secondCode !== undefined || binding.code !== event.code) return false
  const mods = new Set(binding.modifiers)
  const ctrl = mods.has('primary') || mods.has('control')
  return ctrl === event.ctrlKey && mods.has('alt') === event.altKey
    && mods.has('shift') === event.shiftKey && mods.has('meta') === event.metaKey
}

/** The registry plus one capture-phase keydown listener that runs matching commands. */
export class HostShortcuts implements Shortcuts {
  readonly runtime: ShortcutRuntime = 'desktop'
  readonly platform: ShortcutPlatform = 'windows'
  private readonly commands = new Map<ShortcutCommandId, ShortcutCommand>()
  private readonly listeners = new Set<() => void>()
  private entries: readonly ShortcutCatalogEntry[] = []

  readonly catalog: ObservableSnapshot<readonly ShortcutCatalogEntry[]> = {
    getSnapshot: () => this.entries,
    subscribe: (listener) => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }

  /**
   * @param closeWindowImpl - closes the app window.
   */
  constructor(private readonly closeWindowImpl: () => Promise<void>) {}

  register(command: ShortcutCommand): () => void {
    if (this.commands.has(command.id)) throw new Error(`shortcut ${command.id} is already registered`)
    this.commands.set(command.id, command)
    this.publish()
    return () => {
      if (this.commands.get(command.id) !== command) return
      this.commands.delete(command.id)
      this.publish()
    }
  }

  describeBinding(binding: ShortcutBinding | null) {
    return { binding, keys: bindingKeys(binding), issue: null, conflicts: [] }
  }

  closeWindow(): Promise<void> {
    return this.closeWindowImpl()
  }

  /**
   * Run the command bound to this key press, if one handles it.
   * @param event - the keydown event.
   * @returns whether a command ran.
   */
  dispatch(event: KeyboardEvent): boolean {
    if (event.isComposing || event.repeat) return false
    const target = event.target instanceof Element ? event.target : null
    const context: ShortcutContext = { source: 'keyboard', region: regionOf(target), modal: null, target }
    for (const command of this.commands.values()) {
      const binding = command.defaults[PROFILE]
      if (binding === undefined || !matches(binding, event)) continue
      if (!command.regions.includes(context.region)) continue
      const resolution = command.resolve(context)
      if (resolution.status === 'pass') continue
      event.preventDefault()
      event.stopPropagation()
      if (resolution.status === 'handled') resolution.run()
      return true
    }
    return false
  }

  /** Listen for key presses on the window. */
  listen(): () => void {
    const onKeyDown = (event: KeyboardEvent): void => { this.dispatch(event) }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }

  private publish(): void {
    this.entries = [...this.commands.values()].map((command) => {
      const binding = command.defaults[PROFILE] ?? null
      const keys = bindingKeys(binding)
      return {
        id: command.id,
        label: command.label(),
        aliases: command.aliases,
        keys,
        aria: keys.length > 0 ? keys.join('+') : undefined,
        binding,
        modified: false,
        conflicts: [],
        issue: null,
      }
    })
    for (const listener of [...this.listeners]) listener()
  }
}
