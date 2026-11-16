import {
  activeFilterCount,
  emptyActivityFilters,
  type ActivityFilters,
} from "@/lib/activity/activityFilters";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

const PAGE_SIZES = [10, 25, 50, 100, 250, 500];

interface FilterDrawerProps {
  filters: ActivityFilters;
  onFiltersChange: (filters: ActivityFilters) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  showRows?: boolean;
  pageSize?: number;
  onPageSizeChange?: (pageSize: number) => void;
}

/** The activity table's ID range filter, in a side drawer. */
export function FilterDrawer({
  filters,
  onFiltersChange,
  open,
  onOpenChange,
  showRows = false,
  pageSize = 25,
  onPageSizeChange,
}: FilterDrawerProps) {
  function update(patch: Partial<ActivityFilters>) {
    onFiltersChange({ ...filters, ...patch });
  }

  const canClear = activeFilterCount(filters) > 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Filters</SheetTitle>
        </SheetHeader>
        <div className="flex flex-wrap items-end gap-3 px-4 pb-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="filter-min-id" className="text-muted-foreground text-xs">
              ID from
            </label>
            <Input
              id="filter-min-id"
              type="number"
              min="1"
              step="1"
              placeholder="min"
              className="h-8 w-[6.5rem] text-xs"
              value={filters.minID}
              onChange={(e) => update({ minID: e.currentTarget.value })}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="filter-max-id" className="text-muted-foreground text-xs">
              ID to
            </label>
            <Input
              id="filter-max-id"
              type="number"
              min="1"
              step="1"
              placeholder="max"
              className="h-8 w-[6.5rem] text-xs"
              value={filters.maxID}
              onChange={(e) => update({ maxID: e.currentTarget.value })}
            />
          </div>

          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            disabled={!canClear}
            onClick={() => onFiltersChange(emptyActivityFilters())}
          >
            Clear filters
          </Button>

          {showRows && onPageSizeChange ? (
            // Rows is a view setting rather than a filter: it sits apart on the
            // right, is left alone by "Clear filters", and is not counted by the
            // header's active-filter badge.
            <div className="ml-auto flex flex-col gap-1">
              <span className="text-muted-foreground text-xs">Rows</span>
              <select
                aria-label="Rows per page"
                className="h-8 w-[5.5rem] rounded-lg border border-input bg-transparent px-2 text-xs"
                value={String(pageSize)}
                onChange={(e) => onPageSizeChange(Number(e.currentTarget.value))}
              >
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={String(size)}>
                    {size}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
