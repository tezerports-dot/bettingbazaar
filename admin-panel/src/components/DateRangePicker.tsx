// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import React from 'react';
import { Calendar } from 'lucide-react';

interface DateRangePickerProps {
  startDate: string;
  endDate: string;
  onStartDateChange: (date: string) => void;
  onEndDateChange: (date: string) => void;
  /**
   * What this range filters — "audit entries", "cycles", "transactions".
   *
   * Both inputs were announced as "date" and nothing else, on three screens at
   * once (§32 S24). A screen reader user met four identical date fields with no
   * way to tell which was the start, which the end, or what either narrowed.
   * The component cannot know what it is filtering, so the caller says.
   */
  filters?: string;
}

export const DateRangePicker: React.FC<DateRangePickerProps> = ({
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
  filters = 'results',
}) => {
  return (
    <div className="flex items-center space-x-2">
      <div className="relative flex-1">
        <Calendar className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" size={16} />
        <input
          type="date"
          aria-label={`Show ${filters} from this date`}
          value={startDate}
          onChange={(e) => onStartDateChange(e.target.value)}
          className="input pl-10"
        />
      </div>
      <span className="text-gray-400">to</span>
      <div className="relative flex-1">
        <Calendar className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" size={16} />
        <input
          type="date"
          aria-label={`Show ${filters} up to this date`}
          value={endDate}
          onChange={(e) => onEndDateChange(e.target.value)}
          className="input pl-10"
        />
      </div>
    </div>
  );
};
