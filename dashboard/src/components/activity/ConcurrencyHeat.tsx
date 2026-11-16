import { useEffect, useMemo, useRef } from "react";
import { Chart, ScatterController, PointElement, LineElement, LinearScale, Title, Tooltip } from "chart.js";
import type { TooltipItem } from "chart.js";
import type { ConcurrencyData, ConcurrencyLevel } from "@/lib/activity/concurrency";
import { useTheme } from "@/lib/ui";
import { Card, CardContent } from "@/components/ui/card";
import { formatCompact } from "@/lib/activity/format";
import { heatmapPlugin, setHeatmapState, type HeatCell, type HeatGrid } from "@/lib/activity/heatmap";
import {
  densityThresholds,
  densityColor,
  densityRamp,
  latestSession,
  shortSession,
  LATEST_DARK,
  LATEST_LIGHT,
} from "@/lib/activity/scatterColor";

Chart.register(ScatterController, PointElement, LineElement, LinearScale, Title, Tooltip, heatmapPlugin);

const Y_BINS = 16;
/** Half the column width, in k units. */
const HALF = 0.42;

export function ConcurrencyHeat({ data }: { data: ConcurrencyData }) {
  // Decode speed against concurrency. Columns are k, the number of decodes
  // running at once; cells are per-request decode speed density, each request
  // placed at its time-weighted mean k. Per-stream speed falls as k rises; the
  // solid line is what the whole system produced at that k across all
  // sessions, the dashed line the same rate while only the latest session's
  // requests were decoding. A flat solid line means more agents gain nothing.

  const dark = useTheme() === "dark";
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart<"scatter"> | null>(null);

  // Always the speed each request actually decoded at, never the solo-equivalent
  // estimate: the system line is the sum of the running streams' real rates, so
  // only real per-stream speeds put it about k times the column.
  const speedOf = (p: { speed: number }) => p.speed;

  // The latest session's requests, drawn as individual dots on top of the
  // density cells, as in DecodeScatter. Points keep the endpoint's
  // oldest-to-newest order, so the last one with a session is the latest.
  const latest = useMemo(() => latestSession(data.points.map((p) => p.session)), [data]);
  const overlay = useMemo(() => (latest === "" ? [] : data.points.filter((p) => p.session === latest)), [data, latest]);

  /**
   * The latest session's system line: per k, the system rate averaged over
   * that session's decodes placed in column k, weighted by decode time like
   * the all-sessions system line.
   */
  const sessionLine = useMemo(() => {
    if (overlay.length === 0) return [] as { k: number; systemTps: number }[];
    const byK = new Map<number, { ms: number; tokens: number }>();
    for (const p of overlay) {
      const e = byK.get(p.k) ?? { ms: 0, tokens: 0 };
      e.ms += p.activeMs;
      e.tokens += p.systemSpeed * p.activeMs;
      byK.set(p.k, e);
    }
    return [...byK.entries()]
      .map(([k, { ms, tokens }]) => ({ k, systemTps: tokens / ms }))
      .sort((a, b) => a.k - b.k);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay]);

  /** Column-aligned grid: one column per whole k, y binned over speed. */
  const grid = useMemo<HeatGrid>(() => {
    const pts = data.points;
    if (pts.length === 0) return { cells: [], maxCount: 0 };
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) {
      const v = speedOf(p);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const step = (hi - lo) / Y_BINS;
    const counts = new Map<string, { k: number; iy: number; count: number }>();
    for (const p of pts) {
      const iy = step > 0 ? Math.min(Y_BINS - 1, Math.floor((speedOf(p) - lo) / step)) : 0;
      const key = `${p.k}:${iy}`;
      const c = counts.get(key) ?? { k: p.k, iy, count: 0 };
      c.count++;
      counts.set(key, c);
    }
    const cells: HeatCell[] = [];
    let maxCount = 0;
    for (const { k, iy, count } of counts.values()) {
      const y0 = lo + iy * step;
      const y1 = step > 0 ? y0 + step : y0;
      cells.push({ x0: k - HALF, x1: k + HALF, y0, y1, cx: k, cy: (y0 + y1) / 2, count, accept: -1 });
      if (count > maxCount) maxCount = count;
    }
    cells.sort((a, b) => a.count - b.count);
    return { cells, maxCount };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const thresholds = useMemo(() => densityThresholds(grid.cells.map((c) => c.count)), [grid]);

  /** A request's rounded mean k never exceeds the highest level seen. */
  const xMax = useMemo(() => Math.max(1, data.maxK), [data]);

  /** Y range covers the cells and both system lines. */
  const yMax = useMemo(() => {
    let top = 0;
    for (const p of data.points) top = Math.max(top, speedOf(p));
    for (const l of data.levels) top = Math.max(top, l.systemTps);
    for (const s of sessionLine) top = Math.max(top, s.systemTps);
    return top > 0 ? Math.ceil((top * 1.12) / 20) * 20 : 20;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, sessionLine]);

  function getChartColors(dark: boolean) {
    return {
      grid: dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)",
      tick: dark ? "#9ca3af" : "#6b7280",
      tooltipBg: dark ? "#1f2937" : "#ffffff",
      tooltipText: dark ? "#f3f4f6" : "#111827",
      tooltipBorder: dark ? "#374151" : "#e5e7eb",
      system: dark ? "#4ade80" : "#16a34a",
      latest: dark ? LATEST_DARK : LATEST_LIGHT,
    };
  }

  function levelOf(item: TooltipItem<"scatter">): ConcurrencyLevel | undefined {
    const dataset = item.dataset as unknown as { levels?: ConcurrencyLevel[] };
    return dataset.levels?.[item.dataIndex];
  }

  function sessionLineOf(item: TooltipItem<"scatter">): { k: number; systemTps: number } | undefined {
    const dataset = item.dataset as unknown as { sessionLine?: { k: number; systemTps: number }[] };
    return dataset.sessionLine?.[item.dataIndex];
  }

  function busyLabel(ms: number): string {
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
    return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  }

  function buildOptions(dark: boolean) {
    const colors = getChartColors(dark);
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false as const,
      interaction: { mode: "nearest" as const, intersect: false },
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: "Decode Speed vs Concurrency",
          color: colors.tick,
        },
        tooltip: {
          backgroundColor: colors.tooltipBg,
          titleColor: colors.tooltipText,
          bodyColor: colors.tooltipText,
          borderColor: colors.tooltipBorder,
          borderWidth: 1,
          // Only the two system lines explain themselves; the density cells
          // and the latest session's dots are drawn, not hoverable.
          filter: (item: TooltipItem<"scatter">) =>
            levelOf(item) !== undefined || sessionLineOf(item) !== undefined,
          callbacks: {
            title: (items: TooltipItem<"scatter">[]) => {
              const item = items[0];
              if (!item) return "";
              const sl = sessionLineOf(item);
              if (sl) return `latest session ${shortSession(latest)}`;
              const level = levelOf(item);
              return level ? `${level.k} decoding at once` : "";
            },
            label: (item: TooltipItem<"scatter">) => {
              const sl = sessionLineOf(item);
              if (sl) {
                return `system: ${formatCompact(sl.systemTps)} tok/s while this session's requests ran at k = ${sl.k}`;
              }
              const level = levelOf(item);
              if (level) {
                const lines = [`system: ${formatCompact(level.systemTps)} tok/s`];
                if (level.speedup > 0) lines.push(`speedup vs solo: ${level.speedup.toFixed(2)}×`);
                if (level.k > 1 && level.slowdown > 0)
                  lines.push(`per-stream slowdown: ${level.slowdown.toFixed(2)}×`);
                if (level.perStreamMedian > 0)
                  lines.push(`per-stream median: ${formatCompact(level.perStreamMedian)} tok/s`);
                lines.push(
                  `busy: ${busyLabel(level.busyMs)} (${(level.share * 100).toFixed(1)}%) · ${level.requests} req`,
                );
                return lines;
              }
              return "";
            },
          },
        },
      },
      scales: {
        x: {
          type: "linear" as const,
          min: 0.5,
          max: xMax + 0.5,
          title: { display: true, text: "Decodes running at once (k)", color: colors.tick },
          // The axis runs half a column past each end, so generated ticks
          // would land on the .5 edges; pin them to the whole-k centers.
          afterBuildTicks: (axis: { ticks: { value: number }[] }) => {
            axis.ticks = Array.from({ length: xMax }, (_, i) => ({ value: i + 1 }));
          },
          ticks: { color: colors.tick },
          grid: { color: colors.grid },
        },
        y: {
          type: "linear" as const,
          min: 0,
          max: yMax,
          title: {
            display: true,
            text: "Decode speed (tokens/sec)",
            color: colors.tick,
          },
          ticks: { color: colors.tick, callback: (v: number | string) => formatCompact(Number(v)) },
          grid: { color: colors.grid },
        },
      },
    };
  }

  function buildData(dark: boolean, heat: HeatGrid) {
    const colors = getChartColors(dark);
    const levels = data.levels;
    const datasets: unknown[] = [
      {
        // Invisible anchors the heatmapPlugin paints its cells at.
        label: "Requests",
        data: heat.cells.map((cell) => ({ x: cell.cx, y: cell.cy })),
        cells: heat.cells,
        pointRadius: 0,
        pointHoverRadius: 0,
        backgroundColor: "transparent",
        borderColor: "transparent",
      },
    ];
    if (sessionLine.length > 0) {
      datasets.push({
        label: `latest session ${shortSession(latest)} (system)`,
        data: sessionLine.map((s) => ({ x: s.k, y: s.systemTps })),
        sessionLine,
        showLine: true,
        borderColor: colors.latest,
        borderDash: [6, 4],
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 0,
      });
    }
    datasets.push({
      label: "system",
      data: levels.map((l) => ({ x: l.k, y: l.systemTps })),
      levels,
      showLine: true,
      borderColor: colors.system,
      backgroundColor: colors.system,
      borderWidth: 2.5,
      pointRadius: 3.5,
      pointHoverRadius: 6,
    });
    if (overlay.length > 0) {
      // Pushed last so the dots draw over the system line's points, which
      // would otherwise sit on top of them.
      datasets.push({
        label: `latest session ${shortSession(latest)}`,
        // Placed at each request's true mean k, inside its rounded column.
        data: overlay.map((p) => ({ x: p.meanK, y: speedOf(p) })),
        backgroundColor: colors.latest,
        borderWidth: 0,
        pointRadius: 2.5,
        pointHoverRadius: 0,
      });
    }
    return { datasets };
  }

  function sync(dark: boolean, heat: HeatGrid, bounds: number[]) {
    const chart = chartRef.current;
    if (!chart) return;
    setHeatmapState(chart, { grid: heat, colorFor: (cell) => densityColor(cell.count, bounds, dark) });
    chart.options = buildOptions(dark) as typeof chart.options;
    chart.data = buildData(dark, heat) as typeof chart.data;
    chart.update("none");
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const chart = new Chart(canvas, {
      type: "scatter",
      data: buildData(dark, grid) as never,
      options: buildOptions(dark) as never,
    });
    chartRef.current = chart;
    sync(dark, grid, thresholds);
    return () => {
      chart.destroy();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    sync(dark, grid, thresholds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dark, grid, thresholds, xMax, yMax, sessionLine, overlay, latest, data]);

  return (
    <Card className="h-[300px] select-none py-0">
      <CardContent className="flex h-full flex-col p-4">
        <div className="min-h-0 flex-1">
          <canvas ref={canvasRef} />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex items-center gap-1">
            <span className="text-muted-foreground text-xs">1</span>
            {densityRamp(dark).map((step) => (
              <span key={step} className="inline-block size-2" style={{ background: step }} />
            ))}
            <span className="text-muted-foreground text-xs" title={`shade steps top out at: ${thresholds.join(", ")} requests`}>
              {formatCompact(grid.maxCount)} req/cell (per stream)
            </span>
          </span>
          {overlay.length > 0 && (
            <span className="flex items-center gap-1">
              <span
                className="inline-block size-2 rounded-full"
                style={{ background: getChartColors(dark).latest }}
              />
              <span className="text-muted-foreground text-xs">latest session {shortSession(latest)}</span>
            </span>
          )}
          <span className="flex items-center gap-1">
            <span className="inline-block w-4 border-t-[3px]" style={{ borderColor: getChartColors(dark).system }} />
            <span className="text-muted-foreground text-xs">system</span>
          </span>
          {sessionLine.length > 0 && (
            <span className="flex items-center gap-1">
              <span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: getChartColors(dark).latest }} />
              <span className="text-muted-foreground text-xs">latest session {shortSession(latest)} (system)</span>
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
