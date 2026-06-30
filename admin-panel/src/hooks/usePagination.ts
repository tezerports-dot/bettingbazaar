// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { useState } from 'react';

interface UsePaginationProps {
  initialPage?: number;
  initialLimit?: number;
}

export const usePagination = ({ initialPage = 1, initialLimit = 50 }: UsePaginationProps = {}) => {
  const [page, setPage] = useState(initialPage);
  const [limit, setLimit] = useState(initialLimit);

  const goToPage = (newPage: number) => {
    setPage(newPage);
  };

  const nextPage = () => {
    setPage((prev) => prev + 1);
  };

  const prevPage = () => {
    setPage((prev) => Math.max(1, prev - 1));
  };

  const reset = () => {
    setPage(1);
  };

  return {
    page,
    limit,
    setPage: goToPage,
    setLimit,
    nextPage,
    prevPage,
    reset,
  };
};
