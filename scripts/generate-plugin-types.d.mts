export interface GeneratePluginTypesOptions {
  repoRoot?: string;
  targetDir?: string;
}

export function generatePluginTypes(options?: GeneratePluginTypesOptions): string;
export function syncBundledPluginAssets(repoRoot?: string): void;
