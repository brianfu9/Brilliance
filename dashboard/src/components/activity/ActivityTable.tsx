import { useEffect, useMemo, useState, type DragEvent } from "react";
import type { ColumnDef, PaginationState, SortingState } from "@tanstack/react-table";
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import type { ActivityLogEntry } from "@/lib/activity/types";
import {
  formatDuration,
  formatOptionalDuration,
  formatRelativeTime,
  formatSpeed,
} from "@/lib/activity/format";
import { buildActivityMarkdown, formatDrafted } from "@/lib/activity/activityExport";
import {
  activeFilterCount,
  emptyActivityFilters,
  type ActivityFilters,
} from "@/lib/activity/activityFilters";
import { useColumns, type ColumnMeta } from "@/lib/activity/columns";
import { usePersistent } from "@/lib/activity/persist";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Columns3,
  Download,
  GripVertical,
  ListFilter,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
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
import { ExportDialog } from "./ExportDialog";
import { FilterDrawer } from "./FilterDrawer";
import { CaptureCell, HeaderLabel, MetaCell, SourceCell } from "./table-cells";

interface Props {
  metrics: ActivityLogEntry[];
  storagePrefix: string;
  title?: string;
  emptyMessage?: string;
  hueOf?: Map<string, string>;
}

/**
 * The finished-requests table: sorting, the ID range filter and pagination
 * all run client-side over `metrics`, and the column order and visibility are
 * persisted per browser under `storagePrefix` (the column picker allows both
 * hiding columns and dragging them into a new order).
 */
export function ActivityTable({
  metrics,
  storagePrefix,
  title,
  emptyMessage = "No activity recorded",
  hueOf,
}: Props) {
  const columnMeta = useMemo<ColumnMeta[]>(
    () => [
      { id: "id", label: "ID", defaultVisible: true },
      { id: "time", label: "Time", defaultVisible: true },
      { id: "src", label: "Source/Caller", defaultVisible: true },
      { id: "model", label: "Model", defaultVisible: true },
      { id: "req_path", label: "Path", defaultVisible: false },
      { id: "resp_status_code", label: "Status", defaultVisible: true },
      { id: "resp_content_type", label: "Content-Type", defaultVisible: false },
      { id: "cached", label: "Cached", defaultVisible: true },
      { id: "prompt", label: "Prompt", defaultVisible: true },
      { id: "generated", label: "Generated", defaultVisible: true },
      { id: "drafted", label: "Drafted", defaultVisible: false },
      { id: "prompt_speed", label: "Prefill", defaultVisible: true },
      { id: "gen_speed", label: "Decode", defaultVisible: true },
      { id: "prompt_duration", label: "Prefill Time", defaultVisible: true },
      { id: "gen_duration", label: "Decode Time", defaultVisible: true },
      { id: "duration", label: "Duration", defaultVisible: true },
      { id: "capture", label: "Capture", defaultVisible: true },
      { id: "meta", label: "Meta", defaultVisible: false },
    ],
    [],
  );

  const columnLabelMap = useMemo(
    () => Object.fromEntries(columnMeta.map((column) => [column.id, column.label])) as Record<string, string>,
    [columnMeta],
  );

  const {
    columnVisibility,
    setColumnVisibility,
    columnOrder,
    setColumnOrder,
  } = useColumns(storagePrefix, columnMeta);

  const [filterOpen, setFilterOpen] = usePersistent<boolean>(`${storagePrefix}-filter-open`, false);
  const [filters, setFilters] = useState<ActivityFilters>(emptyActivityFilters);
  const filterCount = activeFilterCount(filters);

  const [sorting, setSorting] = useState<SortingState>([]);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });

  const [exportOpen, setExportOpen] = useState(false);
  const [exportMarkdown, setExportMarkdown] = useState("");

  const [dragColId, setDragColId] = useState<string | null>(null);

  // Newest first by default: the table's sort state starts empty, so this
  // base order is what shows until a header is clicked to sort. The ID range
  // filter is applied client-side before the table sees the rows.
  const rows = useMemo(() => {
    const sorted = [...metrics].sort(
      (a, b) => (Date.parse(b.timestamp) - Date.parse(a.timestamp)) || (b.id - a.id),
    );
    const minID = parseIDFilter(filters.minID);
    const maxID = parseIDFilter(filters.maxID);
    if (minID === null && maxID === null) return sorted;
    return sorted.filter(
      (row) =>
        (minID === null || row.id >= minID) && (maxID === null || row.id <= maxID),
    );
  }, [metrics, filters]);

  const columns = useMemo<ColumnDef<ActivityLogEntry>[]>(
    () => [
      {
        id: "id",
        accessorKey: "id",
        header: "ID",
        cell: ({ row }) => String(row.original.id),
      },
      {
        id: "time",
        accessorKey: "timestamp",
        header: "Time",
        cell: ({ row }) => formatRelativeTime(row.original.timestamp),
      },
      {
        id: "src",
        accessorKey: "src",
        header: "Source/Caller",
        cell: ({ row }) => <SourceCell source={row.original.src} />,
      },
      {
        id: "model",
        accessorKey: "model",
        header: "Model",
        cell: ({ row }) => {
          const requested = row.original.model;
          const canonical = row.original.fleetModel ?? requested;
          if (!requested) return <span className="text-muted-foreground">-</span>;
          const aliased = Boolean(canonical && canonical !== requested);
          const dotColor = hueOf ? (hueOf.get(canonical) ?? "var(--muted-foreground)") : undefined;
          return (
            <span
              className="inline-flex items-center gap-1.5"
              title={aliased ? `canonical: ${canonical}` : undefined}
            >
              {dotColor && (
                <i className="size-2 shrink-0 rounded-full" style={{ background: dotColor }} />
              )}
              <span>{requested}</span>
            </span>
          );
        },
      },
      {
        id: "req_path",
        accessorKey: "req_path",
        header: "Path",
        cell: ({ row }) => row.original.req_path || "-",
      },
      {
        id: "resp_status_code",
        accessorKey: "resp_status_code",
        header: "Status",
        cell: ({ row }) =>
          isAborted(row.original)
            ? `${row.original.resp_status_code} aborted`
            : String(row.original.resp_status_code || "-"),
      },
      {
        id: "resp_content_type",
        accessorKey: "resp_content_type",
        header: "Content-Type",
        cell: ({ row }) => row.original.resp_content_type || "-",
      },
      {
        id: "cached",
        accessorFn: (row) => row.tokens.cache_tokens,
        header: () => <HeaderLabel label="Cached" tooltip="prompt tokens from cache" />,
        cell: ({ row }) =>
          isNonToken(row.original)
            ? "-"
            : row.original.tokens.cache_tokens > 0
              ? row.original.tokens.cache_tokens.toLocaleString()
              : "-",
      },
      {
        id: "prompt",
        accessorFn: (row) => row.tokens.input_tokens,
        header: () => <HeaderLabel label="Prompt" tooltip="new prompt tokens processed" />,
        cell: ({ row }) =>
          isNonToken(row.original) ? "-" : row.original.tokens.input_tokens.toLocaleString(),
      },
      {
        id: "generated",
        accessorFn: (row) => row.tokens.output_tokens,
        header: "Generated",
        cell: ({ row }) =>
          isNonToken(row.original) ? "-" : row.original.tokens.output_tokens.toLocaleString(),
      },
      {
        id: "drafted",
        accessorFn: (row) => row.tokens.draft_tokens,
        header: () => <HeaderLabel label="Drafted" tooltip="acceptance rate (accepted/drafted)" />,
        cell: ({ row }) =>
          isNonToken(row.original)
            ? "-"
            : formatDrafted(row.original.tokens.draft_tokens, row.original.tokens.draft_acc_tokens),
      },
      {
        id: "prompt_speed",
        accessorFn: (row) => row.tokens.prompt_per_second,
        header: "Prefill",
        cell: ({ row }) =>
          isNonToken(row.original) || isAborted(row.original)
            ? "-"
            : formatSpeed(row.original.tokens.prompt_per_second),
      },
      {
        id: "gen_speed",
        accessorFn: (row) => row.tokens.tokens_per_second,
        header: "Decode",
        cell: ({ row }) =>
          isNonToken(row.original) || isAborted(row.original)
            ? "-"
            : formatSpeed(row.original.tokens.tokens_per_second),
      },
      {
        id: "prompt_duration",
        accessorFn: (row) => row.tokens.prompt_ms,
        header: "Prefill Time",
        cell: ({ row }) =>
          isNonToken(row.original) ? "-" : formatOptionalDuration(row.original.tokens.prompt_ms),
      },
      {
        id: "gen_duration",
        accessorFn: (row) => row.tokens.predicted_ms,
        header: "Decode Time",
        cell: ({ row }) =>
          isNonToken(row.original) ? "-" : formatOptionalDuration(row.original.tokens.predicted_ms),
      },
      {
        id: "duration",
        accessorKey: "duration_ms",
        header: "Duration",
        cell: ({ row }) => formatDuration(row.original.duration_ms),
      },
      {
        id: "capture",
        header: "Capture",
        enableSorting: false,
        cell: () => <CaptureCell />,
      },
      {
        id: "meta",
        header: "Meta",
        enableSorting: false,
        cell: ({ row }) => <MetaCell metadata={row.original.metadata} />,
      },
    ],
    [hueOf],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: {
      sorting,
      columnVisibility,
      columnOrder,
      pagination,
    },
    onSortingChange: (updater) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      setSorting(next);
    },
    onColumnVisibilityChange: (updater) => {
      const next = typeof updater === "function" ? updater(columnVisibility) : updater;
      setColumnVisibility(next);
    },
    onColumnOrderChange: (updater) => {
      const next = typeof updater === "function" ? updater(columnOrder) : updater;
      setColumnOrder(next);
    },
    onPaginationChange: (updater) => {
      const next = typeof updater === "function" ? updater(pagination) : updater;
      setPagination(next);
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  const pageCount = table.getPageCount();

  // The ID filter can shrink the rows below the current page; keep the page
  // index in range so an out-of-range page does not read as empty.
  useEffect(() => {
    if (pageCount > 0 && pagination.pageIndex > pageCount - 1) {
      setPagination((current) => ({ ...current, pageIndex: pageCount - 1 }));
    }
  }, [pageCount, pagination.pageIndex]);

  // Built on demand rather than in a useMemo: the export only matters while
  // the dialog is open, and activity refreshes land every second.
  function openExport() {
    setExportMarkdown(
      buildActivityMarkdown(
        table.getRowModel().rows.map((row) => row.original),
        table
          .getVisibleLeafColumns()
          .filter((column) => column.id !== "capture")
          .map((column) => ({ id: column.id, label: columnLabelMap[column.id] ?? column.id })),
      ),
    );
    setExportOpen(true);
  }

  function closeExport() {
    setExportOpen(false);
    setExportMarkdown("");
  }

  const page = pagination.pageIndex + 1;
  const total = rows.length;

  const visiblePages = (() => {
    const maxButtons = 7;
    const count = pageCount;
    const current = Math.min(Math.max(page, 1), count);
    const half = Math.floor(maxButtons / 2);
    let start = Math.max(1, current - half);
    let end = Math.min(count, start + maxButtons - 1);
    start = Math.max(1, end - maxButtons + 1);
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  })();

  function setPage(nextPage: number) {
    const clamped = Math.min(Math.max(nextPage, 1), pageCount);
    setPagination((current) => ({ ...current, pageIndex: clamped - 1 }));
  }

  function sortIcon(state: false | "asc" | "desc"): LucideIcon {
    if (state === "asc") return ArrowUp;
    if (state === "desc") return ArrowDown;
    return ArrowUpDown;
  }

  // A hovered row only yields once the pointer passes its midpoint in the
  // direction of travel. Without that hysteresis the swap fires as soon as
  // the pointer touches the neighbour and the rows oscillate.
  function crossedMidpoint(e: DragEvent<HTMLElement>, movingDown: boolean): boolean {
    const el = e.currentTarget;
    const parent = el.offsetParent as HTMLElement | null;
    if (!parent) return true;
    const top = parent.getBoundingClientRect().top - parent.scrollTop + el.offsetTop;
    const midpoint = top + el.offsetHeight / 2;
    return movingDown ? e.clientY > midpoint : e.clientY < midpoint;
  }

  function handleColDragStart(e: DragEvent<HTMLDivElement>, colId: string) {
    setDragColId(colId);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", colId);
    }
  }

  // Reorders columnOrder live as the drag crosses other rows, so the menu's
  // order always matches what the table shows.
  function handleColDragOver(e: DragEvent<HTMLDivElement>, colId: string) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (!dragColId || dragColId === colId) return;
    const order = [...columnOrder];
    const fromIndex = order.indexOf(dragColId);
    const toIndex = order.indexOf(colId);
    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return;
    if (!crossedMidpoint(e, toIndex > fromIndex)) return;
    order.splice(fromIndex, 1);
    order.splice(toIndex, 0, dragColId);
    setColumnOrder(order);
  }

  function handleColDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragColId(null);
    setColumnOrder(columnOrder);
  }

  function handleColDragEnd() {
    setDragColId(null);
    setColumnOrder(columnOrder);
  }

  return (
    <>
      <Card className="shrink-0 gap-0 overflow-hidden py-0">
        <CardHeader className="flex items-center justify-between border-b px-4 py-2">
          <div className="flex items-center gap-2">
            {title && (
              <CardTitle className="text-sm font-semibold">
                {title}{" "}
                <span className="text-muted-foreground text-xs font-normal">({total})</span>
              </CardTitle>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="hover:bg-muted inline-flex size-7 items-center justify-center rounded-[min(var(--radius-md),12px)]"
              title="Export as markdown"
              onClick={openExport}
            >
              <Download className="size-4" />
            </button>
            <button
              type="button"
              className={`hover:bg-muted relative inline-flex size-7 items-center justify-center rounded-[min(var(--radius-md),12px)] ${
                filterOpen ? "bg-muted" : ""
              }`}
              title={filterOpen ? "Hide filters" : "Show filters"}
              aria-expanded={filterOpen}
              onClick={() => setFilterOpen(!filterOpen)}
            >
              <ListFilter className="size-4" />
              {filterCount > 0 && (
                <span
                  className="bg-primary absolute -right-0.5 -top-0.5 size-2 rounded-full"
                  aria-hidden="true"
                />
              )}
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger
                className="hover:bg-muted inline-flex size-7 items-center justify-center rounded-[min(var(--radius-md),12px)]"
                title="Select columns"
              >
                <Columns3 className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="min-w-[18rem] max-h-[50vh] overflow-y-auto p-0"
              >
                <DropdownMenuLabel className="text-muted-foreground border-b px-3 py-2 text-xs font-medium uppercase tracking-wider">
                  Columns{" "}
                  <span className="text-[10px] normal-case tracking-normal">
                    (drag to reorder)
                  </span>
                </DropdownMenuLabel>
                {columnOrder
                  .filter((id) => table.getColumn(id)?.getCanHide() ?? false)
                  .map((columnId) => {
                    const column = table.getColumn(columnId);
                    return (
                      <div
                        key={columnId}
                        draggable="true"
                        role="button"
                        tabIndex={-1}
                        aria-label={`Drag to reorder ${columnLabelMap[columnId] ?? columnId}`}
                        onDragStart={(e) => handleColDragStart(e, columnId)}
                        onDragOver={(e) => handleColDragOver(e, columnId)}
                        onDrop={handleColDrop}
                        onDragEnd={handleColDragEnd}
                        className={dragColId === columnId ? "opacity-40" : ""}
                      >
                        <DropdownMenuCheckboxItem
                          checked={column?.getIsVisible() ?? false}
                          onCheckedChange={(v) => column?.toggleVisibility(!!v)}
                        >
                          <GripVertical className="text-muted-foreground/50 size-4 cursor-grab active:cursor-grabbing" />
                          <span className="flex-1">{columnLabelMap[columnId] ?? columnId}</span>
                        </DropdownMenuCheckboxItem>
                      </div>
                    );
                  })}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </CardHeader>

        <FilterDrawer
          filters={filters}
          onFiltersChange={setFilters}
          open={filterOpen}
          onOpenChange={setFilterOpen}
          showRows
          pageSize={pagination.pageSize}
          onPageSizeChange={(pageSize) =>
            setPagination((current) => ({ ...current, pageSize }))
          }
        />

        {/*
          Table.Root always wraps the table in an overflow-x-auto div, and CSS
          promotes that box's overflow-y to auto as well, making it the sticky
          header's scrollport. Bounding its height here is what turns it into a
          real scrolling box so `sticky top-0` on the header has something to
          stick to. Horizontal scrolling stays on that same wrapper, so
          CardContent does not need its own overflow.
        */}
        <CardContent className="p-0 [&>[data-slot=table-container]]:max-h-[var(--activity-table-max-h,60vh)] [&>[data-slot=table-container]]:overflow-y-auto">
          <Table className="min-w-full">
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => {
                    const sorted = header.column.getIsSorted();
                    const SortIcon = header.column.getCanSort() ? sortIcon(sorted) : null;
                    return (
                      <TableHead key={header.id} className={TH_CLASS} colSpan={header.colSpan}>
                        {!header.isPlaceholder &&
                          (SortIcon ? (
                            <button
                              type="button"
                              className="text-muted-foreground hover:text-foreground -mx-1 inline-flex items-center gap-1 text-left"
                              onClick={() => header.column.toggleSorting(sorted === "asc")}
                            >
                              {flexRender(header.column.columnDef.header, header.getContext())}
                              <SortIcon
                                className={`size-3 ${sorted ? "text-foreground" : "opacity-50"}`}
                              />
                            </button>
                          ) : (
                            flexRender(header.column.columnDef.header, header.getContext())
                          ))}
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className={TD_CLASS}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              {table.getRowModel().rows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={table.getVisibleLeafColumns().length}
                    className="text-muted-foreground py-6 text-center text-sm"
                  >
                    {emptyMessage}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

          {total > 0 && (
            <div className="flex items-center justify-between gap-2 border-t px-4 py-2 text-sm">
              <span className="text-muted-foreground text-xs">
                Page {page} of {pageCount} · {total} total
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setPage(1)}
                  disabled={page <= 1}
                  title="First page"
                >
                  <ChevronsLeft />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setPage(page - 1)}
                  disabled={page <= 1}
                  title="Previous page"
                >
                  <ChevronLeft />
                </Button>
                {visiblePages.map((pageNumber) => (
                  <Button
                    key={pageNumber}
                    variant={pageNumber === page ? "secondary" : "ghost"}
                    size="sm"
                    className="h-7 min-w-7 px-2 text-xs"
                    onClick={() => setPage(pageNumber)}
                    disabled={pageNumber === page}
                  >
                    {pageNumber}
                  </Button>
                ))}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setPage(page + 1)}
                  disabled={page >= pageCount}
                  title="Next page"
                >
                  <ChevronRight />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setPage(pageCount)}
                  disabled={page >= pageCount}
                  title="Last page"
                >
                  <ChevronsRight />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <ExportDialog markdown={exportMarkdown} open={exportOpen} onClose={closeExport} />
    </>
  );
}

// The header sticks to the top of the scrolling table container. It needs an
// opaque background so rows pass underneath, and the bottom rule is drawn as
// an inset shadow because a collapsed table border does not paint reliably on
// a sticky cell.
const TH_CLASS =
  "px-3 py-3 h-12 bg-card sticky top-0 z-10 shadow-[inset_0_-1px_0_var(--border)]";
const TD_CLASS = "px-3 py-4";

/**
 * The client hung up before the usage chunk: no token counts, so no speed
 * either.
 */
function isAborted(row: ActivityLogEntry): boolean {
  return row.error_msg?.startsWith("client disconnected") ?? false;
}

function isNonToken(row: ActivityLogEntry): boolean {
  return !!row.kind && row.kind !== "chat" && row.kind !== "asr";
}

// Mirrors toPositiveInt in activityFilters.ts: keeps out blank, non-numeric
// and out-of-range ids so the client-side filter can never misbehave.
function parseIDFilter(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}
