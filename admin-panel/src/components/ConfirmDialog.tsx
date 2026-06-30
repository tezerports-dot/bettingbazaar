// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React from 'react';
import { AlertTriangle, CheckCircle, Info, XCircle } from 'lucide-react';

interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  type?: 'danger' | 'warning' | 'info' | 'success';
  confirmText?: string;
  cancelText?: string;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  type = 'warning',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
}) => {
  if (!isOpen) return null;

  const icons = {
    danger: <XCircle className="text-red-500" size={48} />,
    warning: <AlertTriangle className="text-yellow-500" size={48} />,
    info: <Info className="text-blue-500" size={48} />,
    success: <CheckCircle className="text-green-500" size={48} />,
  };

  const buttonStyles = {
    danger: 'bg-red-600 hover:bg-red-700',
    warning: 'bg-yellow-600 hover:bg-yellow-700',
    info: 'bg-blue-600 hover:bg-blue-700',
    success: 'bg-green-600 hover:bg-green-700',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 animate-fadeIn" onClick={(e)=>{if(e.target===e.currentTarget)onClose();}}>
      <div className="bg-dark-800 rounded-xl shadow-xl w-full max-w-md animate-slideIn">
        <div className="p-6 text-center">
          <div className="flex justify-center mb-4">{icons[type]}</div>
          <h3 className="text-xl font-bold mb-2">{title}</h3>
          <p className="text-gray-400 mb-6">{message}</p>

          <div className="flex space-x-3">
            <button onClick={onClose} className="flex-1 btn-secondary">
              {cancelText}
            </button>
            <button
              onClick={() => {
                onConfirm();
                onClose();
              }}
              className={`flex-1 px-4 py-2 rounded-lg font-semibold text-white transition-colors ${buttonStyles[type]}`}
            >
              {confirmText}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
