// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
export const validators = {
  mobile: (mobile: string): boolean => {
    return /^[6-9]\d{9}$/.test(mobile);
  },

  email: (email: string): boolean => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  },

  aadhaar: (aadhaar: string): boolean => {
    return /^\d{12}$/.test(aadhaar.replace(/\s/g, ''));
  },

  pan: (pan: string): boolean => {
    return /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(pan.toUpperCase());
  },

  ifsc: (ifsc: string): boolean => {
    return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc.toUpperCase());
  },

  amount: (amount: number, min: number = 0, max?: number): boolean => {
    if (amount < min) return false;
    if (max && amount > max) return false;
    return true;
  },

  url: (url: string): boolean => {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  },
};
