// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
export const formatters = {
  currency: (amount: number | undefined | null): string => {
    const n = Number(amount);
    if (amount == null || isNaN(n)) return '₹0';
    return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
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

  phone: (phone: string): string => {
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
};
