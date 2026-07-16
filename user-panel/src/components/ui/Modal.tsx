// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect } from 'react';
import { Show } from './Show';

interface ModalProps {
  children: React.ReactNode;
  onClose: () => void;
  title?: string;
}

const Modal: React.FC<ModalProps> = ({ children, onClose, title }) => {
  // Lock body scroll when modal is open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6" style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}>
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/80 backdrop-blur-sm transition-opacity cursor-pointer"
        onClick={onClose}
      ></div>

      {/* Content Container - Responsive */}
      <div className="relative bg-[#1A1F2E] w-full max-w-md rounded-2xl border border-[#D4AF37]/30 shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-200 flex flex-col max-h-[90vh]">
        
        {/* Header */}
        {title !== undefined && title !== null && title !== '' ? (
          <div className="px-6 py-4 border-b border-white/5 flex justify-between items-center bg-[#121826] shrink-0">
            <h3 className="text-lg font-bold text-[#EAEAEA] truncate pr-4">{title}</h3>
            <button 
                onClick={onClose} 
                className="w-8 h-8 flex items-center justify-center rounded-full bg-white/5 text-white/50 hover:text-white hover:bg-white/10 transition-colors"
            >
                ✕
            </button>
          </div>
        ) : null}

        {/* Scrollable Body */}
        <div className="p-6 overflow-y-auto custom-scrollbar overscroll-contain">
          {children}
        </div>
      </div>
    </div>
  );
};

export default Modal;
