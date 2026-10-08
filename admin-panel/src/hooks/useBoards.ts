// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * useBoards — the switched-on boards, in the admin's home-page order, for
 * screens that LABEL cycles or offer a board (live cycles, history, phantom
 * access). From the public list (`GET /api/v1/boards`), which every staff area
 * can read; the Boards page itself reads the admin list with switched-off ones.
 *
 * `boardName(key)` falls back to the key, so a cycle of a board switched off
 * since still shows what it was.
 */
import { useCallback, useEffect, useState } from 'react';
import api from '../services/api';

export interface BoardSummary { key: string; name: string; kind: 'INTERVAL' | 'DAILY'; homeOrder: number }

export function useBoards() {
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => api.get('/api/v1/boards'))
      .then((r: any) => { if (live && Array.isArray(r?.data?.boards)) setBoards(r.data.boards); })
      .catch(() => { /* labels fall back to the key */ });
    return () => { live = false; };
  }, []);
  const boardName = useCallback((key: string) => boards.find((b) => b.key === key)?.name ?? key, [boards]);
  return { boards, boardName };
}
