/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unsafe-declaration-merging --
   These mirror cordis's own published declarations: its Context is a class merged with an
   augmentable interface, its event table starts empty, and its service values are `any`. */
/**
 * Type declarations for `@deepseek-ai/cordis` 4.0.4 (MIT), the members the
 * DSH UI and PIDesktop's host use, with signatures copied from the package's
 * own lib/types. The runtime is the npm package itself; only type checking
 * resolves here (tsconfig `paths`).
 *
 * Why not the package's types: its .d.ts files import siblings as `./x.ts`,
 * and with that spelling this TypeScript resolves `Context` to two distinct
 * declarations, so cordis's own members (effect, get, plugin, …) and the
 * members packages merge in (slots, layout, …) never meet on one type.
 */

/** Disposer returned by effects and registrations. */
export type Disposable<T = any> = () => T

type SyncEffect<T = any> = Disposable<T> | Iterable<Disposable<T>, void, void>
type AsyncEffect<T = any> = Promise<Disposable<T>> | AsyncIterable<Disposable<T>, void, void>
export type Effect<T = any> = SyncEffect<T> | AsyncEffect<T>

interface AsyncDisposable<T = Promise<void>> extends PromiseLike<() => T> {
  (): T
}

/** cordis's built-in logger: callable for a named child, or log directly. */
export interface Logger {
  (name: string): Logger
  debug(...args: any[]): void
  info(...args: any[]): void
  warn(...args: any[]): void
  error(...args: any[]): void
}

/** Event table; packages merge their events in. */
export interface Events {}

export interface EventOptions {
  prepend?: boolean
  global?: boolean
}

export declare const enum FiberState {
  PENDING = 0,
  LOADING = 1,
  ACTIVE = 2,
  FAILED = 3,
  DISPOSED = 4,
  UNLOADING = 5,
}

/** A loaded plugin instance: its scoped context and lifetime. */
export declare class Fiber {
  readonly ctx: Context
  parent: Context
  config: any
  state: FiberState
  uid: number | null
  runtime: { name?: string } | null
  readonly dispose: () => Promise<void>
}

export type Inject<M = Record<string, any>> = (keyof M)[] | { [K in keyof M]?: M[K] }

export type Plugin<T = any> = Plugin.Function<T> | Plugin.Constructor<T> | Plugin.Object<T>

export declare namespace Plugin {
  interface Base<T = any> {
    name?: string
    inject?: Inject
    provide?: string | string[]
    Config?: unknown
    readonly __config?: T
  }
  interface Function<T = any> extends Base<T> {
    (ctx: Context, config: T): any
  }
  interface Constructor<T = any> extends Base<T> {
    new (ctx: Context, config: T): any
  }
  interface Object<T = any> extends Base<T> {
    apply(ctx: Context, config: T): any
  }
}

export declare class ReflectService {
  get(name: string, strict?: boolean): any
  set(name: string, value: any, error?: Error): boolean
  provide(name: string, value?: any, check?: () => boolean): Disposable<Promise<void>>
}

/**
 * A cordis context: a proxy whose property reads resolve services; packages
 * merge the services they provide into this interface.
 */
export interface Context {
  root: this
  baseUrl?: string
  reflect: ReflectService
  fiber: Fiber
  logger: Logger

  effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>
  effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>

  on<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
  once<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
  emit<K extends keyof Events>(name: K, ...args: Events[K] extends (...args: infer A) => any ? A : never): void

  get<K extends string & keyof this>(name: K, strict?: boolean): undefined | this[K]
  get(name: string, strict?: boolean): any
  set<K extends string & keyof this>(name: K, value: undefined | this[K]): void
  set(name: string, value: any): void
  provide<K extends string & keyof this>(name: K, value: undefined | this[K]): () => void
  provide(name: string, value?: any): () => void

  inject(deps: Inject, callback: Plugin.Function<void>): Fiber & PromiseLike<Fiber>
  plugin<P extends Plugin>(plugin: P, config?: any): Fiber & PromiseLike<Fiber>
}

export declare class Context {
  static readonly effect: unique symbol
  static is(value: any): value is Context
  constructor()
  extend(meta?: {}): this
  isolate(name: string, label?: symbol): this
}

/**
 * Base service class: `super(ctx, name)` provides the instance as `ctx[name]`.
 * Calls through the service proxy bind `this.ctx` to the caller's context.
 */
export declare abstract class Service<out T = never> {
  protected ctx: Context
  constructor(ctx: Context, name: string)
  protected readonly __t?: T
}
