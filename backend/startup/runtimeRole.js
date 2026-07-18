// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)

const VALID_ROLES = new Set(['all', 'api', 'realtime', 'worker', 'scheduler']);

export function runtimeRole(env = process.env) {
  const raw = env.BB_RUNTIME_ROLE;
  if (raw == null || String(raw).trim() === '') return 'all';
  const role = String(raw).trim().toLowerCase();
  if (VALID_ROLES.has(role)) return role;
  throw new Error(`Invalid BB_RUNTIME_ROLE '${raw}'. Expected one of: ${[...VALID_ROLES].join(', ')}`);
}

export function runtimeProfile(env = process.env) {
  const role = runtimeRole(env);
  return {
    role,
    acceptsHttpApi: role === 'all' || role === 'api' || role === 'realtime',
    acceptsRealtime: role === 'all' || role === 'realtime',
    runsSchedulers: role === 'all' || role === 'scheduler',
    runsWorkers: role === 'all' || role === 'worker' || role === 'scheduler',
  };
}
