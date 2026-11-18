import { useEffect, useMemo, useRef } from "react";
import {
  Chart,
  ScatterController,
  PointElement,
  LinearScale,
  Title,
  Tooltip,
} from "chart.js";
import type { TooltipItem } from "chart.js";
import type { PromptScatterPoint } from "@/lib/activity/types";
import { useTheme } from "@/lib/ui";
import { Card, CardContent } from "@/components/ui/card";
import { formatCompact } from "@/lib/activity/format";
import {
  axisFill,
  buildHeatGrid,
  gridSize,
  heatmapPlugin,
  setHeatmapState,
  type HeatCell,
  type HeatGrid,
} from "@/lib/activity/heatmap";
import {
  densityAlpha,
  densityThresholds,
  latestSession,
  newTokensColor,
  NEW_TOKEN_LABELS,
  withAlpha,
  shortSession,
  LATEST_DARK,
  LATEST_LIGHT,
} from "@/lib/activity/scatterColor";

Chart.register(
  ScatterController,
  PointElement,
  LinearScale,
  Title,
  Tooltip,
  heatmapPlugin,
);

interface Props {
  points: PromptScatterPoint[];
}

// x is the context the prefill ran against (cached + new tokens), not the new tokens alone: an agent
// turn sends 2-4k new tokens at any context, so on that axis half of all requests share one narrow
// column, while prefill speed falls by ~45% from 30k to 200k of context. The new tokens become the
// cell's hue (geometric mean of its requests) and the request count its opacity.
const xOf = (p: PromptScatterPoint) => (p.context !== undefined && p.context > 0 ? p.context : p.length);

export function PromptPrefillScatter({ points }: Props) {
  const dark = useTheme() === "dark";
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart<"scatter"> | null>(null);

  const latest = useMemo(() => latestSession(points.map((p) => p.session ?? "")), [points]);
  const overlay = useMemo(() => (latest === "" ? [] : points.filter((p) => (p.session ?? "") === latest)), [points, latest]);
  const grid = useMemo(
    () =>
      buildHeatGrid(
        points.map((p) => ({ x: xOf(p), y: p.speed, size: p.length })),
        {
          xScale: "linear",
          ...gridSize(points.length, axisFill(points.map((p) => p.speed))),
        },
      ),
    [points],
  );

  function getChartColors(dark: boolean) {
    return {
      grid: dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)",
      tick: dark ? "#9ca3af" : "#6b7280",
      legend: dark ? "#d1d5db" : "#374151",
      tooltipBg: dark ? "#1f2937" : "#ffffff",
      tooltipText: dark ? "#f3f4f6" : "#111827",
      tooltipBorder: dark ? "#374151" : "#e5e7eb",
      latest: dark ? LATEST_DARK : LATEST_LIGHT,
    };
  }

  // Ramp steps are assigned by rank, so each shade carries a comparable slice
  // of the cells whatever the distribution looks like. See densityThresholds.
  const thresholds = useMemo(() => densityThresholds(grid.cells.map((c) => c.count)), [grid]);

  function cellColorFor(bounds: number[], dark: boolean) {
    return (cell: HeatCell) => withAlpha(newTokensColor(cell.size, dark), densityAlpha(cell.count, bounds));
  }

  function cellOf(item: TooltipItem<"scatter">): HeatCell | undefined {
    const dataset = item.dataset as unknown as { cells?: HeatCell[] };
    return dataset.cells?.[item.dataIndex];
  }

  function overlayPointOf(item: TooltipItem<"scatter">): PromptScatterPoint | undefined {
    const dataset = item.dataset as unknown as { sourcePoints?: PromptScatterPoint[] };
    return dataset.sourcePoints?.[item.dataIndex];
  }

  function buildOptions(dark: boolean) {
    const colors = getChartColors(dark);
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false as const,
      interaction: {
        // See DecodeScatter: a regular grid of cell centers makes "nearest
        // without intersect" resolve to the containing cell.
        mode: "nearest" as const,
        intersect: false,
      },
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: "Prefill Speed vs Context Length",
          color: colors.legend,
          font: { size: 14, weight: "bold" as const },
        },
        tooltip: {
          backgroundColor: colors.tooltipBg,
          titleColor: colors.tooltipText,
          bodyColor: colors.tooltipText,
          borderColor: colors.tooltipBorder,
          borderWidth: 1,
          displayColors: false,
          callbacks: {
            title: (items: TooltipItem<"scatter">[]) => {
              const item = items[0];
              if (!item) return "";
              const point = overlayPointOf(item);
              if (point) return `${formatCompact(xOf(point))} context tokens`;
              const cell = cellOf(item);
              if (!cell) return "";
              return `${formatCompact(cell.x0)}–${formatCompact(cell.x1)} context tokens`;
            },
            label: (item: TooltipItem<"scatter">) => {
              const point = overlayPointOf(item);
              if (point) {
                return [
                  `${point.speed.toFixed(1)} tokens/sec`,
                  `${formatCompact(point.length)} new tokens`,
                  `latest session ${shortSession(point.session ?? "")}`,
                ];
              }
              const cell = cellOf(item);
              if (!cell) return "";
              return [
                `${cell.y0.toFixed(1)}–${cell.y1.toFixed(1)} tokens/sec`,
                `${formatCompact(cell.count)} request${cell.count === 1 ? "" : "s"}`,
                ...(cell.size > 0 ? [`~${formatCompact(Math.round(cell.size))} new tokens (geometric mean)`] : []),
              ];
            },
          },
        },
      },
      scales: {
        x: {
          type: "linear" as const,
          beginAtZero: true,
          ticks: {
            color: colors.tick,
            minRotation: 90,
            maxRotation: 90,
            autoSkip: true,
            maxTicksLimit: 8,
            font: { size: 10 },
            callback: (value: string | number) => formatCompact(Number(value)),
          },
          grid: { color: colors.grid },
          title: { display: true, text: "Context (tokens)", color: colors.tick },
        },
        y: {
          beginAtZero: true,
          ticks: { color: colors.tick, font: { size: 10 } },
          grid: { color: colors.grid },
          title: { display: true, text: "Prefill speed (tokens/sec)", color: colors.tick },
        },
      },
    };
  }

  function buildData(dark: boolean, heat: HeatGrid) {
    const colors = getChartColors(dark);
    const datasets: unknown[] = [
      {
        // Invisible hit-test layer; heatmapPlugin paints the cells themselves.
        label: "Requests",
        data: heat.cells.map((cell) => ({ x: cell.cx, y: cell.cy })),
        cells: heat.cells,
        pointRadius: 0,
        pointHoverRadius: 0,
        backgroundColor: "transparent",
        borderColor: "transparent",
      },
    ];
    if (overlay.length > 0) {
      datasets.push({
        label: `latest session ${shortSession(latest)}`,
        data: overlay.map((p) => ({ x: xOf(p), y: p.speed })),
        sourcePoints: overlay,
        backgroundColor: colors.latest,
        borderWidth: 0,
        pointRadius: 2.5,
        pointHoverRadius: 5,
      });
    }
    return { datasets };
  }

  function sync(dark: boolean, heat: HeatGrid, bounds: number[]) {
    const chart = chartRef.current;
    if (!chart) return;
    setHeatmapState(chart, { grid: heat, colorFor: cellColorFor(bounds, dark) });
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
    setHeatmapState(chart, { grid, colorFor: cellColorFor(thresholds, dark) });
    chart.update("none");

    return () => {
      chart.destroy();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    sync(dark, grid, thresholds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dark, grid, thresholds, overlay, latest]);

  return (
    <Card className="h-[300px] select-none py-0">
      <CardContent className="flex h-full flex-col p-4">
        <div className="min-h-0 flex-1">
          <canvas ref={canvasRef} />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span
            className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5"
            title={`fainter = fewer requests; opacity steps top out at ${thresholds.join(", ")} requests (max ${formatCompact(grid.maxCount)}/cell)`}
          >
            <span className="text-muted-foreground whitespace-nowrap text-xs">new tokens</span>
            {NEW_TOKEN_LABELS.map((label, i) => (
              <span key={label} className="flex items-center gap-0.5 whitespace-nowrap">
                <span
                  className="inline-block size-2"
                  style={{ background: newTokensColor([1000, 3000, 6000, 16000, 64000][i], dark) }}
                />
                <span className="text-muted-foreground text-xs">{label}</span>
              </span>
            ))}
            <span className="text-muted-foreground whitespace-nowrap text-xs">· fainter = fewer</span>
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
        </div>
      </CardContent>
    </Card>
  );
}
