import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { globalSettingsService, GlobalSettingsProfile } from '../GlobalSettingsDatabase';

interface SaveAsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (profileId: string, profileName: string) => void;
  profiles: GlobalSettingsProfile[];
  currentProfileId: string;
}

export function SaveAsDialog({ isOpen, onClose, onSave, profiles, currentProfileId }: SaveAsDialogProps) {
  const [selectedProfileId, setSelectedProfileId] = useState<string>(currentProfileId);

  useEffect(() => {
    if (isOpen) {
      setSelectedProfileId(currentProfileId);
    }
  }, [isOpen, currentProfileId]);

  const handleSave = () => {
    const selectedProfile = profiles.find(p => p.id === selectedProfileId);
    if (selectedProfile) {
      onSave(selectedProfileId, selectedProfile.name);
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60]">
      <div className="bg-white rounded-lg shadow-xl w-80 max-w-full mx-4">
        <div className="flex items-center justify-between px-4 py-3 border-b border-stone-200">
          <h3 className="text-sm font-semibold text-slate-800">Save Panel Joint Settings</h3>
          <button
            onClick={onClose}
            className="p-1 hover:bg-stone-100 rounded transition-colors"
          >
            <X size={16} className="text-stone-600" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-2">
              Select Profile
            </label>
            <select
              value={selectedProfileId}
              onChange={(e) => setSelectedProfileId(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-stone-300 rounded focus:outline-none focus:border-orange-500"
            >
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </div>

          <p className="text-xs text-stone-500">
            Settings will be saved to the selected profile.
          </p>
        </div>

        <div className="flex gap-2 px-4 py-3 border-t border-stone-200">
          <button
            onClick={onClose}
            className="flex-1 px-3 py-2 text-sm bg-white text-stone-700 border border-stone-300 rounded hover:bg-stone-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="flex-1 px-3 py-2 text-sm bg-orange-500 text-white rounded hover:bg-orange-600 transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
