// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import React from 'react';

interface ShowProps {
  when: any;
  children?: React.ReactNode;
  fallback?: React.ReactNode;
}

export function Show({ when, children, fallback = null }: ShowProps) {
  return when ? <>{children}</> : <>{fallback}</>;
}