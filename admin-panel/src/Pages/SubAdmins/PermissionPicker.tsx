// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The whole list of what a sub-admin can be given, grouped by area, as the
 * SERVER describes it (`GET /api/admin/staff-permissions`). One component for
 * both Create and Edit, so the two cannot offer different lists.
 *
 * The labels, descriptions and the "moves money" marker are the server's words:
 * the panel keeps only the keys (`utils/permissions.ts`), so there is no second
 * copy of what a permission is called to drift from the one that is enforced.
 */
import React from 'react';
import type { StaffPermissionCatalog } from '../../utils/permissions';

interface Props {
  catalog: StaffPermissionCatalog | null;
  value: Record<string, boolean>;
  onChange: (next: Record<string, boolean>) => void;
  /** Distinguishes the two pickers' checkbox ids when both are mounted. */
  idPrefix: string;
}

export const PermissionPicker: React.FC<Props> = ({ catalog, value, onChange, idPrefix }) => {
  if (!catalog) return <p className="text-sm text-gray-500">Loading the permission list…</p>;

  const set = (keys: string[], on: boolean) => {
    const next = { ...value };
    for (const k of keys) next[k] = on;
    onChange(next);
  };
  const granted = catalog.permissions.filter((p) => value[p.key]).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm text-gray-400" role="status">
          {granted} of {catalog.permissions.length} areas granted
        </p>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary text-xs" onClick={() => set(catalog.permissions.map((p) => p.key), true)}>
            Grant all
          </button>
          <button type="button" className="btn-secondary text-xs" onClick={() => set(catalog.permissions.map((p) => p.key), false)}>
            Clear all
          </button>
        </div>
      </div>

      {catalog.groups.map((group) => {
        const items = catalog.permissions.filter((p) => p.group === group.key);
        if (!items.length) return null;
        const allOn = items.every((p) => value[p.key]);
        return (
          <fieldset key={group.key} className="border border-dark-600 rounded-lg p-3">
            <legend className="px-1 text-sm font-semibold text-gray-300 flex items-center gap-3">
              {group.label}
              <button
                type="button"
                className="text-xs text-purple-400 hover:underline"
                onClick={() => set(items.map((p) => p.key), !allOn)}
                aria-label={`${allOn ? 'Clear' : 'Grant'} every permission in ${group.label}`}
              >
                {allOn ? 'Clear group' : 'Grant group'}
              </button>
            </legend>
            <div className="space-y-1">
              {items.map((perm) => {
                const id = `${idPrefix}-${perm.key}`;
                return (
                  <div key={perm.key} className="flex items-start gap-3 p-2 hover:bg-dark-700 rounded-lg">
                    <input
                      id={id}
                      type="checkbox"
                      checked={value[perm.key] === true}
                      onChange={(e) => onChange({ ...value, [perm.key]: e.target.checked })}
                      className="w-4 h-4 mt-0.5 shrink-0 accent-purple-500"
                    />
                    <label htmlFor={id} className="cursor-pointer">
                      <span className="text-sm font-medium">{perm.label}</span>
                      {perm.money && (
                        <span className="ml-2 px-1.5 py-0.5 rounded-sm text-[10px] uppercase tracking-wide bg-amber-500/20 text-amber-300">
                          moves money
                        </span>
                      )}
                      <span className="block text-xs text-gray-500">{perm.description}</span>
                    </label>
                  </div>
                );
              })}
            </div>
          </fieldset>
        );
      })}

      {catalog.adminOnly.length > 0 && (
        <div className="text-xs text-gray-500 border-t border-dark-600 pt-3">
          <p className="font-semibold text-gray-400 mb-1">Only a full admin can do these — they cannot be granted:</p>
          <ul className="list-disc pl-4 space-y-0.5">
            {catalog.adminOnly.map((a) => <li key={a.area}><strong>{a.area}</strong>: {a.why}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
};
