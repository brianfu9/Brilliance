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
import type { QueueRequest, QueueSnapshot } from "@/lib/activity/types";
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

// Column sets for the panel's tables. All visible by default: the picker
// only changes what a user has hidden or moved, per storagePrefix. (The
// fork's session, client and cancel columns need its in-flight join, which
// this server has no data for; its "Other in flight" table goes with them.)
interface QueueColumn {
  id: string;
  label: string;
  defaultVisible: boolean;
  /** Right-align the column (numeric values). */
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

// The panel's table-cell styles, over the pool's palette (the .qp scope sets
// the variables the cells read).
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
  /* Need against the whole pool, with a tick where the gate's room ends. */
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

// One table's column drag-reorder: reorders the order live as the drag
// crosses other items, so the menu's order always matches what the table
// shows.
function useColumnDrag(columnOrder: string[], setColumnOrder: (order: string[]) => void) {
  const [dragId, setDragId] = useState<string | null>(null);

  // A hovered row only yields once the pointer passes its midpoint in the
  // direction of travel. Without that hysteresis the swap fires as soon as
  // the pointer touches the neighbour and the items oscillate.
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

interface Props {
  snapshot: QueueSnapshot | null;
  storagePrefix: string;
}

/**
 * The request queue for one model: the KV pool (who holds it, and what the
 * gate sees as room), the running batch and the waiting line with the
 * reason each request waits. Ages tick every animation frame between the
 * once-a-second snapshots.
 */
export function QueuePanel({ snapshot, storagePrefix }: Props) {
  const reducedMotion = usePrefersReducedMotion();

  // One picker for the whole panel: one section per table. The prefix is
  // fixed for the panel's life, so capturing it here is intentional.
  const runningCols = useColumns(`${storagePrefix}-queue-running`, RUNNING_COLS);
  const waitingCols = useColumns(`${storagePrefix}-queue-waiting`, WAITING_COLS);
  const runningDrag = useColumnDrag(runningCols.columnOrder, runningCols.setColumnOrder);
  const waitingDrag = useColumnDrag(waitingCols.columnOrder, waitingCols.setColumnOrder);

  const [open, setOpen] = usePersistent<boolean>(`${storagePrefix}-queue-open`, true);

  // Ages and hold times tick between the once-a-second snapshots. rAF, not a
  // coarse interval: the displayed age must move every frame or the interval's
  // quantum reads as stutter, and rAF pauses in a hidden tab for free.
  const [nowMs, setNowMs] = useState(() => performance.now());
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setNowMs(performance.now());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // A row's engine age only increases, but a snapshot re-baseline can land
  // behind where the row's tick has already counted (its stamp lags the
  // browser's event processing by a variable delay), which reads as the
  // timer running backwards. The ratchet holds each row at its highest shown
  // value. Keys: model#id for a scheduler row's age, "h:" for its hold time.
  const ages = useMemo(() => new AgeRatchet(), []);
  useEffect(() => {
    const keys: string[] = [];
    if (snapshot) {
      for (const r of snapshot.requests) {
        const k = requestKey(snapshot.model, r);
        keys.push(k, `h:${k}`);
      }
    }
    ages.prune(keys);
  }, [snapshot, ages]);

  // Four slots: rad batches at most four sequences (--max-num-seqs 4).
  const assigner = useMemo(() => new SlotAssigner(4), []);

  const running = useMemo(() => (snapshot ? runningRequests(snapshot) : []), [snapshot]);
  const waiting = useMemo(() => (snapshot ? waitingRequests(snapshot) : []), [snapshot]);

  const slots = useMemo(
    () =>
      snapshot
        ? assigner.assign(running.map((r) => requestKey(snapshot.model, r)))
        : new Map<string, number>(),
    [snapshot, assigner, running],
  );

  if (!snapshot) {
    return <div className="text-muted-foreground text-sm">No queue data</div>;
  }

  // Non-null from here on. Closures (the cell renderers, the row maps)
  // capture this const rather than the parameter, so they keep the narrowed
  // type.
  const snap = snapshot;

  const l = kvLayout(snap);
  const policy = snap.queue;
  const dt = Math.max(0, (nowMs - (snap.client_received_at_ms ?? nowMs)) / 1000);

  const runningVisible = runningCols.columnOrder.filter(
    (id) => runningCols.columnVisibility[id] !== false,
  );
  const waitingVisible = waitingCols.columnOrder.filter(
    (id) => waitingCols.columnVisibility[id] !== false,
  );

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
              style={{ "--c": `var(--q-s${slotOf(r) + 1})` } as CSSProperties}
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
          // The gap is the uncomputed prompt, not output room: say which is which.
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

  return (
    <Card className="qp relative p-3">
      <style>{QUEUE_PANEL_CSS}</style>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pr-16 text-sm">
        <span className="text-muted-foreground text-xs uppercase tracking-wider">Request Queue</span>
        <span>
          <span className="font-semibold tabular-nums">{running.length}</span> running
        </span>
        <span>
          <span className="font-semibold tabular-nums">{waiting.length}</span> waiting
        </span>
      </div>
      <div className="absolute right-2 top-2 flex items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger
            className="text-muted-foreground hover:bg-muted inline-flex size-6 items-center justify-center rounded-full"
            title="Select queue columns"
          >
            <Columns3 className="size-4" />
          </DropdownMenuTrigger>
          {/* 50vh, not 60vh: with every column visible the list is ~540px tall,
              which doesn't fit either above or below the header trigger on a
              normal viewport -- floating-ui then keeps re-fitting and the menu
              flickers between positions. 50vh leaves the menu a stable fit. */}
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
        <section
          className="mt-3 border-t pt-3 first-of-type:border-t-0 first-of-type:pt-0"
          aria-label={`Queue for ${snap.model}`}
        >
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
            <span className="text-sm font-medium">{snap.model}</span>
            <span className="tabular-nums">
              KV <span className="font-semibold">{formatTokens(snap.kv_tokens_used)}</span> /{" "}
              {formatTokens(snap.kv_tokens_total)}
              <span className="text-muted-foreground">
                ({pct(snap.kv_tokens_used, snap.kv_tokens_total).toFixed(0)}% held,{" "}
                {formatTokens(l.cache)} of it cache)
              </span>
            </span>
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
                {policy.kv_reserve > 0 ? (
                  `reserve ${formatTokens(policy.kv_reserve)} · backfill ${
                    (policy.backfill_ms / 1000).toFixed(0)
                  }s`
                ) : (
                  "KV-fit gate off"
                )}
              </span>
            )}
          </div>

          <KvPoolBar snapshot={snap} slots={slots} />

          {/* Running batch */}
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
                        <TableCell key={colId} className={TD_CLASS}>
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

          {/* Waiting line, in service order */}
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
                            className={cn(TD_CLASS, colId === "why" && "whitespace-normal")}
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
      ) : null}
    </Card>
  );
}

// The fork animated its picker items, not the tables' rows; here the rows
// slide to their new place when the order changes. FLIP: a row keeps its DOM
// node across reorders (stable key), so the top measured in the last
// useLayoutEffect is its "first" position and the new offsetTop its "last";
// the inverse translate is applied, then transitioned to 0 over 200 ms.
// offsetTop ignores the in-flight transform, so the measurement every frame
// (the panel re-renders on the rAF clock) is always the settled position.
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
    // A slide still in flight settles first; the new one starts from the
    // row's current layout position.
    if (animating.current) {
      el.style.transform = "";
      el.style.transition = "";
      animating.current = false;
    }
    el.style.transition = "none";
    el.style.transform = `translateY(${prev - top}px)`;
    void el.offsetHeight; // commit the start position before the transition
    el.style.transition = "transform 200ms ease";
    el.style.transform = "translateY(0)";
    animating.current = true;
  });

  return <TableRow ref={ref}>{children}</TableRow>;
}
