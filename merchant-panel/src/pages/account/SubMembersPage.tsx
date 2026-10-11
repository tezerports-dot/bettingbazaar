// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A merchant account's sub-members (owner, 2026-10-11 — Phase B).
 *
 * Each sub-member has their own login at the merchant door (mobile and
 * password; they verify the mobile in Telegram at their first sign-in, like
 * every merchant login) and one or more roles:
 *
 *   Deposit verifier      (DEPOSITS)     works the buys paid into the accounts
 *                                        assigned to them for deposits;
 *   Withdrawal processor  (WITHDRAWALS)  pays sells from the accounts assigned
 *                                        to them for withdrawals;
 *   Auditor               (AUDIT)        reads every order and report, changes
 *                                        nothing.
 *
 * The owner assigns accounts per duty. The server refuses an assignment the
 * roles do not cover (409 CANNOT_ASSIGN) and every write that is not the
 * owner's (403 OWNER_ONLY); each refusal is shown in its words (§32 S44). A
 * sub-member's mobile is sent to the owner and never shown (CLAUDE.md §24).
 */
import React, { useState } from 'react';
import { Trash2, UserPlus, Users } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../../services/api';
import { useMerchantAccount } from '../../hooks/useMerchantAccount';
import { ROLE_LABEL, STAFF_ROLE_LIST } from '../../utils/actor';
import {
  Button, Card, CardTitle, ConfirmDialog, EmptyState, Field, Skeleton, inputStyle, type ConfirmRequest,
} from '../../components/ui';
import AccountShell, { Refusal } from './AccountShell';
import type { PaymentAccount, StaffDuty, StaffRole, SubMember } from '../../types';

const errorText = (err: any, fallback: string): string => err?.message || fallback;

/** Which role a duty needs (merchantStaff.js `assignAccount`). */
const DUTIES: Array<{ duty: StaffDuty; role: StaffRole; label: string }> = [
  { duty: 'DEPOSIT', role: 'DEPOSITS', label: 'Deposits' },
  { duty: 'WITHDRAWAL', role: 'WITHDRAWALS', label: 'Withdrawals' },
];

/** Role checkboxes, each named by its label (§32 S24). */
const RoleBoxes: React.FC<{ idPrefix: string; roles: StaffRole[]; onChange: (next: StaffRole[]) => void }> = ({
  idPrefix, roles, onChange,
}) => (
  <div role="group" aria-label="Roles" style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
    {STAFF_ROLE_LIST.map((role) => {
      const id = `${idPrefix}-role-${role}`;
      return (
        <span key={role} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input id={id} type="checkbox" checked={roles.includes(role)}
            onChange={(e) => onChange(e.target.checked ? [...roles, role] : roles.filter((r) => r !== role))} />
          <label htmlFor={id} style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-2)' }}>{ROLE_LABEL[role]}</label>
        </span>
      );
    })}
  </div>
);

export const AddSubMemberForm: React.FC<{ onAdded: () => Promise<void> }> = ({ onAdded }) => {
  const [mobile, setMobile] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [roles, setRoles] = useState<StaffRole[]>([]);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState('');

  const submit = async () => {
    setRefusal('');
    setBusy(true);
    try {
      await api.addSubMember({ mobile: mobile.trim(), password, name: name.trim(), roles });
      toast.success(`${name.trim() || 'Sub-member'} added. They sign in at the merchant door and verify in Telegram.`);
      setMobile(''); setPassword(''); setName(''); setRoles([]);
      await onAdded();
    } catch (err) {
      setRefusal(errorText(err, 'Could not add the sub-member.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardTitle title="Add a sub-member" sub="Their own login for this merchant account. They verify their mobile in Telegram when they first sign in." />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <Field label="Name" htmlFor="sm-new-name">
          <input id="sm-new-name" value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} maxLength={60} />
        </Field>
        <Field label="Mobile (10 digits, on their Telegram)" htmlFor="sm-new-mobile">
          <input id="sm-new-mobile" value={mobile} inputMode="numeric" autoComplete="off" onChange={(e) => setMobile(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Password" htmlFor="sm-new-password" hint="A strong password: if it is too short or too simple, the refusal below says what to change.">
          <input id="sm-new-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} style={inputStyle} />
        </Field>
      </div>
      <div style={{ marginTop: 12 }}>
        <RoleBoxes idPrefix="sm-new" roles={roles} onChange={setRoles} />
      </div>
      <Refusal message={refusal} style={{ marginTop: 10 }} />
      <Button onClick={() => void submit()} busy={busy} style={{ marginTop: 12 }}>
        <UserPlus size={15} /> Add sub-member
      </Button>
    </Card>
  );
};

const SubMemberCard: React.FC<{
  staff: SubMember;
  accounts: PaymentAccount[];
  onChanged: () => Promise<void>;
  onConfirm: (r: ConfirmRequest) => void;
}> = ({ staff, accounts, onChanged, onConfirm }) => {
  const [roles, setRoles] = useState<StaffRole[]>(staff.roles);
  const [busy, setBusy] = useState('');
  const [refusal, setRefusal] = useState('');
  const rolesChanged = roles.length !== staff.roles.length || roles.some((r) => !staff.roles.includes(r));

  const run = async (key: string, work: () => Promise<unknown>, ok: string, fail: string) => {
    setBusy(key); setRefusal('');
    try {
      await work();
      toast.success(ok);
      await onChanged();
    } catch (err) {
      setRefusal(errorText(err, fail));
    } finally {
      setBusy('');
    }
  };

  const assigned = (accountId: string, duty: StaffDuty) =>
    staff.assignments.some((a) => a.accountId === accountId && a.duty === duty);

  const remove = () => onConfirm({
    title: `Remove ${staff.name}?`,
    body: 'Their login stops working at once and their accounts are unassigned. Orders they worked keep their history.',
    confirmLabel: 'Remove sub-member',
    tone: 'danger',
    onConfirm: () => run('remove', () => api.removeSubMember(staff.staffId), `${staff.name} removed`, 'Could not remove the sub-member.'),
  });

  return (
    <Card style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div>
          <div style={{ fontSize: 14.5, fontWeight: 800, color: 'var(--text)' }}>{staff.name}</div>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)' }}>
            {staff.roles.map((r) => ROLE_LABEL[r]).join(' · ') || 'No role'}
          </div>
        </div>
        <Button variant="outline" tone="danger" style={{ padding: '8px 11px' }} onClick={remove} busy={busy === 'remove'}>
          <Trash2 size={14} /> Remove
        </Button>
      </div>

      <div style={{ marginTop: 12 }}>
        <RoleBoxes idPrefix={`sm-${staff.staffId}`} roles={roles} onChange={setRoles} />
        {rolesChanged && (
          <Button style={{ marginTop: 9 }} busy={busy === 'roles'}
            onClick={() => void run('roles', () => api.setSubMemberRoles(staff.staffId, roles), 'Roles saved', 'Could not change the roles.')}>
            Save roles
          </Button>
        )}
      </div>

      {DUTIES.filter((d) => staff.roles.includes(d.role)).map((d) => (
        <fieldset key={d.duty} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: '10px 12px', marginTop: 12 }}>
          <legend style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-2)', padding: '0 4px' }}>
            Accounts for {d.label.toLowerCase()}
          </legend>
          {accounts.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>Add a payment account first.</div>
          ) : accounts.map((a) => {
            const id = `sm-${staff.staffId}-${d.duty}-${a.accountId}`;
            const on = assigned(a.accountId, d.duty);
            return (
              <div key={a.accountId} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '3px 0' }}>
                <input id={id} type="checkbox" checked={on} disabled={busy !== ''}
                  onChange={() => void run(id,
                    () => (on
                      ? api.unassignSubMemberAccount(staff.staffId, a.accountId, d.duty)
                      : api.assignSubMemberAccount(staff.staffId, a.accountId, d.duty)),
                    on ? `${a.label} unassigned` : `${a.label} assigned`,
                    'Could not change the assignment.')} />
                <label htmlFor={id} style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>
                  {a.label}{a.status === 'PAUSED' ? ' (paused)' : ''}
                </label>
              </div>
            );
          })}
        </fieldset>
      ))}
      <Refusal message={refusal} style={{ marginTop: 10 }} />
    </Card>
  );
};

const SubMembersBody: React.FC = () => {
  const { overview, state, error, reload } = useMerchantAccount();
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  if (state === 'loading') return <Skeleton height={180} />;
  if (state === 'error') return <Refusal message={error} />;
  const staff = overview?.staff ?? [];
  const accounts = (overview?.accounts ?? []).filter((a) => a.status !== 'REMOVED');
  return (
    <>
      <AddSubMemberForm onAdded={reload} />
      {staff.length === 0 ? (
        <EmptyState title="No sub-members yet" body="Add people to verify deposits, pay withdrawals or audit, each with their own login." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {staff.map((s) => (
            <SubMemberCard key={`${s.staffId}-${s.roles.join(',')}`} staff={s} accounts={accounts} onChanged={reload} onConfirm={setConfirm} />
          ))}
        </div>
      )}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  );
};

const SubMembersPage: React.FC = () => (
  <AccountShell>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 800, color: 'var(--text)' }}>
      <Users size={18} /> Sub-members
    </div>
    <SubMembersBody />
  </AccountShell>
);

export default SubMembersPage;
