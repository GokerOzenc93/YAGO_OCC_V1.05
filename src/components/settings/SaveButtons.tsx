import React from 'react';
import { SaveAsDialog } from './SaveAsDialog';
import { GlobalSettingsProfile } from '../GlobalSettingsDatabase';

interface SaveButtonsProps {
  onSave: () => void;
  onSaveAs: (targetProfileId: string, profileName: string) => void;
  profiles: GlobalSettingsProfile[];
  currentProfileId: string;
}

export function SaveButtons({
  onSave,
  onSaveAs,
  profiles,
  currentProfileId
}: SaveButtonsProps) {
  const [isSaveAsDialogOpen, setIsSaveAsDialogOpen] = React.useState(false);

  return (
    <>
      <div className="flex gap-2 mt-3 pt-3 border-t border-stone-200">
        <button
          onClick={onSave}
          className="flex-1 px-3 py-1 bg-white text-orange-600 border-2 border-orange-500 text-xs font-medium rounded hover:bg-orange-50 transition-colors"
        >
          Save
        </button>
        <button
          onClick={() => setIsSaveAsDialogOpen(true)}
          className="flex-1 px-3 py-1 bg-orange-500 text-white text-xs font-medium rounded hover:bg-orange-600 transition-colors"
        >
          Save As
        </button>
      </div>

      <SaveAsDialog
        isOpen={isSaveAsDialogOpen}
        onClose={() => setIsSaveAsDialogOpen(false)}
        onSave={onSaveAs}
        profiles={profiles}
        currentProfileId={currentProfileId}
      />
    </>
  );
}
