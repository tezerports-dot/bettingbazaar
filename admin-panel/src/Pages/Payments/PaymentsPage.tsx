// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Payments: every pool and every pool request in one place, with a switch
 * between agents' teams and merchants (owner, 2026-10-14).
 *
 *   Agents     the pool requests of supervisors' teams (`canFundMerchants`),
 *              and each team's pool, held tokens and commission
 *              (`GET /api/admin/teams`, `canManageTeams`).
 *   Merchants  the pool requests of merchant accounts (`canFundMerchants`),
 *              and the merchants with their pools, payment accounts,
 *              sub-members and flags (`MerchantAccountsPanel`,
 *              `canManageMerchants`).
 *
 * Each part asks its own area, the same key its route asks on the server, so a
 * sub-admin sees the parts they may work and nothing that would refuse them.
 * The side is kept in the address (`?side=merchants`), so a link opens it.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import toast from 'react-hot-toast';
import api from '../../services/api';
import { DataTable, type Column } from '../../components/DataTable';
import { Money, Toolbar } from '../../components/design';
import { usePermissions } from '../../hooks/usePermission';
import { MerchantAccountsPanel } from '../Merchants/MerchantAccountsPanel';
import { PoolRequests } from './PoolRequests';
import { poolExposureLine, type TeamView } from '../../types';

const tokens = (paise: number) => ((Number(paise) || 0) / 100).toLocaleString('en-IN');

type Side = 'agents' | 'merchants';

/** Each agents' team's pool, one row per team; a row opens its supervisor. */
const TeamPools: React.FC<{ reloadKey: number }> = ({ reloadKey }) => {
  const navigate = useNavigate();
  const [teams, setTeams] = useState<TeamView[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.teams.list()
      .then((res: { teams?: TeamView[] }) => { if (alive) setTeams(res.teams || []); })
      .catch((err: any) => toast.error(err?.response?.data?.message || 'Could not load the team pools'))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [reloadKey]);

  const columns: Column<TeamView>[] = [
    {
      key: 'team', label: 'Team',
      render: (t) => (
        <div>
          <p className="font-medium">{t.name}</p>
          <p className="text-xs text-gray-400">{t.supervisorName} · {t.rail.replace('_', ' / ')}</p>
        </div>
      ),
    },
    { key: 'available', label: 'Pool', numeric: true, render: (t) => <Money value={`${tokens(t.poolAvailablePaise)} tokens`} /> },
    {
      key: 'held', label: 'Held', numeric: true,
      render: (t) => (
        <div>
          <Money value={tokens(t.poolHeldPaise)} tone={t.poolHeldPaise > 0 ? 'warning' : 'muted'} />
          {t.poolExposure && t.poolHeldPaise > 0 && (
            <p className="text-xs text-gray-400">{poolExposureLine(t.poolExposure, tokens)}</p>
          )}
        </div>
      ),
    },
    {
      key: 'commission', label: 'Commission paid', numeric: true,
      render: (t) => (
        <div>
          <Money value={tokens(t.commission.paidPaise)} />
          {t.commission.owedPaise > 0 && (
            <p className="text-xs text-yellow-400">{tokens(t.commission.owedPaise)} waiting for the commission pool</p>
          )}
        </div>
      ),
    },
    { key: 'members', label: 'Agents', numeric: true, render: (t) => <span>{t.approvedCount} / {t.size}</span> },
  ];

  return (
    <section aria-labelledby="team-pools" className="card">
      <h2 id="team-pools" className="text-base font-semibold mb-3">Team pools</h2>
      <DataTable data={teams} columns={columns} currentPage={1} totalPages={1} onPageChange={() => {}}
        isLoading={loading} onRowClick={(t) => navigate(`/merchants/${encodeURIComponent(t.supervisorId)}`)} />
    </section>
  );
};

export const PaymentsPage: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const side: Side = params.get('side') === 'merchants' ? 'merchants' : 'agents';
  const { can } = usePermissions();
  const canFund = can('canFundMerchants');
  const canTeams = can('canManageTeams');
  const canMerchants = can('canManageMerchants');
  // A fulfilled request moves a pool: the pools below re-read after it.
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((n) => n + 1), []);

  const pick = (next: Side) => setParams(next === 'agents' ? {} : { side: next }, { replace: true });

  return (
    <div className="om-fade space-y-5">
      <Toolbar tabs={[
        { label: 'Agents\' teams', active: side === 'agents', onClick: () => pick('agents') },
        { label: 'Merchants', active: side === 'merchants', onClick: () => pick('merchants') },
      ]} />

      {side === 'agents' ? (
        <>
          {canFund && <PoolRequests key="AGENT" kind="AGENT" onChanged={reload} />}
          {canTeams && <TeamPools reloadKey={reloadKey} />}
        </>
      ) : (
        <>
          {canFund && <PoolRequests key="DIRECT" kind="DIRECT" onChanged={reload} />}
          {canMerchants && <MerchantAccountsPanel reloadKey={reloadKey} />}
        </>
      )}
    </div>
  );
};
