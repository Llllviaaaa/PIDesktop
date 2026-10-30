import { useState } from "react";
import { History } from "lucide-react";
import type { PiImportProgress, PiImportReport } from "@pid/protocol";
import { describeError } from "../lib/errors";
import { describeImport, piImport } from "../lib/piImport";

interface PiImportOfferProps {
  /** The desktop's Pi session directory setting; empty for Pi's default. */
  sessionDir?: string;
  pending: number;
  onDone: (report: PiImportReport | null) => void;
}

/**
 * The one-time offer to bring Pi's past tasks over (P6b). Either answer is
 * recorded on the Host; settings › 已归档 can import later.
 */
export function PiImportOffer({ sessionDir, pending, onDone }: PiImportOfferProps) {
  const [progress, setProgress] = useState<PiImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<PiImportReport | null>(null);

  const run = async () => {
    setError(null);
    setProgress({ done: 0, total: pending });
    try {
      setReport(await piImport.run(sessionDir, setProgress));
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setProgress(null);
    }
  };
  const later = () => {
    void piImport.dismiss(sessionDir).catch(() => undefined);
    onDone(null);
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="harness-offer" role="dialog" aria-modal="true" aria-labelledby="pi-import-title">
        <header>
          <History size={18} strokeWidth={1.75} />
          <h2 id="pi-import-title">导入 Pi 的历史任务</h2>
        </header>
        {report === null ? (
          <>
            <p>找到 {pending} 个 Pi 的历史任务。导入后它们会出现在侧边栏，可以继续对话。</p>
            <ul>
              <li>每个任务导入它最后所在的分支，与在 Pi 中看到的一致。</li>
              <li>Pi 的原文件只读取，不会修改或删除。</li>
              <li>之后也可以在 设置 › 已归档 中再次导入，已导入的任务会跳过。</li>
            </ul>
            {progress !== null && <p className="harness-offer-note">正在导入 {progress.done}/{progress.total}…</p>}
            {error !== null && <p className="harness-offer-warning">导入失败：{error}</p>}
            <footer>
              <button type="button" className="secondary-button" disabled={progress !== null} onClick={later}>以后再说</button>
              <button type="button" className="primary-button" disabled={progress !== null} onClick={() => void run()}>导入</button>
            </footer>
          </>
        ) : (
          <>
            <p>{describeImport(report)}。</p>
            {report.problems.length > 0 && <ul className="harness-offer-note">{report.problems.slice(0, 6).map((problem) => <li key={problem}>{problem}</li>)}</ul>}
            <footer>
              <button type="button" className="primary-button" onClick={() => onDone(report)}>完成</button>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
