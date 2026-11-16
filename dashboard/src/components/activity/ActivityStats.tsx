import { useMemo } from "react";
import type { ActivityStatsData } from "@/lib/activity/types";
import { formatCompact } from "@/lib/activity/format";
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

interface Props {
  stats: ActivityStatsData | null;
}

export function ActivityStats({ stats }: Props) {
  const nf = new Intl.NumberFormat();
  const [histogramCollapsed, setHistogramCollapsed] = usePersistent<boolean>(
    "activity-histogram-collapsed",
    false,
  );

  // Per-stream decode speed drops when agents run in parallel; these measure
  // what the system as a whole produced. See lib/concurrency.ts.
  const concurrency = useMemo(
    () =>
      buildConcurrency(
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
      ),
    [stats],
  );

  // Which speed the decode charts plot. "solo" replaces each request's
  // reported speed with its solo-equivalent (lib/concurrency soloSpeeds):
  // solo requests keep their measured speed; contended requests get the
  // solo-speed model's prediction (solo requests with similar context and
  // draft acceptance). Requests with no decode timing keep their reported
  // speed.
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
  // The server's gen_histogram bins reported speeds, so the solo view bins in
  // the browser. It covers the scatter's rows (those with a context), which
  // can be a few fewer than the server histogram's.
  const genHistogram = useMemo(
    () =>
      decodeSpeedMode === "solo"
        ? buildHistogram(genPoints.map((p) => p.speed))
        : (stats?.gen_histogram ?? null),
    [decodeSpeedMode, genPoints, stats],
  );
  const decodeYLabel =
    decodeSpeedMode === "solo" ? "Solo-equivalent decode (tokens/sec)" : "Decode speed (tokens/sec)";

  return (
    <Card className="relative p-3">
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
          <div className="mb-3 flex flex-col gap-6 sm:flex-row">
            <div className="w-full min-w-0 sm:w-1/2">
              <div className="text-muted-foreground mb-1 text-sm font-medium">Prompt Processing</div>
              {stats?.prompt_scatter && stats.prompt_scatter.length > 0 && (
                <PromptPrefillScatter points={stats.prompt_scatter} />
              )}
              {stats?.prompt_scatter && stats.prompt_scatter.length > 0 ? (
                // Weighted by time, not request count: counting requests is
                // dominated by the many short prompts that cost almost nothing,
                // and hides the few long ones that own the wall clock.
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
                  onClick={() => setDecodeSpeedMode(decodeSpeedMode === "solo" ? "request" : "solo")}
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
                    decodeSpeedMode === "solo" ? "Solo-Equivalent Decode vs Context Length" : undefined
                  }
                  yLabel={decodeYLabel}
                />
              )}
              {genHistogram ? (
                <TokenHistogram data={genHistogram} unit="tokens/sec" xLabel={decodeYLabel} yLabel="Requests" />
              ) : (
                <div className="text-muted-foreground py-6 text-center text-sm">
                  No generation speed data yet
                </div>
              )}
            </div>
          </div>
          {concurrency.timed > 0 && (
            <div className="mt-3">
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
      <div className="grid grid-cols-4 gap-x-6 gap-y-1 text-sm">
        <div className="text-muted-foreground text-xs uppercase tracking-wider">Requests</div>
        <div className="text-muted-foreground text-xs uppercase tracking-wider">Cached</div>
        <div className="text-muted-foreground text-xs uppercase tracking-wider">Processed</div>
        <div className="text-muted-foreground text-xs uppercase tracking-wider">Generated</div>
        <div className="text-sm" title={nf.format(stats?.total_requests ?? 0)}>
          <span className="font-semibold">{formatCompact(stats?.total_requests ?? 0)}</span> completed
        </div>
        <div className="text-sm" title={nf.format(stats?.total_cache_tokens ?? 0)}>
          <span className="font-semibold">{formatCompact(stats?.total_cache_tokens ?? 0)}</span> tokens
        </div>
        <div className="text-sm" title={nf.format(stats?.total_input_tokens ?? 0)}>
          <span className="font-semibold">{formatCompact(stats?.total_input_tokens ?? 0)}</span> tokens
        </div>
        <div className="text-sm" title={nf.format(stats?.total_output_tokens ?? 0)}>
          <span className="font-semibold">{formatCompact(stats?.total_output_tokens ?? 0)}</span> tokens
          {concurrency.systemTps > 0 && (
            <span
              className="text-muted-foreground"
              title={`System rate: output tokens ÷ wall-clock time with any decode running. Per stream: ${formatCompact(concurrency.perStreamTps)} tok/s.`}
            >
              · {formatCompact(concurrency.systemTps)} tok/s
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}
