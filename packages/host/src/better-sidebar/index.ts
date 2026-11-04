/**
 * Loads better-sidebar's host half (`src/better-sidebar/index.ts`) into the
 * Harness Host and bridges the Host's real `sessions`, `tools` (`sidebar_open`),
 * and `llm` services across the structural DSH service faces it expects.
 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { LlmRequest, LlmService, ToolResultContent } from '@pid/llm'
import type { Session, SessionEvent, Sessions } from '@pid/session'
import { textOutput, type ToolDefinition, type ToolEnv, type Tools } from '@pid/tools'
import * as sidebarHost from 'dsh-better-sidebar/index.ts'
import { createSettings, SIDEBAR_ENTRY_ID } from './settings.ts'
import '../web-server.ts'

interface SidebarSessionEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
}

export const name = 'pid-better-sidebar'
export const inject = ['webServer']

export interface Config {
  /** Where the plugin keeps its settings file. */
  dataDir: string
  /** Optional fallback model supplier for commit-message suggestions on fresh sessions. */
  defaultModel?: () => { provider: string; model: string } | undefined
}

interface DshToolProperty {
  type?: string
  required?: boolean
  description?: string
  enum?: unknown[]
}

interface DshToolDefinition {
  name: string
  description: string
  parameters?: Record<string, DshToolProperty>
  output?: {
    render?: (args: unknown, value: unknown) => Array<{ type?: string; text?: string }>
  }
  execute: (
    args: Record<string, unknown>,
    exec: { signal: AbortSignal; agent: { session: { id: string } } },
  ) => Promise<unknown> | unknown
}

function toSidebarEvents(events: readonly SessionEvent[]): SidebarSessionEvent[] {
  const converted: SidebarSessionEvent[] = []
  for (const event of events) {
    const time = Date.parse(event.ts) || 0
    if (event.type === 'model') {
      const data = event.data as { provider?: string; model?: string }
      converted.push({
        type: 'request/header',
        seq: event.seq,
        time,
        data: { provider: data.provider, model: data.model },
      })
      continue
    }
    if (event.type === 'assistant') {
      for (const block of event.data.content) {
        if (block.type === 'tool-call') {
          converted.push({
            type: 'tool/call',
            seq: event.seq,
            time,
            data: {
              callId: block.id,
              id: block.id,
              name: block.name,
              tool: block.name,
              args: block.arguments,
              input: block.arguments,
            },
          })
        }
      }
      continue
    }
    if (event.type === 'tool-call') {
      converted.push({
        type: 'tool/call',
        seq: event.seq,
        time,
        data: {
          callId: event.data.callId,
          id: event.data.callId,
          name: event.data.name,
          tool: event.data.name,
          args: event.data.args,
          input: event.data.args,
        },
      })
      continue
    }
    if (event.type === 'tool-result') {
      converted.push({
        type: 'tool/result',
        seq: event.seq,
        time,
        data: {
          callId: event.data.callId,
          id: event.data.callId,
          name: event.data.name,
          tool: event.data.name,
          isError: event.data.isError,
        },
      })
      continue
    }
    converted.push({
      type: event.type,
      seq: event.seq,
      time,
      data: (typeof event.data === 'object' && event.data !== null ? event.data : {}) as Record<string, unknown>,
    })
  }
  return converted
}

function adaptDshTool(dshDef: DshToolDefinition): ToolDefinition {
  const properties: Record<string, Record<string, unknown>> = {}
  const required: string[] = []
  for (const [key, prop] of Object.entries(dshDef.parameters ?? {})) {
    const schemaProp: Record<string, unknown> = { type: prop.type ?? 'string' }
    if (prop.description !== undefined) schemaProp.description = prop.description
    if (prop.enum !== undefined) schemaProp.enum = prop.enum
    properties[key] = schemaProp
    if (prop.required === true) required.push(key)
  }
  return {
    name: dshDef.name,
    description: dshDef.description,
    parameters: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
    async execute(args: Record<string, unknown>, env: ToolEnv) {
      const value = await dshDef.execute(args, {
        signal: env.signal,
        agent: { session: { id: env.sessionId } },
      })
      const rendered = dshDef.output?.render?.(args, value) ?? []
      const content: ToolResultContent[] = rendered
        .filter((block): block is { type: 'text'; text: string } => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => ({ type: 'text', text: block.text }))
      if (content.length === 0) {
        return { ...textOutput(typeof value === 'string' ? value : JSON.stringify(value)), details: value }
      }
      return { content, details: value }
    },
  }
}

function adaptSession(session: Session) {
  return {
    header: { cwd: session.header.cwd },
    snapshotEvents: () => toSidebarEvents(session.events),
  }
}

function createLlmBridge(hostLlm: LlmService) {
  return {
    listProviders: () => hostLlm.listProviders(),
    listModels: (provider: string) => hostLlm.listModels(provider),
    async *stream(options: {
      provider: string
      model: string
      messages?: Array<{ content?: unknown }>
      system?: string
      maxTokens?: number
      signal?: AbortSignal
    }) {
      const userBlocks = (options.messages ?? []).flatMap((msg) => {
        if (!Array.isArray(msg.content)) return []
        return msg.content
          .filter((item): item is { type: 'text'; text: string } =>
            typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'text' && typeof (item as { text?: unknown }).text === 'string',
          )
          .map((item) => ({ type: 'text' as const, text: item.text }))
      })
      const request: LlmRequest = {
        provider: options.provider,
        model: options.model,
        ...(options.system === undefined ? {} : { system: options.system }),
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        messages: [{ role: 'user', content: userBlocks.length > 0 ? userBlocks : [{ type: 'text', text: '' }] }],
      }
      for await (const chunk of hostLlm.stream(request, options.signal)) {
        if (chunk.type === 'finish' && chunk.reason === 'error') {
          throw new Error(chunk.error?.message ?? 'LLM stream failed')
        }
        yield chunk
      }
    },
  }
}

export function apply(ctx: Context, config: Config): void {
  const hostSessions = ctx.get('sessions') as Sessions | undefined
  const hostTools = ctx.get('tools') as Tools | undefined
  const hostLlm = ctx.get('llm') as LlmService | undefined

  // Isolate service names whose shapes differ between PIDesktop and DSH so the
  // inner better-sidebar fiber sees DSH-shaped adapters while delegating to the
  // real Host singletons captured above.
  ctx
    .isolate('sessions')
    .isolate('tools')
    .isolate('llm')
    .plugin({
      name: `${name}/scope`,
      apply: (scoped: Context) => mount(scoped, config, { hostSessions, hostTools, hostLlm }),
    })
}

function mount(
  ctx: Context,
  config: Config,
  bridges: { hostSessions?: Sessions; hostTools?: Tools; hostLlm?: LlmService },
): void {
  const entry: { options: { id: string; name: string }; fiber: unknown; disabled: boolean } = {
    options: { id: SIDEBAR_ENTRY_ID, name: sidebarHost.name },
    fiber: undefined,
    disabled: false,
  }
  const provide = (service: string, value: unknown): void => {
    ctx.effect(() => ctx.provide(service, value), `pid-better-sidebar: provide ${service}`)
  }

  provide('loader', { entries: () => [entry], await: () => Promise.resolve() })
  provide('webRuntime', { trustedHosts: [] })

  provide('sessions', {
    get: (id: string) => {
      const live = bridges.hostSessions?.peek(id)
      return live === undefined ? undefined : adaptSession(live)
    },
  })

  if (bridges.hostSessions !== undefined) {
    const sessions = bridges.hostSessions
    provide('sessionPersistence', {
      async open(sessionId: string) {
        const live = sessions.peek(sessionId)
        if (live !== undefined) {
          return {
            header: { cwd: live.header.cwd },
            inheritedEventCount: 0,
            read: async () => ({ events: toSidebarEvents(live.events) }),
            close: async () => {},
          }
        }
        const loaded = await sessions.storage.load(sessionId)
        if (loaded === undefined) throw new Error(`Session "${sessionId}" not found`)
        return {
          header: { cwd: loaded.header.cwd },
          inheritedEventCount: 0,
          read: async () => ({ events: toSidebarEvents(loaded.events) }),
          close: async () => {},
        }
      },
    })
  }

  provide('tools', {
    register: (definition: unknown) => {
      if (bridges.hostTools === undefined) return () => {}
      return bridges.hostTools.register(adaptDshTool(definition as DshToolDefinition))
    },
  })

  if (bridges.hostLlm !== undefined) {
    provide('llm', createLlmBridge(bridges.hostLlm))
  }

  if (config.defaultModel !== undefined) {
    provide('agentDefaultModel', {
      currentSelection: () => config.defaultModel?.(),
    })
  }

  provide('settings', createSettings(join(config.dataDir, 'better-sidebar', 'settings.json')))
  entry.fiber = ctx.plugin(sidebarHost)
}
