import { useEffect, useMemo } from "react";
import type { VisibilityState } from "@tanstack/react-table";
import { usePersistent } from "./persist";

export interface ColumnMeta {
  id: string;
  label: string;
  defaultVisible: boolean;
}

/**
 * React port of the Svelte table's column state: the column order and
 * visibility are persisted per browser (via usePersistent), fall back to the
 * column set's defaults when nothing is stored, and the order is reconciled
 * against the current column set — stale ids dropped, new ids appended — so
 * every column is always represented.
 */
export function useColumns(storagePrefix: string, columnMeta: ColumnMeta[]) {
  const defaultVisibility = useMemo<VisibilityState>(() => {
    const visibility: VisibilityState = {};
    for (const column of columnMeta) visibility[column.id] = column.defaultVisible;
    return visibility;
  }, [columnMeta]);

  const defaultColumnOrder = useMemo(() => columnMeta.map((column) => column.id), [columnMeta]);

  const [storedVisibility, setStoredVisibility] = usePersistent<VisibilityState>(
    `${storagePrefix}-columns`,
    {},
  );
  const columnVisibility: VisibilityState =
    Object.keys(storedVisibility).length > 0 ? storedVisibility : defaultVisibility;

  const [storedColumnOrder, setStoredColumnOrder] = usePersistent<string[]>(
    `${storagePrefix}-column-order`,
    [],
  );
  const columnOrder = useMemo(
    () => (storedColumnOrder.length > 0 ? storedColumnOrder : defaultColumnOrder),
    [storedColumnOrder, defaultColumnOrder],
  );

  // Reconcile stored order against the current column set: drop stale ids
  // and append any new ones so all columns are always represented.
  useEffect(() => {
    const known = new Set(columnMeta.map((column) => column.id));
    const hasStale = columnOrder.some((id) => !known.has(id));
    const missing = columnMeta
      .filter((column) => !columnOrder.includes(column.id))
      .map((column) => column.id);
    if (hasStale || missing.length > 0) {
      setStoredColumnOrder([...columnOrder.filter((id) => known.has(id)), ...missing]);
    }
  }, [columnMeta, columnOrder, setStoredColumnOrder]);

  return {
    columnVisibility,
    setColumnVisibility: setStoredVisibility,
    columnOrder,
    setColumnOrder: setStoredColumnOrder,
  };
}
