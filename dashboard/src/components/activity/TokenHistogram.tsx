import { useMemo, useState } from "react";
import type { HistogramData } from "@/lib/activity/types";
import { formatCompact } from "@/lib/activity/format";

/** Roughly the width one tick label needs in viewBox units. */
const TICK_LABEL_PX = 78;

interface Props {
  data: HistogramData;
  unit?: string;
  xLabel?: string;
  yLabel?: string;
  colorClass?: string;
}

export function TokenHistogram({
  data,
  unit = "tokens/sec",
  xLabel = "Speed (tokens/sec)",
  yLabel = "Requests",
  colorClass = "text-blue-500 dark:text-blue-400",
}: Props) {
  const height = 290;
  const padding = { top: 30, right: 20, bottom: 72, left: 104 };
  const viewBoxWidth = 1200;
  const chartWidth = viewBoxWidth - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const maxCount = useMemo(() => Math.max(...data.bins), [data]);
  const barWidth = useMemo(() => chartWidth / data.bins.length, [data, chartWidth]);
  // All values equal (one request, or one speed): the bins have no width; place everything at the
  // left edge instead of dividing by zero (the fork drew its percentile lines at NaN then).
  const range = useMemo(() => data.max - data.min || 1, [data]);

  /**
   * Bin edges to tick, thinned so labels never collide. Five fixed fractions
   * left most buckets anonymous; this labels every edge that fits.
   */
  const tickIndexes = useMemo(() => {
    const count = data.bins.length;
    if (count === 0 || range === 0) return [0];
    const stride = Math.max(1, Math.ceil(TICK_LABEL_PX / (chartWidth / count)));
    const out: number[] = [];
    for (let i = 0; i < count; i += stride) out.push(i);
    out.push(count);
    return out;
  }, [data, range, chartWidth]);

  const [selectedBin, setSelectedBin] = useState<number | null>(null);

  function selectBin(i: number) {
    setSelectedBin((prev) => (prev === i ? null : i));
  }

  function getXPosition(value: number): number {
    return padding.left + ((value - data.min) / range) * chartWidth;
  }

  const selStart = selectedBin !== null ? data.min + selectedBin * data.binSize : 0;
  const shortUnit = unit === "tokens/sec" ? "tps" : unit;
  const tickDecimals = range < 5 ? 1 : 0;

  return (
    <div className="mt-2 w-full">
      <svg
        viewBox={`0 0 ${viewBoxWidth} ${height}`}
        className="w-full h-auto"
        preserveAspectRatio="xMidYMid meet"
      >
        {/* Y-axis */}
        <line
          x1={padding.left}
          y1={padding.top}
          x2={padding.left}
          y2={height - padding.bottom}
          stroke="currentColor"
          strokeWidth={1}
          opacity={0.3}
        />

        {/* Y-axis ticks and labels */}
        {[0, 0.5, 1].map((fraction) => {
          const tickCount = Math.round(maxCount * fraction);
          const tickY = height - padding.bottom - fraction * chartHeight;
          return (
            <g key={fraction}>
              <line
                x1={padding.left - 8}
                y1={tickY}
                x2={padding.left}
                y2={tickY}
                stroke="currentColor"
                strokeWidth={1}
                opacity={0.4}
              />
              <text
                x={padding.left - 10}
                y={tickY + 10}
                fontSize={26}
                fill="currentColor"
                opacity={0.8}
                textAnchor="end"
              >
                {formatCompact(tickCount)}
              </text>
            </g>
          );
        })}

        {/* X-axis */}
        <line
          x1={padding.left}
          y1={height - padding.bottom}
          x2={viewBoxWidth - padding.right}
          y2={height - padding.bottom}
          stroke="currentColor"
          strokeWidth={1}
          opacity={0.3}
        />

        {/* Histogram bars */}
        {data.bins.map((count, i) => {
          const barHeight = maxCount > 0 ? (count / maxCount) * chartHeight : 0;
          const x = padding.left + i * barWidth;
          const y = height - padding.bottom - barHeight;
          const binStart = data.min + i * data.binSize;
          const binEnd = binStart + data.binSize;
          return (
            <g key={i} className="group">
              <rect
                x={x}
                y={y}
                width={Math.max(barWidth - 1, 1)}
                height={barHeight}
                fill="currentColor"
                className={`${colorClass} ${
                  selectedBin === i ? "opacity-100" : "opacity-60 group-hover:opacity-90"
                } transition-opacity cursor-pointer`}
              />
              <title>{`${binStart.toFixed(1)} - ${binEnd.toFixed(1)} ${unit}\nCount: ${count}`}</title>
              <rect
                x={x}
                y={padding.top}
                width={barWidth}
                height={chartHeight}
                fill="transparent"
                role="button"
                tabIndex={0}
                aria-pressed={selectedBin === i}
                aria-label={`${binStart.toFixed(1)} to ${binEnd.toFixed(1)} ${unit}, count ${count}`}
                className="cursor-pointer"
                onClick={() => selectBin(i)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    selectBin(i);
                  }
                }}
              />
            </g>
          );
        })}

        {/* Percentile lines */}
        <line
          x1={getXPosition(data.p50)}
          y1={padding.top}
          x2={getXPosition(data.p50)}
          y2={height - padding.bottom}
          stroke="currentColor"
          strokeWidth={2}
          strokeDasharray="4 2"
          opacity={0.7}
          className="text-blue-700 dark:text-blue-300"
        />

        <line
          x1={getXPosition(data.p10)}
          y1={padding.top}
          x2={getXPosition(data.p10)}
          y2={height - padding.bottom}
          stroke="currentColor"
          strokeWidth={2}
          strokeDasharray="4 2"
          opacity={0.7}
          className="text-orange-500 dark:text-orange-400"
        />

        <line
          x1={getXPosition(data.p1)}
          y1={padding.top}
          x2={getXPosition(data.p1)}
          y2={height - padding.bottom}
          stroke="currentColor"
          strokeWidth={2}
          strokeDasharray="4 2"
          opacity={0.7}
          className="text-red-500 dark:text-red-400"
        />

        {/* X-axis ticks: one per bin edge, thinned to whatever fits the width */}
        {tickIndexes.map((index) => {
          const fraction = data.bins.length > 0 ? index / data.bins.length : 0;
          const tickX = padding.left + fraction * chartWidth;
          return (
            <g key={index}>
              <line
                x1={tickX}
                y1={height - padding.bottom}
                x2={tickX}
                y2={height - padding.bottom + 8}
                stroke="currentColor"
                strokeWidth={1}
                opacity={0.4}
              />
              <text
                x={tickX}
                y={height - padding.bottom + 30}
                fontSize={26}
                fill="currentColor"
                opacity={0.8}
                textAnchor={fraction === 0 ? "start" : fraction >= 1 ? "end" : "middle"}
              >
                {(data.min + fraction * range).toFixed(tickDecimals)}
              </text>
            </g>
          );
        })}
        {/* Axis titles */}
        <text
          x={padding.left + chartWidth / 2}
          y={height - 8}
          fontSize={26}
          fill="currentColor"
          opacity={0.7}
          textAnchor="middle"
        >
          {xLabel}
        </text>
        <text
          x={22}
          y={padding.top + chartHeight / 2}
          transform={`rotate(-90, 22, ${padding.top + chartHeight / 2})`}
          fontSize={26}
          fill="currentColor"
          opacity={0.7}
          textAnchor="middle"
        >
          {yLabel}
        </text>
      </svg>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-5 border-t-2 border-dashed border-blue-700 dark:border-blue-300"></span>
          p50 ({data.p50.toFixed(1)} {shortUnit})
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-5 border-t-2 border-dashed border-orange-500 dark:border-orange-400"></span>
          p10 ({data.p10.toFixed(1)} {shortUnit})
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-5 border-t-2 border-dashed border-red-500 dark:border-red-400"></span>
          p1 ({data.p1.toFixed(1)} {shortUnit})
        </span>
        {selectedBin !== null && (
          <>
            <span className="ml-auto">
              {`${selStart.toFixed(1)} - ${(selStart + data.binSize).toFixed(1)} ${unit}`}
            </span>
            <span title={String(data.bins[selectedBin])}>
              Count: {formatCompact(data.bins[selectedBin])}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
