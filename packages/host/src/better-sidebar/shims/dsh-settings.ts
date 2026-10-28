/**
 * Stand-in for `@deepseek-ai/dsh-settings`'s `SettingsConflictError`: the
 * settings service throws it when a writer's expected revision is stale, and
 * better-sidebar's `settings.update` route answers it as a conflict.
 */
export class SettingsConflictError extends Error {
  constructor(message = 'settings changed since they were read') {
    super(message)
    this.name = 'SettingsConflictError'
  }
}
