import { useMemo } from "react";
import type { ActivityStatsData, RequestKind } from "@/lib/activity/types";
import { formatCompact, formatDuration } from "@/lib/activity/format";
import { usePersistent } from "@/lib/activity/persist";
import { TokenHistogram } from "./TokenHistogram";
import { PrefillTimeHistogram } from "./PrefillTimeHistogram";
import { PromptPrefillScatter } from "./PromptPrefillScatter";
import { DecodeScatter } from "./DecodeScatter";
import { ConcurrencyHeat } from "./ConcurrencyHeat";
import { buildConcurrency } from "@/lib/activity/concurrency";
import { buildHistogram } from "@/lib/activity/histogram";
import { ChevronDown, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export interface DistModelOption {
  id: string;
  count: number;
  kind: RequestKind;
}

interface Props {
  stats: ActivityStatsData | null;
  /** Kind of the records plotted in the distribution charts. Defaults to "chat". */
  kind?: RequestKind;
  /** Intervals of other models on the same accelerator, excluded from solo baselines. */
  otherIntervals?: readonly { start: number; end: number }[];
  /** Fleet-wide summary stats for the totals row when in "All models" mode. */
  summaryStats?: ActivityStatsData | null;
  /** When viewing "All models", currently selected model for distributions. */
  distModel?: string;
  /** Candidate models for the inline distributions picker. */
  distModels?: DistModelOption[];
  onDistModelChange?: (id: string) => void;
  /** Total records available on the server (when paged). */
  totalAvailable?: number;
  /** Number of records currently loaded and summarized. */
  shownCount?: number;
}

const isMediaKind = (k: RequestKind | undefined) =>
  k === "image" || k === "video" || k === "tts" || k === "shape";

export function ActivityStats({
  stats,
  kind = "chat",
  otherIntervals,
  summaryStats,
  distModel,
  distModels,
  onDistModelChange,
  totalAvailable,
  shownCount,
}: Props) {
  const nf = new Intl.NumberFormat();
  const [histogramCollapsed, setHistogramCollapsed] = usePersistent<boolean>(
    "activity-histogram-collapsed",
    false,
  );

  const media = isMediaKind(kind);
  const asr = kind === "asr";

  // Per-stream decode speed drops when agents run in parallel; these measure
  // what the system as a whole produced. See lib/activity/concurrency.ts.
  const concurrency = useMemo(
    () =>
      media
        ? buildConcurrency([])
        : buildConcurrency(
            (stats?.gen_scatter ?? []).map((p) => ({
              endMs: p.end_ms,
              decodeMs: p.decode_ms,
              preemptedMs: p.preempted_ms,
              output: p.output,
              speed: p.speed,
              session: p.session,
              context: p.context,
              accept: p.accept,
            })),
            otherIntervals,
          ),
    [stats, media, otherIntervals],
  );

  const [decodeSpeedMode, setDecodeSpeedMode] = usePersistent<"request" | "solo">(
    "activity-decode-speed-mode",
    "request",
  );
  const SOLO_TITLE =
    "Estimated tok/s had this request run alone: solo requests as measured; contended ones predicted from solo requests with similar context and draft acceptance.";
  const genPoints = useMemo(() => {
    const points = stats?.gen_scatter ?? [];
    if (decodeSpeedMode !== "solo") return points;
    return points.map((p, i) => {
      const solo = concurrency.soloSpeeds[i];
      return Number.isFinite(solo) ? { ...p, speed: solo } : p;
    });
  }, [stats, decodeSpeedMode, concurrency]);

  const genHistogram = useMemo(
    () =>
      decodeSpeedMode === "solo"
        ? buildHistogram(genPoints.map((p) => p.speed))
        : (stats?.gen_histogram ?? null),
    [decodeSpeedMode, genPoints, stats],
  );
  const decodeYLabel =
    decodeSpeedMode === "solo" ? "Solo-equivalent decode (tokens/sec)" : "Decode speed (tokens/sec)";

  const totals = summaryStats ?? stats;
  const showMediaTotals = media && !summaryStats;
  const completedCount = Math.max(
    0,
    (totals?.total_requests ?? 0) - (totals?.failed_requests ?? 0) - (totals?.aborted_requests ?? 0),
  );
  const isPartial =
    typeof totalAvailable === "number" &&
    typeof shownCount === "number" &&
    shownCount > 0 &&
    shownCount < totalAvailable;

  return (
    <Card className="relative p-3">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 pr-8">
        {distModels && distModels.length > 0 && onDistModelChange && (
          <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>Distributions:</span>
            <select
              value={distModel ?? distModels[0]?.id ?? ""}
              onChange={(e) => onDistModelChange(e.target.value)}
              className="rounded-md border bg-background px-2 py-0.5 text-xs font-medium text-foreground"
              aria-label="Model for distribution charts"
            >
              {distModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id} ({m.count.toLocaleString()})
                </option>
              ))}
            </select>
          </label>
        )}
        {isPartial && (
          <span className="rounded-md border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground tabular-nums">
            Stats over newest {shownCount!.toLocaleString()} of {totalAvailable!.toLocaleString()}
          </span>
        )}
      </div>

      <Button
        variant="ghost"
        size="icon-xs"
        className="text-muted-foreground absolute right-2 top-2 rounded-full"
        onClick={() => setHistogramCollapsed(!histogramCollapsed)}
        title={histogramCollapsed ? "Show histograms" : "Hide histograms"}
      >
        {histogramCollapsed ? <ChevronDown /> : <X />}
      </Button>

      {!histogramCollapsed && (
        <>
          {media ? (
            <div className="mb-3 w-full min-w-0 sm:w-1/2">
              <div className="text-muted-foreground mb-1 text-sm font-medium">
                Generation Duration
              </div>
              {stats?.duration_histogram ? (
                <TokenHistogram
                  data={stats.duration_histogram}
                  unit="s"
                  xLabel="Duration (seconds)"
                  yLabel="Requests"
                />
              ) : (
                <div className="text-muted-foreground py-6 text-center text-sm">
                  No duration data yet
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="mb-3 flex flex-col gap-6 sm:flex-row">
                <div className="w-full min-w-0 sm:w-1/2">
                  <div className="text-muted-foreground mb-1 text-sm font-medium">
                    Prompt Processing
                  </div>
                  {stats?.prompt_scatter && stats.prompt_scatter.length > 0 && (
                    <PromptPrefillScatter points={stats.prompt_scatter} />
                  )}
                  {stats?.prompt_scatter && stats.prompt_scatter.length > 0 ? (
                    <PrefillTimeHistogram
                      samples={stats.prompt_scatter.map((p) => ({
                        speed: p.speed,
                        prefillMs: p.prefill_ms,
                      }))}
                    />
                  ) : (
                    <div className="text-muted-foreground py-6 text-center text-sm">
                      No prompt speed data yet
                    </div>
                  )}
                </div>
                <div className="w-full min-w-0 sm:w-1/2">
                  <div className="text-muted-foreground mb-1 flex items-center gap-2 text-sm font-medium">
                    Token Generation
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-muted-foreground font-normal"
                      onClick={() =>
                        setDecodeSpeedMode(decodeSpeedMode === "solo" ? "request" : "solo")
                      }
                      title={
                        decodeSpeedMode === "solo"
                          ? `Solo-equivalent: ${SOLO_TITLE} Click for per request.`
                          : "Per request: the request's own reported speed. Click for solo-equivalent."
                      }
                    >
                      Speed: {decodeSpeedMode === "solo" ? "solo-equivalent" : "per request"}
                    </Button>
                  </div>
                  {genPoints.length > 0 && (
                    <DecodeScatter
                      points={genPoints}
                      title={
                        decodeSpeedMode === "solo"
                          ? "Solo-Equivalent Decode vs Context Length"
                          : undefined
                      }
                      yLabel={decodeYLabel}
                    />
                  )}
                  {genHistogram ? (
                    <TokenHistogram
                      data={genHistogram}
                      unit="tokens/sec"
                      xLabel={decodeYLabel}
                      yLabel="Requests"
                    />
                  ) : (
                    <div className="text-muted-foreground py-6 text-center text-sm">
                      No generation speed data yet
                    </div>
                  )}
                </div>
              </div>

              {asr && (stats?.total_audio_s ?? 0) > 0 && (
                <div className="mt-3 mb-3">
                  <div className="text-muted-foreground mb-1 flex flex-wrap items-baseline gap-x-4 text-sm">
                    <span className="font-medium">Real-Time Factor</span>
                    {(stats?.median_rtf ?? 0) > 0 && (
                      <span title="Median audio seconds transcribed per wall-clock second">
                        median{" "}
                        <span className="text-foreground font-semibold">
                          {stats!.median_rtf!.toFixed(1)}×
                        </span>{" "}
                        realtime
                      </span>
                    )}
                    <span>
                      total audio{" "}
                      <span className="text-foreground font-semibold">
                        {formatDuration((stats?.total_audio_s ?? 0) * 1000)}
                      </span>
                    </span>
                  </div>
                  {stats?.rtf_histogram && (
                    <div className="w-full min-w-0 sm:w-1/2">
                      <TokenHistogram
                        data={stats.rtf_histogram}
                        unit="×"
                        xLabel="Real-Time Factor (audio s / wall s)"
                        yLabel="Requests"
                        colorClass="text-emerald-500 dark:text-emerald-400"
                      />
                    </div>
                  )}
                </div>
              )}

              {concurrency.timed > 0 && (
                <div className="mt-3 mb-3">
                  <div className="text-muted-foreground mb-1 flex flex-wrap items-baseline gap-x-4 text-sm">
                    <span className="font-medium">Parallel Decode</span>
                    <span title="Output tokens ÷ wall-clock time with any decode running">
                      system{" "}
                      <span className="text-foreground font-semibold">
                        {formatCompact(concurrency.systemTps)}
                      </span>{" "}
                      tok/s
                    </span>
                    <span title="Output tokens ÷ summed per-request decode time">
                      per-stream {formatCompact(concurrency.perStreamTps)} tok/s
                    </span>
                    <span title="Summed decode time ÷ wall-clock time with any decode running">
                      avg {concurrency.meanConcurrency.toFixed(2)}× concurrent
                    </span>
                    {concurrency.levels.length > 1 && (
                      <span>
                        {concurrency.levels
                          .filter((l) => l.k > 1 && l.speedup > 0)
                          .map((l) => `${l.k}: ${l.speedup.toFixed(2)}×`)
                          .join(" · ")}
                      </span>
                    )}
                    {concurrency.coRunMs > 0 && (
                      <span
                        className="text-xs text-muted-foreground"
                        title="Segments overlapping another model on the same card were excluded from the solo baseline (using fleet card assignment as proxy)"
                      >
                        excluded {formatDuration(concurrency.coRunMs)} co-run (by card)
                      </span>
                    )}
                  </div>
                  {concurrency.maxK > 1 ? (
                    <div className="w-full min-w-0 sm:w-1/2">
                      <ConcurrencyHeat data={concurrency} />
                    </div>
                  ) : (
                    <div className="text-muted-foreground py-2 text-sm">
                      No decodes have overlapped yet, so system and per-stream rates are equal.
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}

      {showMediaTotals ? (
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          <div className="text-muted-foreground text-xs uppercase tracking-wider">Completed</div>
          <div className="text-muted-foreground text-xs uppercase tracking-wider">Failed / Aborted</div>
          <div className="text-muted-foreground text-xs uppercase tracking-wider">Median / Mean</div>
          <div className="text-muted-foreground text-xs uppercase tracking-wider">Total GPU Time</div>
          <div className="text-sm" title={nf.format(completedCount)}>
            <span className="font-semibold">{formatCompact(completedCount)}</span> completed
          </div>
          <div className="text-sm">
            <span className="font-semibold">{formatCompact(totals?.failed_requests ?? 0)}</span>{" "}
            failed ·{" "}
            <span className="font-semibold">{formatCompact(totals?.aborted_requests ?? 0)}</span>{" "}
            aborted
          </div>
          <div className="text-sm tabular-nums">
            <span className="font-semibold">
              {(totals?.median_duration_ms ?? 0) > 0
                ? formatDuration(totals!.median_duration_ms!)
                : "–"}
            </span>
            <span className="text-muted-foreground">
              {" "}
              /{" "}
              {(totals?.mean_duration_ms ?? 0) > 0
                ? formatDuration(totals!.mean_duration_ms!)
                : "–"}
            </span>
          </div>
          <div className="text-sm tabular-nums">
            <span className="font-semibold">
              {(totals?.total_duration_ms ?? 0) > 0
                ? formatDuration(totals!.total_duration_ms!)
                : "–"}
            </span>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          <div className="text-muted-foreground text-xs uppercase tracking-wider">Requests</div>
          <div className="text-muted-foreground text-xs uppercase tracking-wider">Cached</div>
          <div className="text-muted-foreground text-xs uppercase tracking-wider">Processed</div>
          <div className="text-muted-foreground text-xs uppercase tracking-wider">Generated</div>
          <div className="text-sm" title={nf.format(totals?.total_requests ?? 0)}>
            <span className="font-semibold">{formatCompact(totals?.total_requests ?? 0)}</span>{" "}
            completed
            {((totals?.failed_requests ?? 0) > 0 || (totals?.aborted_requests ?? 0) > 0) && (
              <span className="text-muted-foreground">
                {" "}
                ({totals?.failed_requests ?? 0} err
                {(totals?.aborted_requests ?? 0) > 0 ? `, ${totals?.aborted_requests} abort` : ""})
              </span>
            )}
          </div>
          <div className="text-sm" title={nf.format(totals?.total_cache_tokens ?? 0)}>
            <span className="font-semibold">{formatCompact(totals?.total_cache_tokens ?? 0)}</span>{" "}
            tokens
          </div>
          <div className="text-sm" title={nf.format(totals?.total_input_tokens ?? 0)}>
            <span className="font-semibold">{formatCompact(totals?.total_input_tokens ?? 0)}</span>{" "}
            tokens
          </div>
          <div className="text-sm" title={nf.format(totals?.total_output_tokens ?? 0)}>
            <span className="font-semibold">{formatCompact(totals?.total_output_tokens ?? 0)}</span>{" "}
            tokens
            {!summaryStats && concurrency.systemTps > 0 && (
              <span
                className="text-muted-foreground"
                title={`System rate: output tokens ÷ wall-clock time with any decode running. Per stream: ${formatCompact(concurrency.perStreamTps)} tok/s.`}
              >
                {" "}
                · {formatCompact(concurrency.systemTps)} tok/s
              </span>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
