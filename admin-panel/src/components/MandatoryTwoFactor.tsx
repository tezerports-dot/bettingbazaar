// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * MandatoryTwoFactor — the one gate between a staff session and the panel.
 *
 * ── What it is for ──────────────────────────────────────────────────────────
 * `requires2FA(user)` on the server decides who must hold a second factor. The
 * server has sent `mustEnroll2FA` on the login response since 2026-09-10, and
 * the merchant panel has routed on the same flag all along — the admin panel
 * dropped it in its API mapper and never asked. So an admin who never enrolled
 * held a password-only session over the entire admin surface, permanently and
 * silently, and `seedAdmin` puts the bootstrapped admin in exactly that state
 * from the first boot. F-011.
 *
 * ── Why it sits ABOVE the route table and not inside the guards ─────────────
 * There are four guards (AdminOnly, PermRoute, QueueRoute, AnyAuth) and each
 * checks `isAuthenticated` for itself. Adding the obligation to each is four
 * copies of one rule, and the fifth guard somebody adds next year is the one
 * that forgets it — §5, the shape that drifts silently. This wraps the whole
 * route table instead, so a guard cannot opt out and a new one inherits it
 * without knowing it exists.
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────
 * It does not lock anybody out. Enrolment is reachable from here, it is the
 * only thing reachable from here, and signing out is always available — an
 * operator who cannot complete enrolment right now can leave. The server-side
 * half of F-011 (refusing every route but /api/2fa/setup and /activate to an
 * unenrolled staff session) is a separate switch and is NOT flipped by this
 * file. This is the precondition that makes flipping it safe rather than a
 * lockout: with this in place an unenrolled admin is shown the enrolment panel
 * instead of a dashboard whose every request 403s with nothing on screen to
 * say why.
 */
import { useAuthStore } from '../services/auth';
import TwoFactorSetup from './TwoFactorSetup';

const MandatoryTwoFactor: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, mustEnroll2FA, clearEnrolment2FA, logout, admin } = useAuthStore();

  // Not signed in — the route guards below own that case and send them to
  // /login. Deciding it here as well would be a second answer to one question.
  if (!isAuthenticated || !mustEnroll2FA) return <>{children}</>;

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-10 dark:bg-slate-900">
      <div className="mx-auto w-full max-w-xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
            Set up two-factor authentication
          </h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            This account can approve KYC, move balances and resolve disputes, so it
            has to be protected by more than a password. Enrol an authenticator
            app to continue.
          </p>
          {admin?.username && (
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Signed in as {admin.username}
            </p>
          )}
        </div>

        <TwoFactorSetup onEnrolled={clearEnrolment2FA} />

        <div className="mt-6 flex items-center justify-between gap-4">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Keep your recovery codes somewhere you can reach without this account.
          </p>
          {/* Always available. A gate an operator cannot leave is a lockout, and
              somebody without their phone to hand needs to be able to sign out
              rather than sit on a screen they cannot complete. */}
          <button
            type="button"
            onClick={() => void logout()}
            className="shrink-0 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-200 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
};

export default MandatoryTwoFactor;
