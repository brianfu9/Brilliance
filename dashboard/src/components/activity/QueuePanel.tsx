import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from "react";
import { cn } from "cn";
import type { FleetModel, Stats } from "@/lib/api";
import { kindOf } from "@/lib/model-kind";
import { hrefOf } from "@/lib/ui";
import type { QueueRequest, QueueSnapshot } from "@/lib/activity/types";
import { snapshotOf } from "@/lib/activity/queue";
import { formatDuration } from "@/lib/activity/format";
import {
  AgeRatchet,
  SlotAssigner,
  backfillLeftS,
  formatTokens,
  kvLayout,
  outputRoom,
  reserveTokens,
  requestKey,
  runningRequests,
  waitReason,
  waitingRequests,
} from "@/lib/activity/queueView";
import { useColumns } from "@/lib/activity/columns";
import { usePersistent } from "@/lib/activity/persist";
import { StateBadge } from "@/components/bits";
import { ChevronDown, Columns3, GripVertical, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { KV_POOL_CSS, KvPoolBar, usePrefersReducedMotion } from "./KvPoolBar";

interface QueueColumn {
  id: string;
  label: string;
  defaultVisible: boolean;
  right?: boolean;
}

const RUNNING_COLS: QueueColumn[] = [
  { id: "id", label: "Running", defaultVisible: true },
  { id: "state", label: "State", defaultVisible: true },
  { id: "cached_context", label: "cache/kv", defaultVisible: true, right: true },
  { id: "reserve", label: "Reserve", defaultVisible: true, right: true },
  { id: "output", label: "Output", defaultVisible: true, right: true },
  { id: "tps", label: "avg tok/s", defaultVisible: true, right: true },
  { id: "ttft", label: "TTFT", defaultVisible: true, right: true },
  { id: "age", label: "Age", defaultVisible: true, right: true },
];
const WAITING_COLS: QueueColumn[] = [
  { id: "id", label: "Waiting", defaultVisible: true },
  { id: "needs", label: "Needs", defaultVisible: true },
  { id: "waited", label: "Waited", defaultVisible: true, right: true },
  { id: "why", label: "Why", defaultVisible: true },
];

function labelOf(cols: QueueColumn[], colId: string): string {
  return cols.find((c) => c.id === colId)?.label ?? colId;
}
function isRight(cols: QueueColumn[], colId: string): boolean {
  return cols.find((c) => c.id === colId)?.right ?? false;
}

const QUEUE_PANEL_CSS = `${KV_POOL_CSS}
  .qp-need,
  .qp-countdown {
    position: relative;
    display: inline-block;
    height: 6px;
    border-radius: 3px;
    background: var(--q-track);
    overflow: hidden;
  }
  .qp-need {
    width: 72px;
    overflow: visible;
  }
  .qp-need::after {
    content: "";
    position: absolute;
    inset: 0 auto 0 0;
    width: var(--n);
    background: var(--q-ok);
    border-radius: 3px;
  }
  .qp-need-short::after {
    background: var(--q-crit);
  }
  .qp-need::before {
    content: "";
    position: absolute;
    top: -2px;
    bottom: -2px;
    left: var(--r);
    width: 2px;
    background: var(--foreground);
    z-index: 1;
  }
  .qp-countdown {
    width: 40px;
  }
  .qp-countdown::after {
    content: "";
    position: absolute;
    inset: 0 auto 0 0;
    width: var(--p);
    background: var(--q-warn);
    border-radius: 3px;
  }
`;

const TONE_CLASS: Record<string, string> = {
  hold: "border-[var(--q-warn)] text-[var(--q-warn-ink)]",
  blocked: "border-[var(--q-crit)] text-[var(--q-crit-ink)]",
  pending: "border-border text-muted-foreground",
  info: "border-border text-muted-foreground",
};
const TH_CLASS =
  "px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground whitespace-nowrap";
const TD_CLASS = "px-2 py-1 text-xs whitespace-nowrap";

const pct = (tokens: number, total: number) => (100 * tokens) / Math.max(1, total);

function fmtS(s: number): string {
  if (s >= 3600) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, "0")}s`;
  return `${s.toFixed(s < 10 ? 1 : 0)}s`;
}

function useColumnDrag(columnOrder: string[], setColumnOrder: (order: string[]) => void) {
  const [dragId, setDragId] = useState<string | null>(null);

  function crossedMidpoint(e: DragEvent<HTMLDivElement>, movingDown: boolean): boolean {
    const el = e.currentTarget;
    const parent = el.offsetParent as HTMLElement | null;
    if (!parent) return true;
    const top = parent.getBoundingClientRect().top - parent.scrollTop + el.offsetTop;
    const midpoint = top + el.offsetHeight / 2;
    return movingDown ? e.clientY > midpoint : e.clientY < midpoint;
  }

  function handleDragStart(e: DragEvent<HTMLDivElement>, colId: string) {
    setDragId(colId);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", colId);
    }
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>, colId: string) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (!dragId || dragId === colId) return;
    const order = [...columnOrder];
    const fromIndex = order.indexOf(dragId);
    const toIndex = order.indexOf(colId);
    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return;
    if (!crossedMidpoint(e, toIndex > fromIndex)) return;
    order.splice(fromIndex, 1);
    order.splice(toIndex, 0, dragId);
    setColumnOrder(order);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragId(null);
    setColumnOrder(columnOrder);
  }

  function handleDragEnd() {
    setDragId(null);
    setColumnOrder(columnOrder);
  }

  return { dragId, handleDragStart, handleDragOver, handleDrop, handleDragEnd };
}

type QueueItem =
  | { type: "token"; id: string; model?: FleetModel; snapshot: QueueSnapshot; hue?: string }
  | { type: "media"; id: string; model?: FleetModel; stats: Stats; hue?: string }
  | { type: "status"; id: string; model: FleetModel; hue?: string };

interface Props {
  /** Single-model mode: pre-built snapshot (token-scheduled). */
  snapshot?: QueueSnapshot | null;
  /** Single-model mode: optional FleetModel metadata (for media/loading/waiting views). */
  model?: FleetModel;
  /** Single-model mode: raw live Stats (for media jobs when snapshot is null). */
  stats?: Stats | null;
  /** Multi-model fleet mode: all non-adapter fleet models. */
  models?: FleetModel[];
  /** Multi-model fleet mode: per-model live Stats from `/history?activity=1`. */
  modelStats?: Record<string, Stats>;
  /** Multi-model fleet mode: performance.now() timestamp when each model's Stats was received. */
  modelStatsReceivedAt?: Record<string, number>;
  /** Optional model id -> CSS color map. */
  hueOf?: Map<string, string>;
  storagePrefix: string;
}

/**
 * Live request queue panel — supports both multi-model parallel Overview mode (`models` + `modelStats`)
 * and single-model Requests tab mode (`snapshot` / `model` / `stats`). Uses a single shared
 * `requestAnimationFrame` clock across all active model sections.
 */
export function QueuePanel({
  snapshot = null,
  model,
  stats = null,
  models,
  modelStats,
  modelStatsReceivedAt,
  hueOf,
  storagePrefix,
}: Props) {
  const isFleetMode = models !== undefined;
  const reducedMotion = usePrefersReducedMotion();

  const runningCols = useColumns(`${storagePrefix}-queue-running`, RUNNING_COLS);
  const waitingCols = useColumns(`${storagePrefix}-queue-waiting`, WAITING_COLS);
  const runningDrag = useColumnDrag(runningCols.columnOrder, runningCols.setColumnOrder);
  const waitingDrag = useColumnDrag(waitingCols.columnOrder, waitingCols.setColumnOrder);

  const [open, setOpen] = usePersistent<boolean>(`${storagePrefix}-queue-open`, true);

  const items = useMemo<QueueItem[]>(() => {
    if (isFleetMode) {
      const relevant = (models ?? []).filter(
        (m) =>
          m.adapter !== true &&
          (m.state === "resident" ||
            m.state === "loading" ||
            m.state === "waiting" ||
            (m.in_flight ?? 0) > 0 ||
            (m.waiting ?? 0) > 0),
      );
      const rank = (m: FleetModel) => {
        if ((m.in_flight ?? 0) > 0 || (m.waiting ?? 0) > 0) return 0;
        if (m.state === "loading" || m.state === "waiting") return 1;
        return 2;
      };
      const sorted = relevant.slice().sort((a, b) => rank(a) - rank(b));
      const out: QueueItem[] = [];
      for (const m of sorted) {
        const hue = hueOf?.get(m.id);
        const s = modelStats?.[m.id] ?? null;
        const [kind] = kindOf(m.capabilities);
        if ((kind === "chat" || kind === "embed") && s && s.kv_tokens_total !== undefined) {
          const snap = snapshotOf(m.id, s, modelStatsReceivedAt?.[m.id] ?? 0);
          if (snap) {
            out.push({ type: "token", id: m.id, model: m, snapshot: snap, hue });
            continue;
          }
        }
        if (s && (kind === "gen" || s.kv_tokens_total === undefined)) {
          out.push({ type: "media", id: m.id, model: m, stats: s, hue });
          continue;
        }
        if (m.state === "loading" || m.state === "waiting" || (m.waiting ?? 0) > 0 || (m.in_flight ?? 0) > 0) {
          out.push({ type: "status", id: m.id, model: m, hue });
        }
      }
      return out;
    }

    // Single-model mode
    const hue = model ? hueOf?.get(model.id) : undefined;
    const [kind] = kindOf(model?.capabilities);
    if (snapshot && (kind === "chat" || kind === "embed")) {
      return [{ type: "token", id: snapshot.model, model, snapshot, hue }];
    }
    if (stats && (kind === "gen" || stats.kv_tokens_total === undefined)) {
      return [{ type: "media", id: model?.id ?? stats.model, model, stats, hue }];
    }
    if (snapshot) {
      return [{ type: "token", id: snapshot.model, model, snapshot, hue }];
    }
    if (model && (model.state === "loading" || model.state === "waiting" || (model.waiting ?? 0) > 0)) {
      return [{ type: "status", id: model.id, model, hue }];
    }
    return [];
  }, [isFleetMode, models, modelStats, modelStatsReceivedAt, hueOf, snapshot, model, stats]);

  const tokenSnapshots = useMemo(
    () => items.filter((it): it is Extract<QueueItem, { type: "token" }> => it.type === "token").map((it) => it.snapshot),
    [items],
  );
  const hasTickingWork = tokenSnapshots.some((s) => s.requests.length > 0);

  // Single shared requestAnimationFrame clock for all active model sections.
  const [nowMs, setNowMs] = useState(() => performance.now());
  useEffect(() => {
    if (!open || !hasTickingWork) return;
    let raf = 0;
    const tick = () => {
      setNowMs(performance.now());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [open, hasTickingWork]);

  const ages = useMemo(() => new AgeRatchet(), []);
  useEffect(() => {
    const keys: string[] = [];
    for (const s of tokenSnapshots) {
      for (const r of s.requests) {
        const k = requestKey(s.model, r);
        keys.push(k, `h:${k}`);
      }
    }
    ages.prune(keys);
  }, [tokenSnapshots, ages]);

  const runningVisible = runningCols.columnOrder.filter(
    (id) => runningCols.columnVisibility[id] !== false,
  );
  const waitingVisible = waitingCols.columnOrder.filter(
    (id) => waitingCols.columnVisibility[id] !== false,
  );

  let totalRunning = 0;
  let totalWaiting = 0;
  for (const it of items) {
    if (it.type === "token") {
      totalRunning += runningRequests(it.snapshot).length;
      totalWaiting += waitingRequests(it.snapshot).length;
    } else if (it.type === "media") {
      totalRunning += it.stats.jobs?.running ?? 0;
      totalWaiting += it.model?.waiting ?? 0;
    } else {
      totalRunning += it.model.in_flight ?? 0;
      totalWaiting += it.model.waiting ?? 0;
    }
  }

  if (items.length === 0) {
    if (!isFleetMode) {
      return <div className="text-muted-foreground text-sm">No queue data</div>;
    }
    return (
      <Card className="qp relative p-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="text-muted-foreground text-xs uppercase tracking-wider">Request Queue</span>
          <span className="text-xs text-muted-foreground">No models loaded</span>
        </div>
      </Card>
    );
  }

  const hasTokenSection = tokenSnapshots.length > 0;
  const multiSection = items.length > 1;

  return (
    <Card className="qp relative p-3">
      <style>{QUEUE_PANEL_CSS}</style>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pr-16 text-sm">
        <span className="text-muted-foreground text-xs uppercase tracking-wider">Request Queue</span>
        <span>
          <span className="font-semibold tabular-nums">{totalRunning}</span> running
        </span>
        <span>
          <span className="font-semibold tabular-nums">{totalWaiting}</span> waiting
        </span>
        {isFleetMode && items.length > 1 && (
          <span className="text-xs text-muted-foreground tabular-nums">
            across {items.length} active models
          </span>
        )}
      </div>
      <div className="absolute right-2 top-2 flex items-center gap-1">
        {hasTokenSection && (
          <DropdownMenu>
            <DropdownMenuTrigger
              className="text-muted-foreground hover:bg-muted inline-flex size-6 items-center justify-center rounded-full"
              title="Select queue columns"
            >
              <Columns3 className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[18rem] max-h-[50vh] overflow-y-auto p-0">
              <DropdownMenuLabel className="text-muted-foreground border-b px-3 py-2 text-xs font-medium uppercase tracking-wider">
                Columns{" "}
                <span className="text-[10px] normal-case tracking-normal">(drag to reorder)</span>
              </DropdownMenuLabel>
              <DropdownMenuGroup>
                <div className="text-muted-foreground bg-muted/50 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider">
                  Running
                </div>
                {runningCols.columnOrder.map((colId) => (
                  <div
                    key={colId}
                    draggable="true"
                    role="button"
                    tabIndex={-1}
                    aria-label={`Drag to reorder ${labelOf(RUNNING_COLS, colId)}`}
                    onDragStart={(e) => runningDrag.handleDragStart(e, colId)}
                    onDragOver={(e) => runningDrag.handleDragOver(e, colId)}
                    onDrop={runningDrag.handleDrop}
                    onDragEnd={runningDrag.handleDragEnd}
                    className={runningDrag.dragId === colId ? "opacity-40" : ""}
                  >
                    <DropdownMenuCheckboxItem
                      checked={runningCols.columnVisibility[colId] !== false}
                      onCheckedChange={(visible) =>
                        runningCols.setColumnVisibility({
                          ...runningCols.columnVisibility,
                          [colId]: visible,
                        })
                      }
                    >
                      <GripVertical className="text-muted-foreground/50 size-4 cursor-grab active:cursor-grabbing" />
                      <span className="flex-1">{labelOf(RUNNING_COLS, colId)}</span>
                    </DropdownMenuCheckboxItem>
                  </div>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <div className="text-muted-foreground bg-muted/50 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider">
                  Waiting
                </div>
                {waitingCols.columnOrder.map((colId) => (
                  <div
                    key={colId}
                    draggable="true"
                    role="button"
                    tabIndex={-1}
                    aria-label={`Drag to reorder ${labelOf(WAITING_COLS, colId)}`}
                    onDragStart={(e) => waitingDrag.handleDragStart(e, colId)}
                    onDragOver={(e) => waitingDrag.handleDragOver(e, colId)}
                    onDrop={waitingDrag.handleDrop}
                    onDragEnd={waitingDrag.handleDragEnd}
                    className={waitingDrag.dragId === colId ? "opacity-40" : ""}
                  >
                    <DropdownMenuCheckboxItem
                      checked={waitingCols.columnVisibility[colId] !== false}
                      onCheckedChange={(visible) =>
                        waitingCols.setColumnVisibility({
                          ...waitingCols.columnVisibility,
                          [colId]: visible,
                        })
                      }
                    >
                      <GripVertical className="text-muted-foreground/50 size-4 cursor-grab active:cursor-grabbing" />
                      <span className="flex-1">{labelOf(WAITING_COLS, colId)}</span>
                    </DropdownMenuCheckboxItem>
                  </div>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground rounded-full"
          onClick={() => setOpen(!open)}
          title={open ? "Hide the request queue" : "Show the request queue"}
        >
          {open ? <X /> : <ChevronDown />}
        </Button>
      </div>

      {open ? (
        <div className="mt-3 flex flex-col gap-3">
          {items.map((it) => {
            if (it.type === "token") {
              return (
                <TokenQueueSection
                  key={it.id}
                  snap={it.snapshot}
                  hue={it.hue}
                  linkToModel={isFleetMode}
                  collapseIdle={multiSection}
                  nowMs={nowMs}
                  ages={ages}
                  reducedMotion={reducedMotion}
                  runningVisible={runningVisible}
                  waitingVisible={waitingVisible}
                />
              );
            }
            if (it.type === "media") {
              return (
                <MediaQueueSection
                  key={it.id}
                  id={it.id}
                  model={it.model}
                  stats={it.stats}
                  hue={it.hue}
                  linkToModel={isFleetMode}
                />
              );
            }
            return (
              <StatusQueueSection
                key={it.id}
                model={it.model}
                hue={it.hue}
                linkToModel={isFleetMode}
              />
            );
          })}
        </div>
      ) : null}
    </Card>
  );
}

function ModelTitle({ id, hue, linkToModel }: { id: string; hue?: string; linkToModel: boolean }) {
  const content = (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium">
      {hue && <i className="size-2 shrink-0 rounded-full" style={{ background: hue }} />}
      {id}
    </span>
  );
  if (!linkToModel) return content;
  return (
    <a href={hrefOf(id)} className="hover:underline">
      {content}
    </a>
  );
}

function TokenQueueSection({
  snap,
  hue,
  linkToModel,
  collapseIdle,
  nowMs,
  ages,
  reducedMotion,
  runningVisible,
  waitingVisible,
}: {
  snap: QueueSnapshot;
  hue?: string;
  linkToModel: boolean;
  collapseIdle: boolean;
  nowMs: number;
  ages: AgeRatchet;
  reducedMotion: boolean;
  runningVisible: string[];
  waitingVisible: string[];
}) {
  const maxSeqs = snap.max_num_seqs ?? 4;
  const assigner = useMemo(() => new SlotAssigner(maxSeqs), [maxSeqs]);
  const running = useMemo(() => runningRequests(snap), [snap]);
  const waiting = useMemo(() => waitingRequests(snap), [snap]);
  const slots = useMemo(
    () => assigner.assign(running.map((r) => requestKey(snap.model, r))),
    [snap.model, assigner, running],
  );

  const l = kvLayout(snap);
  const policy = snap.queue;
  const dt = snap.client_received_at_ms && snap.client_received_at_ms > 0
    ? Math.max(0, (nowMs - snap.client_received_at_ms) / 1000)
    : 0;
  const hasElasticCarve =
    typeof snap.kv_tokens_max === "number" && snap.kv_tokens_max > snap.kv_tokens_total;

  function slotOf(r: QueueRequest): number {
    return slots.get(requestKey(snap.model, r)) ?? 0;
  }

  function renderRunningCell(r: QueueRequest, colId: string): ReactNode {
    const prefill = r.state === "prefill";
    const reserveGap = reserveTokens(r);
    const prefillLeft = Math.max(0, r.prompt - r.computed);
    switch (colId) {
      case "id":
        return (
          <span className="inline-flex items-center gap-2">
            <span
              className="qp-key qp-held"
              style={{ "--c": `var(--q-s${(slotOf(r) % 8) + 1})` } as CSSProperties}
            />
            <span className="font-mono">#{r.id}</span>
          </span>
        );
      case "state":
        if (prefill) {
          const done = r.prompt > 0 ? r.computed / r.prompt : 0;
          return `prefill ${(done * 100).toFixed(0)}%`;
        }
        return "decode";
      case "cached_context":
        return (
          <>
            {formatTokens(r.cached)}
            <span className="text-muted-foreground">/{formatTokens(r.kv_tokens)}</span>
          </>
        );
      case "reserve":
        if (prefill && prefillLeft > 0 && reserveGap > 0) {
          return (
            <span title="the prompt still to compute, plus the gate's output room">
              prefill {formatTokens(prefillLeft)} + out{" "}
              {formatTokens(outputRoom(r, policy?.kv_reserve ?? 0))}
            </span>
          );
        }
        if (reserveGap > 0) return formatTokens(reserveGap);
        return "—";
      case "output":
        return (
          <>
            {formatTokens(r.output)}
            <span className="text-muted-foreground"> / {formatTokens(r.max)}</span>
          </>
        );
      case "tps":
        return r.tps > 0 ? r.tps.toFixed(1) : "—";
      case "ttft":
        return r.ttft_s !== undefined ? fmtS(r.ttft_s) : "—";
      case "age":
        return fmtS(ages.age(requestKey(snap.model, r), r.age_s + dt));
      default:
        return null;
    }
  }

  function renderWaitingCell(
    r: QueueRequest,
    colId: string,
    age: number,
    held: number | undefined,
  ): ReactNode {
    const why = waitReason(r, l, policy?.backfill_ms ?? 0, held);
    const need = r.admit_tokens ?? 0;
    const left = backfillLeftS(r, policy?.backfill_ms ?? 0, held);
    switch (colId) {
      case "id":
        return (
          <span className="font-mono">
            <span className="text-muted-foreground">{(r.queue_pos ?? 0) + 1}.</span> #{r.id}
          </span>
        );
      case "needs":
        if (need > 0) {
          return (
            <span className="inline-flex items-center gap-2 tabular-nums">
              <span
                className={cn("qp-need", need > l.room && "qp-need-short")}
                title={`needs ${formatTokens(need)}; the gate has ${formatTokens(l.room)} free`}
                style={
                  {
                    "--n": `${Math.min(100, pct(need, l.total)).toFixed(1)}%`,
                    "--r": `${pct(l.room, l.total).toFixed(1)}%`,
                  } as CSSProperties
                }
              />
              {formatTokens(need)}
            </span>
          );
        }
        return <span className="tabular-nums">{formatTokens(r.prompt)}</span>;
      case "waited":
        return fmtS(age);
      case "why":
        return (
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className={cn("rounded-full border px-2 py-px text-[11px] font-medium", TONE_CLASS[why.tone])}>
              {why.label}
            </span>
            {left !== null && left > 0 && (
              <span
                className="qp-countdown"
                style={
                  { "--p": `${(100 * left / ((policy?.backfill_ms ?? 1) / 1000)).toFixed(1)}%` } as CSSProperties
                }
                title="backfill window left"
              />
            )}
            {why.detail ? <span className="text-muted-foreground">{why.detail}</span> : null}
          </span>
        );
      default:
        return null;
    }
  }

  const hideEmptyTable = collapseIdle && running.length === 0 && waiting.length === 0;

  return (
    <section
      className="border-t pt-3 first:border-t-0 first:pt-0"
      aria-label={`Queue for ${snap.model}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
        <ModelTitle id={snap.model} hue={hue} linkToModel={linkToModel} />
        <span className="tabular-nums">
          KV <span className="font-semibold">{formatTokens(snap.kv_tokens_used)}</span> /{" "}
          {formatTokens(snap.kv_tokens_total)}{" "}
          <span className="text-muted-foreground">
            ({pct(snap.kv_tokens_used, snap.kv_tokens_total).toFixed(0)}% held,{" "}
            {formatTokens(l.cache)} of it cache)
          </span>
        </span>
        {hasElasticCarve && (
          <span
            className="rounded border px-1.5 py-px text-[11px] text-muted-foreground tabular-nums"
            title="Virtual KV carve capacity; the bar and gate room use the live elastic capacity"
          >
            elastic · carve {formatTokens(snap.kv_tokens_max!)}
          </span>
        )}
        <span className="tabular-nums">
          gate room <span className="font-semibold">{formatTokens(l.room)}</span>
        </span>
        {snap.decode_tps > 0 && (
          <span className="tabular-nums">{snap.decode_tps.toFixed(0)} tok/s decode</span>
        )}
        <span className="tabular-nums text-muted-foreground">
          {snap.preemptions} preemptions
        </span>
        {policy && (
          <span className="text-muted-foreground ml-auto">
            {policy.kv_reserve > 0
              ? `reserve ${formatTokens(policy.kv_reserve)} · backfill ${(policy.backfill_ms / 1000).toFixed(0)}s`
              : "KV-fit gate off"}
          </span>
        )}
      </div>

      <KvPoolBar snapshot={snap} slots={slots} />

      {hideEmptyTable ? (
        <div className="mt-2 text-xs text-muted-foreground">Idle — nothing running</div>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <Table className="min-w-full">
            <TableHeader>
              <TableRow>
                {runningVisible.map((colId) => (
                  <TableHead key={colId} className={cn(TH_CLASS, isRight(RUNNING_COLS, colId) && "text-right")}>
                    {labelOf(RUNNING_COLS, colId)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {running.length > 0 ? (
                running.map((r) => (
                  <FlipRow key={r.id} animate={!reducedMotion}>
                    {runningVisible.map((colId) => (
                      <TableCell
                        key={colId}
                        className={cn(TD_CLASS, isRight(RUNNING_COLS, colId) && "text-right")}
                      >
                        {renderRunningCell(r, colId)}
                      </TableCell>
                    ))}
                  </FlipRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={Math.max(runningVisible.length, 1)} className={cn(TD_CLASS, "text-muted-foreground")}>
                    Nothing running
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {waiting.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <Table className="min-w-full">
            <TableHeader>
              <TableRow>
                {waitingVisible.map((colId) => (
                  <TableHead key={colId} className={cn(TH_CLASS, isRight(WAITING_COLS, colId) && "text-right")}>
                    {labelOf(WAITING_COLS, colId)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {waiting.map((r) => {
                const key = requestKey(snap.model, r);
                const age = ages.age(key, r.age_s + dt);
                const held =
                  r.held_s !== undefined ? ages.age(`h:${key}`, r.held_s + dt) : undefined;
                return (
                  <FlipRow key={r.id} animate={!reducedMotion}>
                    {waitingVisible.map((colId) => (
                      <TableCell
                        key={colId}
                        className={cn(
                          TD_CLASS,
                          isRight(WAITING_COLS, colId) && "text-right",
                          colId === "why" && "whitespace-normal",
                        )}
                      >
                        {renderWaitingCell(r, colId, age, held)}
                      </TableCell>
                    ))}
                  </FlipRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function MediaQueueSection({
  id,
  model,
  stats,
  hue,
  linkToModel,
}: {
  id: string;
  model?: FleetModel;
  stats: Stats;
  hue?: string;
  linkToModel: boolean;
}) {
  const jobs = stats.jobs ?? { running: 0, done: 0, failed: 0, total_ms: 0, last_ms: 0 };
  const meanMs = jobs.done > 0 ? jobs.total_ms / jobs.done : 0;
  const fleetWaiting = model?.waiting ?? 0;

  return (
    <section
      className="border-t pt-3 first:border-t-0 first:pt-0"
      aria-label={`Jobs for ${id}`}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <ModelTitle id={id} hue={hue} linkToModel={linkToModel} />
        {model && <StateBadge state={model.state} doing={model.doing} />}
        <span className="tabular-nums">
          <span className="font-semibold">{jobs.running}</span> active
        </span>
        {fleetWaiting > 0 && (
          <span className="tabular-nums">
            <span className="font-semibold">{fleetWaiting}</span> queued
          </span>
        )}
        <span className="tabular-nums text-muted-foreground">
          {jobs.done} done{jobs.failed > 0 ? ` (${jobs.failed} failed)` : ""}
        </span>
        {jobs.last_ms > 0 && (
          <span className="tabular-nums text-muted-foreground">
            last {formatDuration(jobs.last_ms)}
          </span>
        )}
        {meanMs > 0 && (
          <span className="tabular-nums text-muted-foreground">
            mean {formatDuration(meanMs)}
          </span>
        )}
      </div>
    </section>
  );
}

function StatusQueueSection({
  model,
  hue,
  linkToModel,
}: {
  model: FleetModel;
  hue?: string;
  linkToModel: boolean;
}) {
  const detail =
    model.state === "loading"
      ? model.doing
        ? `loading (${model.doing})…`
        : "loading…"
      : model.state === "waiting"
        ? `waiting for ${model.waiting_for ?? "VRAM"}`
        : model.doing ?? model.state;

  return (
    <section
      className="border-t pt-3 first:border-t-0 first:pt-0"
      aria-label={`Status for ${model.id}`}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <ModelTitle id={model.id} hue={hue} linkToModel={linkToModel} />
        <StateBadge state={model.state} doing={model.doing} />
        <span className="text-muted-foreground">{detail}</span>
        {(model.waiting ?? 0) > 0 && (
          <span className="tabular-nums">
            <span className="font-semibold">{model.waiting}</span> waiting
          </span>
        )}
      </div>
    </section>
  );
}

function FlipRow({ animate, children }: { animate: boolean; children: ReactNode }) {
  const ref = useRef<HTMLTableRowElement | null>(null);
  const prevTop = useRef<number | null>(null);
  const animating = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onEnd = (event: TransitionEvent) => {
      if (event.propertyName !== "transform") return;
      el.style.transform = "";
      el.style.transition = "";
      animating.current = false;
    };
    el.addEventListener("transitionend", onEnd);
    return () => el.removeEventListener("transitionend", onEnd);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const top = el.offsetTop;
    const prev = prevTop.current;
    prevTop.current = top;
    if (!animate || prev === null || prev === top) return;
    if (animating.current) {
      el.style.transform = "";
      el.style.transition = "";
      animating.current = false;
    }
    el.style.transition = "none";
    el.style.transform = `translateY(${prev - top}px)`;
    void el.offsetHeight;
    el.style.transition = "transform 200ms ease";
    el.style.transform = "translateY(0)";
    animating.current = true;
  });

  return <TableRow ref={ref}>{children}</TableRow>;
}
