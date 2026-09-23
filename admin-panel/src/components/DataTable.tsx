// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface Column<T> {
  key: string;
  label: string;
  render?: (item: T) => React.ReactNode;
}

interface DataTableProps<T> {
  data: T[];
  columns: Column<T>[];
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  isLoading?: boolean;
}

/**
 * The row key, from whichever id the entity actually carries.
 *
 * The constraint was `T extends { _id: string }`, which forced every entity to
 * declare `_id` whether the server sent one or not — and the users repository
 * does not: it emits `userId`. So `User` declared an `_id` that was always
 * `undefined`, every row got `key={undefined}`, and React fell back to index
 * order. That was the least of it: the same wrong field was then used to
 * identify rows in URLs and in selection state.
 *
 * Orders and merchants DO send `_id` (their mappers alias it deliberately), so
 * every spelling is accepted and the first present one wins.
 *
 * ── The ORDER of those candidates is the whole thing ────────────────────────
 * `userId` used to be tried FIRST. That is right for the users table, where it
 * IS the row's identity — and wrong for every row that merely REFERENCES a
 * user. A wallet-ledger row does: one player owns many movements, so the whole
 * Transactions page rendered with one key repeated down the table, and React
 * warned "Encountered two children with the same key".
 *
 * That is not cosmetic. Duplicate keys let React reuse the wrong row across an
 * update, so a re-sort or a page change can leave a row showing one movement's
 * amount beside another's reason — on the screen an operator reconciles money
 * from. §23's lesson, one level down: the id a row carries is not automatically
 * the id it IS.
 *
 * So: the row's OWN identity first, and `userId` only as the fallback for rows
 * that have nothing else — which is exactly the users table.
 */
function rowKey(item: unknown, index: number): string {
  const r = item as Record<string, unknown>;
  const id = r?.txId ?? r?._id ?? r?.id ?? r?.orderId ?? r?.userId;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : `row-${index}`;
}

export function DataTable<T extends object>({
  data,
  columns,
  currentPage,
  totalPages,
  onPageChange,
  isLoading = false,
}: DataTableProps<T>) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-8 h-8 border-4 border-dark-600 border-t-gold-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="text-center py-12 text-gray-400">
        <p>No data available</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key}>{column.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((item, i) => (
              <tr key={rowKey(item, i)} className="hover:bg-hover transition-colors">
                {columns.map((column) => (
                  <td key={column.key}>
                    {column.render ? column.render(item) : (item as any)[column.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-400">
            Page {currentPage} of {totalPages}
          </p>
          <div className="flex items-center space-x-2">
            {/* Two icon-only buttons in the one table component every list
                screen uses, so a single pair of missing names was announced as
                "button, button" on /users, /merchants, /transactions,
                /cycle-history and /audit-logs alike. The page number is in the
                name because "previous page" alone does not say where you are
                going (§32 S24). */}
            <button
              onClick={() => onPageChange(currentPage - 1)}
              disabled={currentPage === 1}
              title={`Previous page (${currentPage - 1} of ${totalPages})`}
              aria-label={`Previous page (${currentPage - 1} of ${totalPages})`}
              className="btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={() => onPageChange(currentPage + 1)}
              disabled={currentPage === totalPages}
              title={`Next page (${currentPage + 1} of ${totalPages})`}
              aria-label={`Next page (${currentPage + 1} of ${totalPages})`}
              className="btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
