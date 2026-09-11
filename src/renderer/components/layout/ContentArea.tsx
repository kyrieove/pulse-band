import React from 'react';

export interface ContentAreaProps {
  children: React.ReactNode;
}

export const ContentArea: React.FC<ContentAreaProps> = ({ children }) => {
  return (
    <main className="flex-1 min-w-0 min-h-0 flex flex-col gap-2.5 overflow-y-auto custom-scrollbar select-text">
      {children}
    </main>
  );
};
