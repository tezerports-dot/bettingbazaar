// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * What a system setting means, and an example, under its field.
 *
 * The words are the server's: `GET /api/admin/system/config` serves `help`,
 * one entry per declared setting keyed by its dotted path
 * (`database/spec/configHelp.js`). A Settings screen puts the map in
 * `SettingHelpProvider` and names the path; it keeps no text of its own (§5).
 */
import React, { createContext, useContext } from 'react';

export interface SettingHelpEntry { what: string; example: string }
export type SettingHelpMap = Record<string, SettingHelpEntry>;

const HelpContext = createContext<SettingHelpMap>({});

export const SettingHelpProvider: React.FC<{ help: SettingHelpMap; children: React.ReactNode }> = ({ help, children }) => (
  <HelpContext.Provider value={help}>{children}</HelpContext.Provider>
);

/** The explanation and example for `path`; nothing until the config has loaded. */
export const SettingHelp: React.FC<{ path: string; className?: string }> = ({ path, className }) => {
  const entry = useContext(HelpContext)[path];
  if (!entry) return null;
  return (
    <div className={`text-xs mt-1 space-y-0.5 ${className ?? ''}`} data-setting-help={path}>
      <p className="text-gray-400">{entry.what}</p>
      <p className="text-gray-500"><span className="font-semibold text-gray-400">Example:</span> {entry.example}</p>
    </div>
  );
};
