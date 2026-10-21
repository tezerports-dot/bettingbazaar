// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/** Shown where a contact detail is withheld from a staff account that is not a full admin. */
export const CONTACT_HIDDEN = 'contact: full admins only';

export const formatters = {
  currency: (amount: number | undefined | null): string => {
    const n = Number(amount);
    if (amount == null || isNaN(n)) return '₹0';
    return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  },

  /** Paise (what the server stores and sends) as rupees; 1 token = ₹1. */
  paise: (paise: number | undefined | null): string => formatters.currency((Number(paise) || 0) / 100),

  /** A win/loss figure in paise, always with its sign: +₹300 or -₹200. */
  signedPaise: (paise: number | undefined | null): string => {
    const n = Number(paise) || 0;
    return `${n > 0 ? '+' : n < 0 ? '-' : ''}${formatters.currency(Math.abs(n) / 100)}`;
  },

  date: (date: string | Date): string => {
    return new Date(date).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  },

  datetime: (date: string | Date): string => {
    return new Date(date).toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  },

  time: (date: string | Date): string => {
    return new Date(date).toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
    });
  },

  // A mobile reaches full admins only (staffContactShield.js, CLAUDE.md §24):
  // anyone else is sent none, and is told so.
  phone: (phone?: string | null): string => {
    if (!phone) return CONTACT_HIDDEN;
    if (phone.length === 10) {
      return `+91 ${phone.slice(0, 5)}-${phone.slice(5)}`;
    }
    return phone;
  },

  percentage: (value: number): string => {
    return `${value.toFixed(2)}%`;
  },

  shortNumber: (num: number): string => {
    if (num >= 10000000) return `${(num / 10000000).toFixed(2)}Cr`;
    if (num >= 100000) return `${(num / 100000).toFixed(2)}L`;
    if (num >= 1000) return `${(num / 1000).toFixed(2)}K`;
    return num.toString();
  },

  /**
   * An exact count, grouped the Indian way (1,00,000 rather than 100,000).
   *
   * Distinct from shortNumber on purpose: an approximation is right for a
   * dashboard headline and wrong for a queue length or a member count, where
   * the operator is reconciling against something and needs the digits.
   */
  number: (value: number | undefined | null): string => {
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString('en-IN') : '0';
  },
};
