// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)

import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';

type ToastType = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastContextType {
  addToast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

/** How long a notice stays unless its cross is pressed (owner, 2026-10-14). UI-only, §11. */
export const TOAST_MS = 1000;

/**
 * One notice at a time (owner, 2026-10-14): a new one replaces the one on
 * screen at once, instead of stacking under it, and the last one goes after
 * TOAST_MS or when its cross is pressed.
 */
export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  const close = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setToast(null);
  }, []);

  const addToast = useCallback((message: string, type: ToastType = 'info') => {
    if (timer.current) clearTimeout(timer.current);
    seq.current += 1;
    setToast({ id: seq.current, message, type });
    timer.current = setTimeout(() => { timer.current = null; setToast(null); }, TOAST_MS);
  }, []);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      {/* A live region, so a refusal is ANNOUNCED. Without one, "You already
          backed BOMBAY this cycle" was painted for three seconds and never
          spoken: a player on a screen reader pressed the bet card and heard
          nothing. An error interrupts (alert); anything else waits (status).
          The browser drive found it the same way — it reads these roles, and
          the bet card's refusals read as a button that did nothing. */}
      <div aria-live="polite" className="fixed top-4 left-1/2 transform -translate-x-1/2 z-[100] flex flex-col gap-2 w-full max-w-xs px-4 pointer-events-none">
        {toast && (
          <div
            key={toast.id}
            role={toast.type === 'error' ? 'alert' : 'status'}
            className={`
              pointer-events-auto rounded-lg pl-3 pr-1 py-1 shadow-2xl border flex items-center justify-between gap-2 animate-in fade-in slide-in-from-top-2
              ${toast.type === 'success' ? 'bg-[#0B0E14] border-green-500 text-green-400' : 
                toast.type === 'error' ? 'bg-[#0B0E14] border-red-500 text-red-400' : 
                'bg-[#0B0E14] border-[var(--brand-primary, #D4AF37)] text-[var(--brand-primary, #D4AF37)]'}
            `}
          >
            <span className="text-xs font-bold leading-tight">{toast.message}</span>
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="flex-none w-6 h-6 flex items-center justify-center rounded text-sm leading-none cursor-pointer"
            >
              {toast.type === 'success' ? '✅' : toast.type === 'error' ? '❌' : 'ℹ️'}
            </button>
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used within ToastProvider");
  return context;
};
