// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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
 * both spellings are accepted and the first present one wins.
 */
function rowKey(item: unknown, index: number): string {
  const r = item as Record<string, unknown>;
  const id = r?.userId ?? r?._id ?? r?.id;
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
            <button
              onClick={() => onPageChange(currentPage - 1)}
              disabled={currentPage === 1}
              className="btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={() => onPageChange(currentPage + 1)}
              disabled={currentPage === totalPages}
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
