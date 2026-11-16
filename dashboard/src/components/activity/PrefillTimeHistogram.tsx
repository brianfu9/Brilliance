import { useMemo, useState } from "react";
import { buildPrefillTime, type PrefillSample } from "@/lib/activity/prefillTime";
import { formatCompact } from "@/lib/activity/format";

/** Roughly the width one tick label needs in viewBox units. */
const TICK_LABEL_PX = 78;

interface Props {
  samples: PrefillSample[];
  colorClass?: string;
}

export function PrefillTimeHistogram({
  samples,
  colorClass = "text-blue-500 dark:text-blue-400",
}: Props) {
  const height = 290;
  const padding = { top: 30, right: 20, bottom: 72, left: 104 };
  const viewBoxWidth = 1200;
  const chartWidth = viewBoxWidth - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const data = useMemo(() => buildPrefillTime(samples), [samples]);
  const barWidth = useMemo(
    () => (data.bins.length > 0 ? chartWidth / data.bins.length : chartWidth),
    [data, chartWidth],
  );

  /**
   * Bin edges to tick, thinned so labels never collide: every edge when they
   * fit, otherwise every 2nd, 3rd, ... The final edge is always included so
   * the axis states its upper bound.
   */
  const tickIndexes = useMemo(() => {
    const count = data.bins.length;
    if (count === 0) return [];
    const stride = Math.max(1, Math.ceil(TICK_LABEL_PX / (chartWidth / count)));
    const out: number[] = [];
    for (let i = 0; i < count; i += stride) out.push(i);
    out.push(count);
    return out;
  }, [data, chartWidth]);

  /** Share of total prefill time held by the tallest bin, as a percent. */
  const maxPercent = useMemo(
    () => (data.totalSeconds > 0 ? (data.maxSeconds / data.totalSeconds) * 100 : 0),
    [data],
  );

  const [selectedBin, setSelectedBin] = useState<number | null>(null);

  function selectBin(i: number) {
    setSelectedBin((prev) => (prev === i ? null : i));
  }

  /** Speed axis bounds, taken from the bin edges the bars are drawn on. */
  const axisLo = useMemo(() => (data.bins.length > 0 ? data.bins[0].lo : 0), [data]);
  const axisHi = useMemo(
    () => (data.bins.length > 0 ? data.bins[data.bins.length - 1].hi : 0),
    [data],
  );

  /** X pixel for a speed, clamped into the plot so a marker never escapes. */
  function speedX(speed: number): number {
    const span = axisHi - axisLo;
    if (span <= 0) return padding.left;
    const ratio = Math.min(1, Math.max(0, (speed - axisLo) / span));
    return padding.left + ratio * chartWidth;
  }

  const markers = useMemo(
    () => [
      { label: "p50", speed: data.p50, className: "text-blue-700 dark:text-blue-300" },
      { label: "p10", speed: data.p10, className: "text-orange-500 dark:text-orange-400" },
      { label: "p1", speed: data.p1, className: "text-red-500 dark:text-red-400" },
    ],
    [data],
  );

  /** Axis/readout label for a bin's speed range. */
  function rangeLabel(index: number): string {
    const bin = data.bins[index];
    if (!bin) return "";
    return `${formatCompact(bin.lo)}–${formatCompact(bin.hi)} tokens/sec`;
  }

  /**
   * Durations here span six orders of magnitude - a single short prefill is
   * milliseconds while the running total is hours - so this carries its own
   * formatter rather than formatDuration, which tops out at minutes and would
   * render a five-hour total as "293m 39.3s".
   */
  function secondsLabel(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return "0";
    if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
  }

  const selBin = selectedBin !== null ? data.bins[selectedBin] : undefined;

  return (
    <div className="mt-2 w-full">
      {data.bins.length === 0 ? (
        <div className="text-muted-foreground py-6 text-center text-sm">
          {data.untimed > 0
            ? `No prefill timings yet (${formatCompact(data.untimed)} requests without timing data)`
            : "No prefill timing data yet"}
        </div>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${viewBoxWidth} ${height}`}
            className="w-full h-auto"
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label="Total prefill seconds by prefill speed"
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
              const tickPercent = maxPercent * fraction;
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
                    {fraction === 0 ? "0" : `${tickPercent.toFixed(0)}%`}
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

            {/* Bars: height is SUMMED prefill seconds, not request count */}
            {data.bins.map((bin, i) => {
              const barHeight = data.maxSeconds > 0 ? (bin.seconds / data.maxSeconds) * chartHeight : 0;
              const x = padding.left + i * barWidth;
              const y = height - padding.bottom - barHeight;
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
                  <title>
                    {`${rangeLabel(i)}\n${secondsLabel(bin.seconds)} total prefill (${(bin.share * 100).toFixed(1)}%)\n${bin.count} requests, ${secondsLabel(bin.meanSeconds)} each`}
                  </title>
                  <rect
                    x={x}
                    y={padding.top}
                    width={barWidth}
                    height={chartHeight}
                    fill="transparent"
                    role="button"
                    tabIndex={0}
                    aria-pressed={selectedBin === i}
                    aria-label={`${rangeLabel(i)}, ${secondsLabel(bin.seconds)} total prefill, ${bin.count} requests`}
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

            {/* Percentile markers, weighted by prefill time (see PrefillTimeData) */}
            {markers
              .filter((marker) => marker.speed > 0)
              .map((marker) => (
                <line
                  key={marker.label}
                  x1={speedX(marker.speed)}
                  y1={padding.top}
                  x2={speedX(marker.speed)}
                  y2={height - padding.bottom}
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeDasharray="4 2"
                  opacity={0.7}
                  className={marker.className}
                />
              ))}

            {/* X-axis ticks: one per bin edge, thinned to whatever fits the width */}
            {tickIndexes.map((index) => {
              const last = index >= data.bins.length;
              const tickX = padding.left + (index / data.bins.length) * chartWidth;
              const edge = last
                ? data.bins[data.bins.length - 1].hi
                : data.bins[index].lo;
              const fraction = index / data.bins.length;
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
                    {formatCompact(edge)}
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
              Prefill speed (tokens/sec)
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
              % of prefill time
            </text>
          </svg>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-5 border-t-2 border-dashed border-blue-700 dark:border-blue-300"></span>
              p50 ({formatCompact(data.p50)} tps)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-5 border-t-2 border-dashed border-orange-500 dark:border-orange-400"></span>
              p10 ({formatCompact(data.p10)} tps)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-5 border-t-2 border-dashed border-red-500 dark:border-red-400"></span>
              p1 ({formatCompact(data.p1)} tps)
            </span>
            <span title="Percentiles are weighted by prefill time, not request count">by time</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            {data.untimed > 0 && (
              <span title="Requests with no llama-server prompt_ms; excluded from the totals above">
                {formatCompact(data.untimed)} untimed
              </span>
            )}
            {selectedBin !== null && selBin && (
              <>
                <span className="ml-auto">{rangeLabel(selectedBin)}</span>
                <span>
                  {secondsLabel(selBin.seconds)} ({(selBin.share * 100).toFixed(1)}%) · {selBin.count} req · {secondsLabel(selBin.meanSeconds)} each
                </span>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
