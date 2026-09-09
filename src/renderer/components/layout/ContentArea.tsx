import React from 'react';

export interface ContentAreaProps {
  children: React.ReactNode;
}

export const ContentArea: React.FC<ContentAreaProps> = ({ children }) => {
  return (
    <main className="flex-1 bg-[var(--bg-app)] overflow-y-auto custom-scrollbar p-6 space-y-5 select-text transition-colors duration-200">
      {children}
    </main>
  );
};
