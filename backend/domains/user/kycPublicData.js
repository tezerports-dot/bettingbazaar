// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Public KYC projection shared by auth/session/user routes.
// Keep KYC documents and PII private; expose only the resubmission reason.
export function buildPublicKycData(user) {
  return user?.kycStatus === 'REJECTED' && user.kycData?.rejectionReason
    ? { rejectionReason: user.kycData.rejectionReason }
    : null;
}
