// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useCallback } from 'react';
import { Upload, X } from 'lucide-react';

interface FileUploadProps {
  onFileSelect: (file: File) => void;
  accept?: string;
  maxSize?: number; // in MB
  preview?: string;
  onClear?: () => void;
}

export const FileUpload: React.FC<FileUploadProps> = ({
  onFileSelect,
  accept = 'image/*',
  maxSize = 5,
  preview,
  onClear,
}) => {
  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file && validateFile(file)) {
        onFileSelect(file);
      }
    },
    [onFileSelect]
  );

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && validateFile(file)) {
      onFileSelect(file);
    }
  };

  const validateFile = (file: File): boolean => {
    if (file.size > maxSize * 1024 * 1024) {
      alert(`File size must be less than ${maxSize}MB`);
      return false;
    }
    return true;
  };

  if (preview) {
    return (
      <div className="relative">
        <img src={preview} alt="Preview" className="w-full h-48 object-cover rounded-lg" />
        {onClear && (
          <button
            onClick={onClear}
            className="absolute top-2 right-2 p-2 bg-red-600 hover:bg-red-700 rounded-lg transition-colors"
          >
            <X size={16} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
      className="border-2 border-dashed border-dark-600 rounded-lg p-8 text-center hover:border-gold-500 transition-colors cursor-pointer"
    >
      <input
        type="file"
        accept={accept}
        onChange={handleFileInput}
        className="hidden"
        id="file-upload"
      />
      <label htmlFor="file-upload" className="cursor-pointer">
        <Upload size={48} className="mx-auto mb-4 text-gray-400" />
        <p className="text-gray-300 mb-2">Drop your file here or click to browse</p>
        <p className="text-sm text-gray-500">Max size: {maxSize}MB</p>
      </label>
    </div>
  );
};
