import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Table as TableIcon } from 'lucide-react';
import { Button, Section, Table } from './ui';

export interface Series {
  key: string;
  label: string;
  /** CSS colour, use the validated --color-series-* tokens. */
  color: string;
  values: number[];
}

export function downloadCsv(filename: string, header: string[], rows: (string | number)[][]) {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // Semicolon + BOM: opens correctly in German Excel.
  const csv = '﻿' + [header, ...rows].map((r) => r.map(esc).join(';')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Chart frame with title, optional legend, table view toggle and CSV export. */
export function ChartCard({ title, children, table, csv, legend }: { title: ReactNode; children: ReactNode; table: { head: string[]; rows: (string | number)[][] }; csv: string; legend?: { label: string; color: string }[] }) {
  const { t } = useTranslation();
  const [asTable, setAsTable] = useState(false);
  return (
    <Section
      title={title}
      actions={
        <span className="flex gap-1">
          <Button size="sm" variant="ghost" aria-pressed={asTable} onClick={() => setAsTable(!asTable)} title={t('analytics.tableView')} aria-label={t('analytics.tableView')}>
            <TableIcon size={15} />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => downloadCsv(csv, table.head, table.rows)} title={t('analytics.csv')} aria-label={t('analytics.csv')}>
            <Download size={15} />
          </Button>
        </span>
      }
    >
      {legend && legend.length > 1 && (
        <ul className="mb-2 flex flex-wrap gap-4 text-sm text-ink-soft">
          {legend.map((l) => (
            <li key={l.label} className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block size-2.5 rounded-[2px]" style={{ background: l.color }} />
              {l.label}
            </li>
          ))}
        </ul>
      )}
      {asTable ? (
        <Table head={table.head}>
          {table.rows.map((r, i) => (
            <tr key={i} className="tnum">
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </Table>
      ) : (
        children
      )}
    </Section>
  );
}

const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v)!;
};

/**
 * Column chart over categories (e.g. months). One or two series side by side, thin columns
 * with rounded data ends, a 2px gap between neighbours, a recessive grid and a hover tooltip.
 */
export function ColumnChart({ labels, series, format = (v) => String(v), height = 200 }: { labels: string[]; series: Series[]; format?: (v: number) => string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 640;
  const pad = { top: 12, right: 8, bottom: 26, left: 36 };
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const band = innerW / Math.max(1, labels.length);
  const barW = Math.min(18, (band * 0.6) / series.length);
  const y = (v: number) => pad.top + innerH - (v / max) * innerH;
  const ticks = [0, max / 2, max];
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label={series.map((s) => s.label).join(', ')} onMouseLeave={() => setHover(null)}>
        {ticks.map((tk) => (
          <g key={tk}>
            <line x1={pad.left} x2={width - pad.right} y1={y(tk)} y2={y(tk)} stroke="var(--color-rule-soft)" />
            <text x={pad.left - 6} y={y(tk) + 4} textAnchor="end" fontSize="11" fill="var(--color-ink-faint)" className="tnum">
              {format(tk)}
            </text>
          </g>
        ))}
        {labels.map((label, i) => {
          const cx = pad.left + band * i + band / 2;
          const groupW = barW * series.length + 2 * (series.length - 1);
          return (
            <g key={label} onMouseEnter={() => setHover(i)}>
              {/* Hit target wider than the marks */}
              <rect x={pad.left + band * i} y={pad.top} width={band} height={innerH} fill={hover === i ? 'var(--color-rule-soft)' : 'transparent'} opacity={0.6} />
              {series.map((s, si) => {
                const v = s.values[i] ?? 0;
                const h = Math.max(0, (v / max) * innerH);
                const x = cx - groupW / 2 + si * (barW + 2);
                const r = Math.min(4, barW / 2, h);
                // Rounded top only: the column stays anchored to the baseline.
                const top = pad.top + innerH - h;
                const d = h <= 0 ? '' : `M${x},${pad.top + innerH} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${pad.top + innerH} Z`;
                return d ? <path key={s.key} d={d} fill={s.color} /> : null;
              })}
              <text x={cx} y={height - 8} textAnchor="middle" fontSize="11" fill="var(--color-ink-faint)">
                {label}
              </text>
            </g>
          );
        })}
        <line x1={pad.left} x2={width - pad.right} y1={pad.top + innerH} y2={pad.top + innerH} stroke="var(--color-rule)" />
      </svg>
      {hover !== null && (
        <div className="pointer-events-none absolute top-0 rounded-md border border-rule bg-sheet px-2.5 py-1.5 text-sm shadow-md" style={{ left: `${Math.min(80, ((hover + 0.5) / labels.length) * 100)}%` }}>
          <div className="font-semibold">{labels[hover]}</div>
          {series.map((s) => (
            <div key={s.key} className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block size-2 rounded-[2px]" style={{ background: s.color }} />
              <span className="text-ink-soft">{s.label}:</span> <span className="tnum font-semibold">{format(s.values[hover] ?? 0)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Horizontal bars for a ranked breakdown (single series, values labelled). */
export function BarList({ items, format = (v) => String(v), color = 'var(--color-series-1)' }: { items: { label: string; value: number }[]; format?: (v: number) => string; color?: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="grid gap-2">
      {items.map((i) => (
        <li key={i.label} className="grid grid-cols-[minmax(7rem,30%)_1fr_auto] items-center gap-3 text-sm" title={`${i.label}: ${format(i.value)}`}>
          <span className="truncate">{i.label}</span>
          <span className="h-3 rounded-r-[4px]" style={{ width: `${Math.max(2, (i.value / max) * 100)}%`, background: color }} />
          <span className="tnum font-semibold">{format(i.value)}</span>
        </li>
      ))}
    </ul>
  );
}
