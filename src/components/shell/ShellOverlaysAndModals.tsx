import { lazy, Suspense } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { AppearanceCatalog } from "../../lib/appearanceCatalog";
import type { ClientContributionsSnapshot } from "../../lib/clientContributions";
import type { AppSettings, GitSnapshot, ModelInfo, Toast } from "../../types";
import { CommitDialog, type CommitOutcome } from "../CommitDialog";
import { RegionErrorBoundary, SlotEntryHost } from "../common/ErrorBoundary";
import { HostStatusBanner } from "../HostStatusBanner";
import type { SettingsPage } from "../SettingsModal";

const SettingsModal = lazy(() =>
  import("../SettingsModal").then((module) => ({ default: module.SettingsModal })),
);

export interface ShellOverlaysAndModalsProps {
  commitDialog: { push: boolean } | null;
  setCommitDialog: (next: { push: boolean } | null) => void;
  workspaceCwd: string;
  cwd: string;
  sessionFile: string | null;
  reviewGit: GitSnapshot | null;
  model: ModelInfo | null;
  isStreaming: boolean;
  finishCommit: (outcome: CommitOutcome) => void;
  settingsOpen: boolean;
  setSettingsOpen: (next: boolean) => void;
  settingsPage: SettingsPage;
  settings: AppSettings | null;
  appearanceCatalog: AppearanceCatalog;
  saveSettings: (next: AppSettings) => Promise<void>;
  contributions: ClientContributionsSnapshot;
  toasts: Toast[];
  dismissToast: (id: string) => void;
}

export function ShellOverlaysAndModals({
  commitDialog,
  setCommitDialog,
  workspaceCwd,
  cwd,
  sessionFile,
  reviewGit,
  model,
  isStreaming,
  finishCommit,
  settingsOpen,
  setSettingsOpen,
  settingsPage,
  settings,
  appearanceCatalog,
  saveSettings,
  contributions,
  toasts,
  dismissToast,
}: ShellOverlaysAndModalsProps) {
  const settingsIsModal = settings?.settingsDisplayMode === "modal";
  return (
    <>
      {commitDialog && workspaceCwd && reviewGit?.isRepository && (
        <CommitDialog
          cwd={workspaceCwd}
          git={reviewGit}
          initialPush={commitDialog.push}
          model={model ? { provider: model.provider, id: model.id } : null}
          agentRunning={isStreaming}
          onClose={() => setCommitDialog(null)}
          onDone={finishCommit}
        />
      )}
      <AnimatePresence>
        {settingsOpen && (
          <Suspense
            fallback={(
              <div className={`settings-backdrop ${settingsIsModal ? "is-modal" : "is-page"}`}>
                <div className={`settings-center settings-loading ${settingsIsModal ? "is-modal" : "is-page"}`}>
                  正在加载设置…
                </div>
              </div>
            )}
          >
            <RegionErrorBoundary region="设置中心" resetKey={settingsPage}>
              <SettingsModal
                initialPage={settingsPage}
                settings={settings}
                cwd={workspaceCwd || cwd}
                sessionFile={sessionFile}
                appearanceCatalog={appearanceCatalog}
                onSave={saveSettings}
                onClose={() => setSettingsOpen(false)}
              />
            </RegionErrorBoundary>
          </Suspense>
        )}
      </AnimatePresence>

      {contributions.overlays.map((overlay) => (
        <div
          key={overlay.id}
          className="client-plugin-overlay-slot"
          style={{ pointerEvents: "none" }}
        >
          <SlotEntryHost
            entry={overlay}
            context={{ cwd: workspaceCwd || cwd, sessionFile }}
            slotName="overlays"
          />
        </div>
      ))}

      <HostStatusBanner />

      <div className="toast-stack">
        <AnimatePresence initial={false}>
          {toasts.map((toast) => (
            <motion.button
              layout
              key={toast.id}
              className={`toast ${toast.kind}`}
              initial={{ opacity: 0, y: 10, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.96 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              onClick={() => dismissToast(toast.id)}
            >
              {toast.message}
            </motion.button>
          ))}
        </AnimatePresence>
      </div>
    </>
  );
}
