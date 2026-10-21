/**
 * Stand-in for `@deepseek-ai/dsh-client-locale/client`: the dictionary
 * registry behind `ctx.locale`, following upstream's LocaleRuntime. PIDesktop
 * is Chinese-first, so the active locale is `zh` with `en` as fallback; the
 * shared `common` vocabulary is upstream's own dictionary pair.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { LocaleFace, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { en as commonEn, zh as commonZh, type CommonKey } from '../../dsh/locale/locales/index.ts'

export type { Translate, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Shared cross-feature vocabulary, consulted after the entry's own namespace misses. */
    common: CommonKey
  }
}

export type LocaleId = string
export type LocaleDict = Record<string, string>

export interface LocaleDefinition {
  readonly id: LocaleId
  readonly label: string
  readonly fallback?: LocaleId
}

/** Immutable locale state published on every change. */
export interface LocaleSnapshot {
  active: LocaleId
  locales: readonly LocaleDefinition[]
  /** Monotonic change counter (registry or active changes). */
  revision: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    locale: LocaleRuntime
  }
  interface Events {
    /** The active locale switched. */
    'locale/change'(snapshot: LocaleSnapshot): void
  }
}

const COMMON_NS = 'common'
const LOCALES: readonly LocaleDefinition[] = Object.freeze([
  Object.freeze({ id: 'zh', label: '中文', fallback: 'en' }),
  Object.freeze({ id: 'en', label: 'English' }),
])

/**
 * Dictionary registry plus the active locale. Lookup walks the active
 * locale's fallback chain in the entry namespace, then in `common`, before
 * showing the key itself.
 */
export class LocaleRuntime {
  private readonly dicts = new Map<string, Map<LocaleId, LocaleDict>>()
  private readonly bound = new Map<string, Translate>()
  private readonly listeners = new Set<() => void>()
  private snapshot: LocaleSnapshot = Object.freeze({ active: 'zh', locales: LOCALES, revision: 0 })

  constructor(private readonly ctx: Context) {
    this.register(COMMON_NS, { zh: commonZh, en: commonEn })
  }

  getLocale(): LocaleSnapshot {
    return this.snapshot
  }

  getSnapshot(): LocaleSnapshot {
    return this.snapshot
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  setLocale(id: string): void {
    if (id === this.snapshot.active || !LOCALES.some(locale => locale.id === id)) return
    this.publish(id, true)
  }

  /**
   * Register dictionaries for a namespace.
   * @param ns - namespace.
   * @param localeOrDicts - one dictionary per locale, or the locale of `dict`.
   * @param dict - the dictionary when a single locale is named.
   * @returns disposer removing exactly what was added.
   */
  register(ns: string, localeOrDicts: string | Record<string, LocaleDict>, dict?: LocaleDict): () => void {
    const entries: [LocaleId, LocaleDict][] = typeof localeOrDicts === 'string'
      ? [[localeOrDicts, dict ?? {}]]
      : Object.entries(localeOrDicts)
    let locales = this.dicts.get(ns)
    if (locales === undefined) {
      locales = new Map()
      this.dicts.set(ns, locales)
    }
    const previous = entries.map(([locale]) => [locale, locales.get(locale)] as const)
    for (const [locale, value] of entries) locales.set(locale, { ...locales.get(locale), ...value })
    this.publish(this.snapshot.active, false)
    return () => {
      for (const [locale, value] of previous) {
        if (value === undefined) locales.delete(locale)
        else locales.set(locale, value)
      }
      this.publish(this.snapshot.active, false)
    }
  }

  /**
   * Bind a namespace to a translate function reading the active locale at call time.
   * @param ns - namespace.
   * @returns a translate function, stable per namespace.
   */
  bind(ns: string): Translate {
    let t = this.bound.get(ns)
    if (t === undefined) {
      t = (key, params) => this.translate(ns, key, params)
      this.bound.set(ns, t)
    }
    return t
  }

  /**
   * Resolve one key without binding.
   * @param ns - namespace.
   * @param key - dictionary key.
   * @param params - template params.
   * @returns the text, or the key itself.
   */
  lookup(ns: string, key: string, params?: Record<string, unknown>): string {
    return this.translate(ns, key, params)
  }

  /** The renderer's locale seat: namespace binding plus a revision source. */
  face(): LocaleFace {
    // useSyncExternalStore needs the same snapshot object until the revision moves.
    let cached = { revision: this.snapshot.revision }
    return {
      bind: ns => this.bind(ns),
      getSnapshot: () => {
        if (cached.revision !== this.snapshot.revision) cached = { revision: this.snapshot.revision }
        return cached
      },
      subscribe: fn => this.subscribe(fn),
    }
  }

  private translate(ns: string, key: string, params?: Record<string, unknown>): string {
    const chain = this.fallbackChain(this.snapshot.active)
    const template = this.find(ns, key, chain)
      ?? (ns !== COMMON_NS ? this.find(COMMON_NS, key, chain) : undefined)
      ?? key
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
  }

  private find(ns: string, key: string, chain: readonly LocaleId[]): string | undefined {
    const locales = this.dicts.get(ns)
    for (const locale of chain) {
      const value = locales?.get(locale)?.[key]
      if (value !== undefined) return value
    }
    return undefined
  }

  private fallbackChain(active: LocaleId): LocaleId[] {
    const chain: LocaleId[] = []
    let current: LocaleId | undefined = active
    while (current !== undefined && !chain.includes(current)) {
      chain.push(current)
      current = LOCALES.find(locale => locale.id === current)?.fallback
    }
    if (!chain.includes('en')) chain.push('en')
    return chain
  }

  private publish(active: LocaleId, localeChanged: boolean): void {
    // A frozen revision object per publish: the renderer's locale seat compares by identity.
    this.snapshot = Object.freeze({ active, locales: LOCALES, revision: this.snapshot.revision + 1 })
    if (localeChanged) this.ctx.emit('locale/change', this.snapshot)
    for (const fn of [...this.listeners]) {
      try {
        fn()
      } catch (error) {
        console.error('locale subscriber crashed:', error)
      }
    }
  }
}
