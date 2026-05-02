import React from 'react';
import { Search, Settings, HelpCircle } from 'lucide-react';

const TopBar: React.FC = () => (
  <div className="flex items-center h-11 px-4 bg-white border-b border-stone-200 shadow-sm select-none font-sans shrink-0">
    <div className="flex items-center gap-3">
      <img src="/yago_logo.png" alt="YAGO" className="h-7 w-auto object-contain" />
      <div className="w-px h-5 bg-stone-200" />
      <div className="flex items-center gap-1 text-[13.1px]">
        <span className="text-stone-400 font-medium">Company</span>
        <span className="text-stone-300 mx-0.5">/</span>
        <span className="text-orange-600 font-semibold">Göker İnşaat</span>
      </div>
      <div className="w-px h-5 bg-stone-200" />
      <div className="flex items-center gap-1 text-[13.1px]">
        <span className="text-stone-400 font-medium">Project</span>
        <span className="text-stone-300 mx-0.5">/</span>
        <span className="text-stone-700 font-semibold">Drawing1</span>
      </div>
    </div>
    <div className="ml-auto flex items-center gap-2">
      <div className="relative">
        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400 pointer-events-none" />
        <input
          type="text"
          placeholder="Search..."
          className="w-36 h-7 pl-8 pr-3 text-xs bg-stone-50 rounded-lg border border-stone-200 focus:outline-none focus:border-orange-400 focus:ring-1 focus:ring-orange-200 transition-all placeholder-stone-400 text-stone-700"
        />
      </div>
      <button title="Settings" className="flex items-center justify-center w-7 h-7 rounded-md text-stone-400 hover:bg-stone-100 hover:text-stone-700 transition-colors">
        <Settings size={17} />
      </button>
      <button title="Help" className="flex items-center justify-center w-7 h-7 rounded-md text-stone-400 hover:bg-stone-100 hover:text-stone-700 transition-colors">
        <HelpCircle size={17} />
      </button>
    </div>
  </div>
);

export default TopBar;
