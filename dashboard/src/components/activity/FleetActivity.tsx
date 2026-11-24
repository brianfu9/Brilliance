import { memo, useMemo, useState } from "react";
import type { FleetModel } from "@/lib/api";
import { sameCardMatcher } from "@/lib/model-kind";
import { buildStats, toEntry, type RequestKind, type RequestRecord } from "@/lib/activity/records";
import { ActivityStats, type DistModelOption } from "./ActivityStats";
import { ActivityTable } from "./ActivityTable";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Download, Lock } from "lucide-react";

export interface FleetActivityProps {
  records: RequestRecord[];
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadOlder?: () => void;
  models: FleetModel[];
  hueOf: Map<string, string>;
  selectedModel: string | null;
  onSelectModel?: (model: string | null) => void;
  storagePrefix: string;
  forbidden?: boolean;
  singleModelMode?: boolean;
  /** Pre-fetched other-model intervals (used on the per-model Requests tab). */
  externalOtherIntervals?: readonly { start: number; end: number }[];
}

function inferKindFromCapabilities(caps?: Record<string, unknown>): RequestKind {
  if (caps?.image_generation || caps?.image_edit) return "image";
  if (caps?.video_generation) return "video";
  if (caps?.audio_generation) return "tts";
  if (caps?.shape_generation) return "shape";
  if (caps?.audio && !caps?.chat) return "asr";
  return "chat";
}

/**
 * Memoized fleet/model activity section: model filter pills, paging ("Load older"),
 * adaptive stats/histograms (with inline per-model distribution selector in All-models mode
 * and cross-model contention exclusion), finished-requests table, and JSON export.
 */
export const FleetActivity = memo(function FleetActivity({
  records,
  total,
  hasMore,
  loadingMore,
  onLoadOlder,
  models,
  hueOf,
  selectedModel,
  onSelectModel,
  storagePrefix,
  forbidden = false,
  singleModelMode = false,
  externalOtherIntervals,
}: FleetActivityProps) {
  const [distModelChoice, setDistModelChoice] = useState<string>("");

  const modelSummaries = useMemo(() => {
    const counts = new Map<string, number>();
    const kinds = new Map<string, RequestKind>();
    for (const r of records) {
      const id = r.fm || r.model;
      if (!id) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
      kinds.set(id, r.kind);
    }
    const configuredIds = models.filter((m) => m.adapter !== true).map((m) => m.id);
    const seen = new Set<string>(configuredIds);
    const orderedIds = [...configuredIds];
    for (const id of counts.keys()) {
      if (!seen.has(id)) {
        seen.add(id);
        orderedIds.push(id);
      }
    }
    const byId = new Map(models.map((m) => [m.id, m]));
    return orderedIds.map((id) => ({
      id,
      count: counts.get(id) ?? 0,
      kind: kinds.get(id) ?? inferKindFromCapabilities(byId.get(id)?.capabilities),
      color: hueOf.get(id) ?? "var(--muted-foreground)",
    }));
  }, [records, models, hueOf]);

  const distModels = useMemo<DistModelOption[]>(
    () =>
      modelSummaries
        .filter((m) => m.count > 0)
        .sort((a, b) => b.count - a.count)
        .map(({ id, count, kind }) => ({ id, count, kind })),
    [modelSummaries],
  );

  const filtered = useMemo(
    () =>
      selectedModel
        ? records.filter((r) => (r.fm || r.model) === selectedModel)
        : records,
    [records, selectedModel],
  );

  const effectiveDistModel = selectedModel
    ? selectedModel
    : distModels.some((m) => m.id === distModelChoice)
      ? distModelChoice
      : (distModels[0]?.id ?? "");

  const activeKind = useMemo<RequestKind>(() => {
    const found = modelSummaries.find((m) => m.id === effectiveDistModel);
    if (found) return found.kind;
    if (filtered.length > 0) return filtered[filtered.length - 1].kind;
    return "chat";
  }, [modelSummaries, effectiveDistModel, filtered]);

  const distRecords = useMemo(() => {
    if (selectedModel) return filtered;
    if (!effectiveDistModel) return [];
    return records.filter((r) => (r.fm || r.model) === effectiveDistModel);
  }, [selectedModel, filtered, effectiveDistModel, records]);

  const distStats = useMemo(() => buildStats(distRecords, activeKind), [distRecords, activeKind]);
  const summaryStats = useMemo(
    () => (selectedModel === null ? buildStats(records) : null),
    [selectedModel, records],
  );

  const otherIntervals = useMemo(() => {
    if (externalOtherIntervals) return externalOtherIntervals;
    if (!effectiveDistModel) return undefined;
    const isOtherSameCard = sameCardMatcher(effectiveDistModel, models);
    const out: { start: number; end: number }[] = [];
    for (const r of records) {
      const fm = r.fm || r.model;
      if (!fm || !isOtherSameCard(fm)) continue;
      const end = r.t1;
      const start = r.dms > 0 ? end - r.dms : r.t0;
      if (end > start && start > 0) out.push({ start, end });
    }
    return out;
  }, [externalOtherIntervals, effectiveDistModel, models, records]);

  const entries = useMemo(
    () => filtered.map((r) => toEntry(r, r.fm || r.model || selectedModel || "")),
    [filtered, selectedModel],
  );

  if (forbidden) {
    return (
      <Card className="flex items-center gap-3 p-4 text-sm text-muted-foreground">
        <Lock className="size-4 shrink-0" />
        <div>
          <div className="font-medium text-foreground">
            Operator access required to view request history
          </div>
          <div className="text-xs">
            Sign in with an API key or open the dashboard from the local host.
          </div>
        </div>
      </Card>
    );
  }

  function save() {
    const blob = new Blob([JSON.stringify(filtered, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = selectedModel ? `${selectedModel}-requests.json` : "fleet-requests.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  return (
    <div className="flex flex-col gap-3">
      {!singleModelMode && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => onSelectModel?.(null)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
              selectedModel === null
                ? "border-primary bg-primary/10 font-medium text-foreground"
                : "border-border bg-background text-muted-foreground hover:bg-muted"
            }`}
          >
            <span>All models</span>
            <span className="tabular-nums opacity-75">{records.length.toLocaleString()}</span>
          </button>
          {modelSummaries.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onSelectModel?.(selectedModel === m.id ? null : m.id)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                selectedModel === m.id
                  ? "border-primary bg-primary/10 font-medium text-foreground"
                  : "border-border bg-background text-muted-foreground hover:bg-muted"
              }`}
            >
              <i className="size-2 shrink-0 rounded-full" style={{ background: m.color }} />
              <span>{m.id}</span>
              <span className="tabular-nums opacity-75">{m.count.toLocaleString()}</span>
            </button>
          ))}
          {hasMore && onLoadOlder && (
            <Button
              variant="outline"
              size="xs"
              className="ml-auto"
              onClick={onLoadOlder}
              disabled={loadingMore}
            >
              {loadingMore
                ? "Loading…"
                : `Load older (${records.length.toLocaleString()} / ${total.toLocaleString()})`}
            </Button>
          )}
        </div>
      )}

      <ActivityTable
        metrics={entries}
        storagePrefix={storagePrefix}
        title="Finished requests"
        emptyMessage="No finished requests kept yet"
        hueOf={singleModelMode ? undefined : hueOf}
      />

      <div className="-mt-1 flex justify-end">
        <Button variant="outline" size="sm" onClick={save} disabled={!filtered.length}>
          <Download />
          Export JSON
        </Button>
      </div>

      <ActivityStats
        stats={distStats}
        kind={activeKind}
        otherIntervals={otherIntervals}
        summaryStats={summaryStats}
        distModel={selectedModel === null ? effectiveDistModel : undefined}
        distModels={selectedModel === null ? distModels : undefined}
        onDistModelChange={selectedModel === null ? setDistModelChoice : undefined}
        totalAvailable={selectedModel === null ? total : undefined}
        shownCount={selectedModel === null ? records.length : undefined}
      />
    </div>
  );
});
