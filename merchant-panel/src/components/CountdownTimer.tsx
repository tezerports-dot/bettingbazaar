// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * CountdownTimer.tsx
 * Reusable live countdown timer for merchant order cards.
 * UI-only component — intentionally a display-only UI constant (GOVERNANCE §10).
 * Actual expiry enforcement is backend-side via setInterval expiry worker.
 */
import React, { useState, useEffect, useRef } from 'react';

interface CountdownTimerProps {
  expiresAt: string | number | Date | undefined;
  onExpire?: () => void;
}

const CountdownTimer: React.FC<CountdownTimerProps> = ({ expiresAt, onExpire }) => {
  const [timeLeft, setTimeLeft] = useState(0);
  const firedRef = useRef(false);

  useEffect(() => {
    if (!expiresAt) return;

    const getTimeLeft = () =>
      Math.max(0, new Date(expiresAt).getTime() - Date.now());

    const update = () => {
      const left = getTimeLeft();
      setTimeLeft(left);
      if (left === 0 && !firedRef.current) {
        firedRef.current = true;
        onExpire?.();
      }
    };

    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [expiresAt, onExpire]);

  if (!expiresAt) return null;

  const m = Math.floor(timeLeft / 60000);
  const s = Math.floor((timeLeft % 60000) / 1000);
  const urgent = timeLeft < 5 * 60 * 1000 && timeLeft > 0;

  return (
    <span
      className={
        timeLeft === 0
          ? 'text-gray-500 text-sm font-mono'
          : urgent
          ? 'text-red-500 font-bold animate-pulse text-sm font-mono'
          : 'text-gray-600 text-sm font-mono'
      }
    >
      {timeLeft === 0
        ? 'Expired'
        : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`}
    </span>
  );
};

export default CountdownTimer;
