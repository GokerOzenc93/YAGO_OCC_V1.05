import React, { ReactNode } from 'react';

interface LayoutProps {
  toolbar: ReactNode;
  content: ReactNode;
  statusBar: ReactNode;
}

const Layout: React.FC<LayoutProps> = ({ toolbar, content, statusBar }) => {
  return (
    <div className="flex flex-col h-screen">
      {toolbar}
      <div className="flex-1 overflow-hidden pb-[62px]">{content}</div>
      {statusBar}
    </div>
  );
};

export default Layout;
