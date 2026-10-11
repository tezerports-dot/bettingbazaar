// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The frame every merchant-account screen sits in: the tabs this person may
 * open, and — when they may not open this one, or this is not a merchant
 * account at all — a sentence saying so instead of an empty page (§32 S48).
 */
import React from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useAuth } from '../../services/AuthContext';
import { useViewport } from '../../hooks/useViewport';
import { isMerchantAccountSession } from '../../utils/actor';
import { accountTabsFor, ACCOUNT_TABS } from './accountTabs';
import { Banner, Card } from '../../components/ui';

/** A refusal or failure in the server's own words, announced (§32 S44). */
export const Refusal: React.FC<{ message: string; style?: React.CSSProperties }> = ({ message, style }) =>
  message ? (
    <div role="alert" style={style}>
      <Banner tone="danger">{message}</Banner>
    </div>
  ) : null;

const AccountShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { merchant } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { isMobile } = useViewport();
  const tabs = accountTabsFor(merchant);
  const here = ACCOUNT_TABS.find((t) => location.pathname.startsWith(t.path));
  const allowed = isMerchantAccountSession(merchant) && here !== undefined && tabs.includes(here);

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: isMobile ? 14 : 16 }}>
      {isMerchantAccountSession(merchant) && (
        <nav aria-label="Merchant account" style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2 }}>
          {tabs.map((tab) => {
            const on = tab === here;
            return (
              <button
                key={tab.path}
                aria-current={on ? 'page' : undefined}
                onClick={() => navigate(tab.path)}
                style={{
                  padding: '8px 13px', borderRadius: 10, cursor: 'pointer', whiteSpace: 'nowrap',
                  fontSize: 12.5, fontWeight: 700,
                  border: `1px solid ${on ? 'var(--brand)' : 'var(--border)'}`,
                  background: on ? 'var(--brand-bg)' : 'var(--surface)',
                  color: on ? 'var(--brand)' : 'var(--text-2)',
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
      )}
      {allowed ? children : (
        <Card>
          <div role="status" style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)', lineHeight: 1.5 }}>
            {isMerchantAccountSession(merchant)
              ? 'This screen is for the merchant account owner (reports also for auditors). Ask the owner if you need it.'
              : 'These screens are for merchant accounts. Agents and supervisors use the Team page.'}
          </div>
        </Card>
      )}
    </div>
  );
};

export default AccountShell;
