// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React from 'react';
import { User } from 'lucide-react';

interface UserAvatarProps {
  src?: string;
  name: string;
  size?: 'sm' | 'md' | 'lg';
}

export const UserAvatar: React.FC<UserAvatarProps> = ({ src, name, size = 'md' }) => {
  const sizeClasses = {
    sm: 'w-8 h-8 text-xs',
    md: 'w-10 h-10 text-sm',
    lg: 'w-16 h-16 text-lg',
  };

  const iconSizes = {
    sm: 16,
    md: 20,
    lg: 32,
  };

  if (src) {
    return (
      <img
        src={src}
        alt={name}
        className={`${sizeClasses[size]} rounded-full object-cover`}
      />
    );
  }

  const initials = name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <div
      className={`${sizeClasses[size]} rounded-full bg-gradient-to-br from-gold-400 to-gold-600 flex items-center justify-center font-semibold text-dark-900`}
    >
      {initials || <User size={iconSizes[size]} />}
    </div>
  );
};
