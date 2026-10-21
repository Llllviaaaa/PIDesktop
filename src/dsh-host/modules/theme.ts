/**
 * Stand-in for `@deepseek-ai/dsh-client-ui-theme/client`: the theme snapshot
 * behind `ctx.theme`. PIDesktop owns the appearance (its own Settings); this
 * mirrors the light/dark choice into DSH's vocabulary and, as DSH's frame
 * does, projects it onto `<body>`: `data-ds-dark-theme` switches the token
 * sheets in src/dsh/theme, and the font-size variables size DSH content.
 */
import type { Context } from '@deepseek-ai/cordis'

export type ThemePreference = 'light' | 'dark' | 'system'
export type FontRole = 'text' | 'code' | 'terminal'
export type FontSizes = Readonly<Record<FontRole, number>>
export type FontFamilies = Readonly<Record<FontRole, string>>
export type ThemeTokens = Record<string, string>

export interface ThemeDefinition {
  id: string
  colorScheme: 'light' | 'dark'
  tokens: ThemeTokens
}

export interface ThemeSnapshot {
  /** The persisted preference (may be `system`). */
  preference: ThemePreference
  /** Integer px font sizes by role. */
  fontSizes: FontSizes
  /** User font lists by role; `''` selects the role's built-in stack. */
  fontFamilies: FontFamilies
  active: ThemeDefinition
  themes: readonly ThemeDefinition[]
  /** Monotonic change counter. */
  revision: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    theme: HostTheme
  }
  interface Events {
    /** Theme state changed. */
    'theme/change'(snapshot: ThemeSnapshot): void
  }
}

const THEMES: readonly ThemeDefinition[] = Object.freeze([
  Object.freeze({ id: 'light', colorScheme: 'light' as const, tokens: {} }),
  Object.freeze({ id: 'dark', colorScheme: 'dark' as const, tokens: {} }),
])

/** DSH's default sizes (theme-settings.ts FONT_SIZE_SPECS); PIDesktop's conversation text is 14px too. */
const FONT_SIZES: FontSizes = Object.freeze({ text: 14, code: 11, terminal: 13 })
const FONT_FAMILIES: FontFamilies = Object.freeze({ text: '', code: '', terminal: '' })

export class HostTheme {
  private snapshot: ThemeSnapshot

  constructor(private readonly ctx: Context, colorScheme: 'light' | 'dark') {
    this.snapshot = this.make(colorScheme, 0)
    this.present()
  }

  getTheme(): ThemeSnapshot {
    return this.snapshot
  }

  /**
   * Follow PIDesktop's appearance.
   * @param colorScheme - the scheme PIDesktop is showing.
   */
  setColorScheme(colorScheme: 'light' | 'dark'): void {
    if (this.snapshot.active.colorScheme === colorScheme) return
    this.snapshot = this.make(colorScheme, this.snapshot.revision + 1)
    this.present()
    this.ctx.emit('theme/change', this.snapshot)
  }

  private make(colorScheme: 'light' | 'dark', revision: number): ThemeSnapshot {
    const active = THEMES.find(theme => theme.colorScheme === colorScheme) ?? THEMES[0]
    return Object.freeze({
      preference: colorScheme,
      fontSizes: FONT_SIZES,
      fontFamilies: FONT_FAMILIES,
      active,
      themes: THEMES,
      revision,
    })
  }

  private present(): void {
    if (typeof document === 'undefined') return
    const body = document.body
    body.toggleAttribute('data-ds-dark-theme', this.snapshot.active.colorScheme === 'dark')
    body.style.setProperty('--dsh-content-font-size', `${this.snapshot.fontSizes.text}px`)
    body.style.setProperty('--dsh-code-font-size', `${this.snapshot.fontSizes.code}px`)
    body.style.setProperty('--dsh-terminal-font-size', `${this.snapshot.fontSizes.terminal}px`)
  }
}
