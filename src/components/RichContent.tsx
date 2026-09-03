import { useId, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Check,
  Circle,
  CircleAlert,
  CircleCheck,
  ExternalLink,
  Info,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import type { RichCalloutBlock, RichContentBlock, RichContentDocument, RichTone } from "../lib/richContent";

const TONE_ICONS = {
  neutral: Info,
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
} as const;

const STEP_STATUS = {
  done: { label: "已完成", Icon: Check },
  active: { label: "进行中", Icon: LoaderCircle },
  pending: { label: "待处理", Icon: Circle },
} as const;

function toneClass(tone?: RichTone): string {
  return `pi-rich--tone-${tone ?? "neutral"}`;
}

function BlockTitle({ children }: { children?: ReactNode }) {
  return children ? <h4 className="pi-rich__block-title">{children}</h4> : null;
}

function Callout({ block }: { block: RichCalloutBlock }) {
  const tone = block.tone ?? "info";
  const Icon = TONE_ICONS[tone];
  return (
    <aside className={`pi-rich__callout ${toneClass(tone)}`} aria-label={block.title ?? "提示"}>
      <Icon size={17} strokeWidth={1.8} aria-hidden="true" />
      <div>
        {block.title && <strong>{block.title}</strong>}
        <p>{block.body}</p>
      </div>
    </aside>
  );
}

function RichBlock({ block }: { block: RichContentBlock }) {
  if (block.type === "callout") return <Callout block={block} />;

  if (block.type === "metrics") {
    return (
      <section className="pi-rich__block pi-rich__metrics">
        <BlockTitle>{block.title}</BlockTitle>
        <dl className="pi-rich__metric-grid">
          {block.items.map((item, index) => (
            <div className={`pi-rich__metric ${toneClass(item.tone)}`} key={`${item.label}-${index}`}>
              <dt>{item.label}</dt>
              <dd><strong>{item.value}</strong>{item.detail && <small>{item.detail}</small>}</dd>
            </div>
          ))}
        </dl>
      </section>
    );
  }

  if (block.type === "steps") {
    return (
      <section className="pi-rich__block pi-rich__steps">
        <BlockTitle>{block.title}</BlockTitle>
        <ol>
          {block.items.map((item, index) => {
            const status = item.status ?? "pending";
            const { label, Icon } = STEP_STATUS[status];
            return (
              <li className={`pi-rich__step pi-rich__step--${status}`} key={`${item.title}-${index}`}>
                <span className="pi-rich__step-icon"><Icon size={14} strokeWidth={1.9} aria-hidden="true" /></span>
                <div><strong>{item.title}</strong>{item.description && <p>{item.description}</p>}</div>
                <small>{label}</small>
              </li>
            );
          })}
        </ol>
      </section>
    );
  }

  if (block.type === "comparison") {
    return (
      <section className="pi-rich__block pi-rich__comparison">
        <div className="pi-rich__table-scroll" role="region" aria-label={`${block.title ?? "对比"}，可横向滚动`} tabIndex={0}>
          <table>
            <caption>{block.title ?? "对比"}</caption>
            <thead><tr>{block.columns.map((column) => <th scope="col" key={column}>{column}</th>)}</tr></thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>{row.map((cell, columnIndex) => columnIndex === 0
                  ? <th scope="row" key={columnIndex}>{cell}</th>
                  : <td key={columnIndex}>{cell}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  if (block.type === "progress") {
    return (
      <section className="pi-rich__block pi-rich__progress-list">
        <BlockTitle>{block.title}</BlockTitle>
        <ul>
          {block.items.map((item, index) => (
            <li className={toneClass(item.tone)} key={`${item.label}-${index}`}>
              <div className="pi-rich__value-line"><strong>{item.label}</strong><span>{item.value}%</span></div>
              <progress max={100} value={item.value} aria-label={`${item.label} ${item.value}%`} />
              {item.detail && <small>{item.detail}</small>}
            </li>
          ))}
        </ul>
      </section>
    );
  }

  if (block.type === "bars") {
    return (
      <section className="pi-rich__block pi-rich__bars">
        <BlockTitle>{block.title}</BlockTitle>
        <ul>
          {block.items.map((item, index) => {
            const percent = item.max === 0 ? 0 : item.value / item.max * 100;
            const valueLabel = `${item.value}${item.unit ?? ""} / ${item.max}${item.unit ?? ""}`;
            return (
              <li className={toneClass(item.tone)} key={`${item.label}-${index}`}>
                <div className="pi-rich__value-line"><strong>{item.label}</strong><span>{valueLabel}</span></div>
                <div className="pi-rich__bar-track" role="img" aria-label={`${item.label} ${valueLabel}`}>
                  <span style={{ width: `${percent}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    );
  }

  return (
    <section className="pi-rich__block pi-rich__links">
      <BlockTitle>{block.title}</BlockTitle>
      <ul>
        {block.items.map((item, index) => (
          <li key={`${item.url}-${index}`}>
            <a
              href={item.url}
              rel="noopener noreferrer"
              onClick={(event) => {
                event.preventDefault();
                void openUrl(item.url).catch(() => undefined);
              }}
            >
              <span><strong>{item.label}</strong>{item.description && <small>{item.description}</small>}</span>
              <span className="pi-rich__link-host">{new URL(item.url).hostname}<ExternalLink size={13} strokeWidth={1.8} aria-hidden="true" /></span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function RichContent({ document }: { document: RichContentDocument }) {
  const titleId = useId();
  return (
    <section className="pi-rich" aria-labelledby={titleId}>
      {(document.title || document.summary) && (
        <header className="pi-rich__header">
          <h3 id={titleId} className={document.title ? undefined : "pi-rich__sr-title"}>{document.title ?? "结构化内容"}</h3>
          {document.summary && <p>{document.summary}</p>}
        </header>
      )}
      {!document.title && !document.summary && <h3 id={titleId} className="pi-rich__sr-title">结构化内容</h3>}
      <div className="pi-rich__blocks">
        {document.blocks.map((block, index) => <RichBlock block={block} key={`${block.type}-${index}`} />)}
      </div>
    </section>
  );
}
