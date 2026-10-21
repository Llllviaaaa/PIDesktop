/**
 * PIDesktop's `settings` service for better-sidebar's host half: the one form
 * the plugin reads and writes (its "Side card" preferences), persisted as a
 * JSON file in PIDesktop's data directory.
 *
 * DSH keeps forms in the profile document, addressed by the plugin row's
 * Loader entry id and shaped by the module's exported `Config`. Here the row
 * is fixed, so the file holds that one form's user layer and its revision;
 * the value is the user layer resolved through the preference schema. (Not
 * `Config` itself: its fields are marked volatile, which this schemastery
 * build resolves to reference wrappers the client could not read.)
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { PrefsSchema } from '../../src/better-sidebar/config.ts'
import type { SidebarSettingsService } from '../../src/better-sidebar/context-types.ts'

/** The Loader entry id better-sidebar's own bundle mounts the package under. */
export const SIDEBAR_ENTRY_ID = 'better-sidebar'

interface StoredForm {
  revision: number
  user: Record<string, unknown>
}

function readStored(file: string): StoredForm {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoredForm> | null
    const user = parsed?.user
    return {
      revision: typeof parsed?.revision === 'number' ? parsed.revision : 0,
      user: user !== null && typeof user === 'object' && !Array.isArray(user) ? user : {},
    }
  } catch {
    return { revision: 0, user: {} }
  }
}

function resolve(user: Record<string, unknown>): unknown {
  try {
    return PrefsSchema(user)
  } catch {
    return PrefsSchema({})
  }
}

/**
 * Create the settings service over one JSON file.
 * @param file - where the form's user layer is stored.
 */
export function createSettings(file: string): SidebarSettingsService {
  let stored = readStored(file)

  const persist = (): void => {
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(stored, null, 2)}\n`)
    renameSync(temp, file)
  }

  return {
    describe(options) {
      return [{
        ns: SIDEBAR_ENTRY_ID,
        revision: stored.revision,
        value: resolve(stored.user),
        ...(options?.redactSecrets === true ? {} : { user: stored.user }),
      }]
    },
    async update(ns, patch, expectedRevision) {
      if (ns !== SIDEBAR_ENTRY_ID) throw new Error(`unknown settings form "${ns}"`)
      if (expectedRevision !== undefined && expectedRevision !== stored.revision) {
        throw new SettingsConflictError()
      }
      const user = { ...stored.user, ...(patch as Record<string, unknown>) }
      // Refuse a patch the schema rejects instead of persisting it.
      PrefsSchema(user)
      stored = { revision: stored.revision + 1, user }
      persist()
    },
    configure() {
      return () => {}
    },
  }
}
