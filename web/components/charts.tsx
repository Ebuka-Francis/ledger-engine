"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { formatCompact, formatDay, formatDayLong, formatNumber } from "@/lib/format";
import type { DayBucket, Point } from "@/lib/derive";

// Hand-drawn SVG charts. Colors come from CSS variables so light and dark mode
// switch without redrawing: --series-1 (blue) and --series-2 (orange).

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(560);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setW(Math.max(260, Math.floor(el.getBoundingClientRect().width)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function niceScale(min: number, max: number, target = 4) {
  const span = max - min || 1;
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { lo, hi: hi === lo ? lo + step : hi, ticks };
}

// ------------------------------------------------------------------ card

export function ChartCard({
  title,
  sub,
  legend,
  table,
  className = "",
  children,
}: {
  title: string;
  sub?: string;
  legend?: ReactNode;
  table: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  return (
    <section className={`card ${className}`}>
      <header className="card-head">
        <div>
          <h3 className="card-title">{title}</h3>
          {sub && <p className="card-sub">{sub}</p>}
        </div>
        <div className="seg2" role="group" aria-label={`${title} view`}>
          <button type="button" aria-pressed={view === "chart"} onClick={() => setView("chart")}>
            Chart
          </button>
          <button type="button" aria-pressed={view === "table"} onClick={() => setView("table")}>
            Table
          </button>
        </div>
      </header>
      {legend}
      {view === "chart" ? children : <div className="tbl-scroll">{table}</div>}
    </section>
  );
}

export function EmptyChart({ children }: { children: ReactNode }) {
  return <div className="chart-empty">{children}</div>;
}

// ------------------------------------------------------------ area (steps)

export function AreaChart({ points, currency, label }: { points: Point[]; currency: string; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const H = 250;
  const m = { l: 54, r: 20, t: 18, b: 28 };
  const iw = Math.max(1, width - m.l - m.r);
  const ih = H - m.t - m.b;
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const maxV = Math.max(...points.map((p) => p.v));
  const minV = Math.min(0, ...points.map((p) => p.v));
  const sc = niceScale(minV, maxV <= minV ? minV + 1 : maxV);
  const x = (t: number) => m.l + (t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * iw);
  const y = (v: number) => m.t + ih - ((v - sc.lo) / (sc.hi - sc.lo)) * ih;

  let d = `M${x(points[0].t)},${y(points[0].v)}`;
  for (let i = 1; i < points.length; i++) d += ` H${x(points[i].t)} V${y(points[i].v)}`;
  const area = `${d} V${y(0)} H${x(t0)} Z`;

  const last = points[points.length - 1];
  const nTicks = iw < 420 ? 3 : 5;
  const xTicks = Array.from({ length: nTicks }, (_, i) => t0 + ((t1 - t0) * i) / (nTicks - 1));

  function indexAt(clientX: number, el: Element) {
    const r = el.getBoundingClientRect();
    const time = t0 + ((clientX - r.left) / r.width) * (t1 - t0);
    let idx = 0;
    for (let i = 0; i < points.length; i++) if (points[i].t <= time) idx = i;
    return idx;
  }

  function onKey(e: KeyboardEvent) {
    const cur = active ?? points.length - 1;
    if (e.key === "ArrowLeft") setActive(Math.max(0, cur - 1));
    else if (e.key === "ArrowRight") setActive(Math.min(points.length - 1, cur + 1));
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(points.length - 1);
    else if (e.key === "Escape") setActive(null);
    else return;
    e.preventDefault();
  }

  const a = active !== null ? points[active] : null;
  const flip = a ? x(a.t) > width * 0.62 : false;

  return (
    <div className="chart" ref={ref} tabIndex={0} onKeyDown={onKey} onFocus={() => active === null && setActive(points.length - 1)} onBlur={() => setActive(null)}>
      <svg width={width} height={H} role="img" aria-label={label}>
        {sc.ticks.map((v) => (
          <g key={v}>
            <line className={v === 0 ? "ch-axis" : "ch-grid"} x1={m.l} x2={m.l + iw} y1={y(v)} y2={y(v)} />
            <text className="ch-label" x={m.l - 8} y={y(v)} textAnchor="end" dominantBaseline="middle">
              {formatCompact(v, currency)}
            </text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text key={i} className="ch-label" x={x(t)} y={H - 8} textAnchor={i === 0 ? "start" : i === nTicks - 1 ? "end" : "middle"}>
            {formatDay(t)}
          </text>
        ))}

        <path d={area} className="ch-area" />
        <path d={d} className="ch-line" />

        {a ? (
          <>
            <line className="ch-cross" x1={x(a.t)} x2={x(a.t)} y1={m.t} y2={m.t + ih} />
            <circle className="ch-dot" cx={x(a.t)} cy={y(a.v)} r={4.5} />
          </>
        ) : (
          <>
            <circle className="ch-dot" cx={x(last.t)} cy={y(last.v)} r={4.5} />
            <text className="ch-end" x={x(last.t) - 10} y={y(last.v) - 12} textAnchor="end">
              {formatCompact(last.v, currency)}
            </text>
          </>
        )}

        <rect
          x={m.l}
          y={m.t}
          width={iw}
          height={ih}
          fill="transparent"
          onPointerMove={(e) => setActive(indexAt(e.clientX, e.currentTarget))}
          onPointerLeave={() => setActive(null)}
        />
      </svg>

      {a && (
        <div className="tip" style={{ left: x(a.t), transform: `translateX(${flip ? "calc(-100% - 12px)" : "12px"})` }}>
          <div className="tip-val">{formatNumber(a.v, currency)}</div>
          <div className="tip-row">
            <span className="tip-key" style={{ background: "var(--series-1)" }} />
            Balance on {formatDayLong(a.t)}
          </div>
        </div>
      )}
    </div>
  );
}

export function BalanceTable({ points, currency }: { points: Point[]; currency: string }) {
  return (
    <table className="data">
      <thead>
        <tr>
          <th>Date</th>
          <th className="num">Balance</th>
        </tr>
      </thead>
      <tbody>
        {[...points].reverse().map((p, i) => (
          <tr key={i}>
            <td>{formatDayLong(p.t)}</td>
            <td className="num">{formatNumber(p.v, currency)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ------------------------------------------------------- grouped columns

function barPath(x: number, y: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

export function FlowChart({ days, currency, label }: { days: DayBucket[]; currency: string; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const H = 250;
  const m = { l: 54, r: 12, t: 22, b: 28 };
  const iw = Math.max(1, width - m.l - m.r);
  const ih = H - m.t - m.b;
  const max = Math.max(1, ...days.map((d) => Math.max(d.inflow, d.outflow)));
  const sc = niceScale(0, max);
  const slot = iw / days.length;
  const bw = Math.max(2, Math.min(12, slot * 0.36));
  const y = (v: number) => m.t + ih - (v / sc.hi) * ih;
  const cx = (i: number) => m.l + slot * (i + 0.5);

  // Label only each series' tallest bar.
  const topIn = days.reduce((b, d, i) => (d.inflow > days[b].inflow ? i : b), 0);
  const topOut = days.reduce((b, d, i) => (d.outflow > days[b].outflow ? i : b), 0);
  const labels: { i: number; v: number; series: 1 | 2 }[] = [];
  if (days[topIn].inflow > 0) labels.push({ i: topIn, v: days[topIn].inflow, series: 1 });
  if (days[topOut].outflow > 0) labels.push({ i: topOut, v: days[topOut].outflow, series: 2 });

  const labelEvery = Math.max(1, Math.ceil(days.length / (iw < 420 ? 3 : 6)));
  const a = active !== null ? days[active] : null;
  const flip = active !== null ? cx(active) > width * 0.62 : false;

  function onKey(e: KeyboardEvent) {
    const cur = active ?? days.length - 1;
    if (e.key === "ArrowLeft") setActive(Math.max(0, cur - 1));
    else if (e.key === "ArrowRight") setActive(Math.min(days.length - 1, cur + 1));
    else if (e.key === "Escape") setActive(null);
    else return;
    e.preventDefault();
  }

  return (
    <div className="chart" ref={ref} tabIndex={0} onKeyDown={onKey} onFocus={() => active === null && setActive(days.length - 1)} onBlur={() => setActive(null)}>
      <svg width={width} height={H} role="img" aria-label={label}>
        {sc.ticks.map((v) => (
          <g key={v}>
            <line className={v === 0 ? "ch-axis" : "ch-grid"} x1={m.l} x2={m.l + iw} y1={y(v)} y2={y(v)} />
            <text className="ch-label" x={m.l - 8} y={y(v)} textAnchor="end" dominantBaseline="middle">
              {formatCompact(v, currency)}
            </text>
          </g>
        ))}
        {days.map((d, i) =>
          i % labelEvery === 0 ? (
            <text key={d.day} className="ch-label" x={cx(i)} y={H - 8} textAnchor="middle">
              {formatDay(d.day)}
            </text>
          ) : null
        )}

        {days.map((d, i) => {
          const hIn = ih - (y(d.inflow) - m.t);
          const hOut = ih - (y(d.outflow) - m.t);
          const dim = active !== null && active !== i;
          return (
            <g key={d.day} opacity={dim ? 0.45 : 1}>
              {d.inflow > 0 && <path d={barPath(cx(i) - bw - 1, y(d.inflow), bw, hIn)} fill="var(--series-1)" />}
              {d.outflow > 0 && <path d={barPath(cx(i) + 1, y(d.outflow), bw, hOut)} fill="var(--series-2)" />}
            </g>
          );
        })}

        {active === null &&
          labels.map((l) => {
            const same = labels.length === 2 && labels[0].i === labels[1].i;
            const bx = l.series === 1 ? cx(l.i) - bw / 2 - 1 : cx(l.i) + bw / 2 + 1;
            const anchor = bx < m.l + 28 ? "start" : bx > m.l + iw - 28 ? "end" : "middle";
            const dy = same && l.series === 2 ? -14 : 0;
            return (
              <text key={l.series} className="ch-end" x={bx} y={y(l.v) - 6 + dy} textAnchor={anchor}>
                {formatCompact(l.v, currency)}
              </text>
            );
          })}

        {days.map((d, i) => (
          <rect
            key={`hit-${d.day}`}
            x={m.l + slot * i}
            y={m.t}
            width={slot}
            height={ih}
            fill="transparent"
            onPointerMove={() => setActive(i)}
            onPointerLeave={() => setActive(null)}
          />
        ))}
      </svg>

      {a && active !== null && (
        <div className="tip" style={{ left: cx(active), transform: `translateX(${flip ? "calc(-100% - 12px)" : "12px"})` }}>
          <div className="tip-date">{formatDayLong(a.day)}</div>
          <div className="tip-row">
            <span className="tip-key" style={{ background: "var(--series-1)" }} />
            <strong>{formatNumber(a.inflow, currency)}</strong> in
          </div>
          <div className="tip-row">
            <span className="tip-key" style={{ background: "var(--series-2)" }} />
            <strong>{formatNumber(a.outflow, currency)}</strong> out
          </div>
        </div>
      )}
    </div>
  );
}

export function FlowLegend() {
  return (
    <ul className="legend">
      <li>
        <span className="swatch" style={{ background: "var(--series-1)" }} />
        Money in
      </li>
      <li>
        <span className="swatch" style={{ background: "var(--series-2)" }} />
        Money out
      </li>
    </ul>
  );
}

export function FlowTable({ days, currency }: { days: DayBucket[]; currency: string }) {
  return (
    <table className="data">
      <thead>
        <tr>
          <th>Day</th>
          <th className="num">Money in</th>
          <th className="num">Money out</th>
        </tr>
      </thead>
      <tbody>
        {[...days].reverse().map((d) => (
          <tr key={d.day}>
            <td>{formatDayLong(d.day)}</td>
            <td className="num">{formatNumber(d.inflow, currency)}</td>
            <td className="num">{formatNumber(d.outflow, currency)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// -------------------------------------------------------------- sparkline

export function Sparkline({ points }: { points: Point[] }) {
  const w = 96;
  const h = 34;
  const pad = 5;
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const vs = points.map((p) => p.v);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const x = (t: number) => pad + (t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * (w - pad * 2));
  const y = (v: number) => (hi === lo ? h / 2 : h - pad - ((v - lo) / (hi - lo)) * (h - pad * 2));
  let d = `M${x(points[0].t)},${y(points[0].v)}`;
  for (let i = 1; i < points.length; i++) d += ` H${x(points[i].t)} V${y(points[i].v)}`;
  const end = points[points.length - 1];
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <path d={d} className="ch-line" />
      <circle className="ch-dot" cx={x(end.t)} cy={y(end.v)} r={3.5} />
    </svg>
  );
}
