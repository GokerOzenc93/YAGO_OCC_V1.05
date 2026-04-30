import React, { useState, useEffect } from 'react';
import { X, GripVertical, Plus, Trash2 } from 'lucide-react';
import { PanelJointSettings } from './settings/PanelJointSettings';
import { BackPanelSettings } from './settings/BackPanelSettings';
import { globalSettingsService, GlobalSettingsProfile } from './GlobalSettingsDatabase';

interface GlobalSettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

interface SettingOption {
  id: string;
  label: string;
}

interface Profile extends GlobalSettingsProfile {
  isEditing?: boolean;
}

const allSettingOptions: SettingOption[] = [
  { id: 'panel_joint', label: 'Panel Joint Types' },
  { id: 'back_panel', label: 'Back Panel Settings' }
];

export function GlobalSettingsPanel({ isOpen, onClose }: GlobalSettingsPanelProps) {
  const [position, setPosition] = useState({ x: 500, y: 100 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<string | null>(null);
  const [hoveredProfile, setHoveredProfile] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savedSettingTypes, setSavedSettingTypes] = useState<string[]>([]);
  const [loadingSettings, setLoadingSettings] = useState(false);

  const isDefaultProfile = () => {
    const profile = profiles.find(p => p.id === selectedProfile);
    return profile?.name === 'Default' || profiles.indexOf(profile!) === 0;
  };

  useEffect(() => {
    if (isOpen) {
      loadProfiles();
    }
  }, [isOpen]);

  useEffect(() => {
    if (selectedProfile) {
      loadProfileSettingTypes();
    }
  }, [selectedProfile]);

  const loadProfiles = async () => {
    try {
      setLoading(true);
      const data = await globalSettingsService.listProfiles();
      setProfiles(data.map(p => ({ ...p, isEditing: false })));
      if (data.length > 0 && !selectedProfile) {
        setSelectedProfile(data[0].id);
      }
    } catch (error) {
      console.error('Failed to load profiles:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadProfileSettingTypes = async () => {
    if (!selectedProfile) return;

    try {
      setLoadingSettings(true);
      const settings = await globalSettingsService.getAllProfileSettings(selectedProfile);
      setSavedSettingTypes(settings.map(s => s.setting_type));

      if (selectedOption && !isDefaultProfile()) {
        const hasSelectedOption = settings.some(s => s.setting_type === selectedOption);
        if (!hasSelectedOption) {
          setSelectedOption(null);
        }
      }
    } catch (error) {
      console.error('Failed to load profile settings:', error);
      setSavedSettingTypes([]);
    } finally {
      setLoadingSettings(false);
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    setDragOffset({
      x: e.clientX - position.x,
      y: e.clientY - position.y
    });
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging) {
        setPosition({
          x: e.clientX - dragOffset.x,
          y: e.clientY - dragOffset.y
        });
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, dragOffset]);

  const handleAddProfile = async () => {
    try {
      const newProfile = await globalSettingsService.createProfile(
        `Profile ${profiles.length}`,
        profiles.length
      );
      setProfiles([...profiles, { ...newProfile, isEditing: false }]);
      setSelectedProfile(newProfile.id);
    } catch (error) {
      console.error('Failed to add profile:', error);
    }
  };

  const handleProfileNameChange = (profileId: string, newName: string) => {
    setProfiles(profiles.map(p =>
      p.id === profileId ? { ...p, name: newName } : p
    ));
  };

  const handleStartEditing = (profileId: string) => {
    const profile = profiles.find(p => p.id === profileId);
    if (profile?.name === 'Default') return;

    setProfiles(profiles.map(p =>
      p.id === profileId ? { ...p, isEditing: true } : { ...p, isEditing: false }
    ));
  };

  const handleStopEditing = async (profileId: string) => {
    const profile = profiles.find(p => p.id === profileId);
    if (profile) {
      try {
        await globalSettingsService.updateProfile(profileId, { name: profile.name });
      } catch (error) {
        console.error('Failed to update profile name:', error);
      }
    }
    setProfiles(profiles.map(p =>
      p.id === profileId ? { ...p, isEditing: false } : p
    ));
  };

  const handleDeleteProfile = async (profileId: string) => {
    const profile = profiles.find(p => p.id === profileId);
    if (profile?.name === 'Default' || profiles.length === 1) {
      return;
    }

    try {
      await globalSettingsService.deleteProfile(profileId);
      const updatedProfiles = profiles.filter(p => p.id !== profileId);
      setProfiles(updatedProfiles);

      if (selectedProfile === profileId) {
        setSelectedProfile(updatedProfiles[0].id);
      }
    } catch (error) {
      console.error('Failed to delete profile:', error);
    }
  };

  const handleSettingsSaved = () => {
    loadProfileSettingTypes();
  };

  const getVisibleOptions = () => {
    if (isDefaultProfile()) {
      return allSettingOptions;
    }
    return allSettingOptions.filter(opt => savedSettingTypes.includes(opt.id));
  };

  const visibleOptions = getVisibleOptions();
  const selectedProfileData = profiles.find(p => p.id === selectedProfile);
  const canDeleteProfile = selectedProfileData?.name !== 'Default' && profiles.length > 1;

  if (!isOpen) return null;

  return (
    <div
      className="fixed bg-white rounded-lg shadow-2xl border border-stone-300 z-50"
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        width: '760px',
        height: '680px'
      }}
    >
      <div
        className="flex items-center justify-between px-3 py-2 bg-stone-100 border-b border-stone-300 rounded-t-lg cursor-move"
        onMouseDown={handleMouseDown}
      >
        <div className="flex items-center gap-2">
          <GripVertical size={14} className="text-stone-400" />
          <span className="text-sm font-semibold text-slate-800">Global Settings</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleAddProfile}
            className="p-0.5 hover:bg-stone-200 rounded transition-colors"
            title="Add Profile"
          >
            <Plus size={14} className="text-stone-600" />
          </button>
          <button
            onClick={() => selectedProfile && handleDeleteProfile(selectedProfile)}
            className={`p-0.5 hover:bg-red-100 rounded transition-colors ${
              !canDeleteProfile ? 'opacity-30 cursor-not-allowed' : ''
            }`}
            title="Delete Selected Profile"
            disabled={!canDeleteProfile}
          >
            <Trash2 size={14} className="text-red-600" />
          </button>
          <button
            onClick={onClose}
            className="p-0.5 hover:bg-stone-200 rounded transition-colors"
          >
            <X size={14} className="text-stone-600" />
          </button>
        </div>
      </div>

      <div className="flex h-[calc(100%-44px)]">
        <div className="w-48 border-r border-stone-200 bg-white p-2 space-y-1">
          {loading ? (
            <div className="text-xs text-stone-400 text-center py-4">Loading...</div>
          ) : (
            profiles.map((profile) => (
              <div
                key={profile.id}
                onClick={() => {
                  setSelectedProfile(profile.id);
                  setSelectedOption(null);
                }}
                onDoubleClick={() => handleStartEditing(profile.id)}
                onMouseEnter={() => setHoveredProfile(profile.id)}
                onMouseLeave={() => setHoveredProfile(null)}
                className={`relative text-xs px-2 py-0.5 bg-white border border-stone-200 rounded cursor-pointer transition-all ${
                  selectedProfile === profile.id
                    ? 'text-slate-700 border-l-4 border-l-orange-500'
                    : hoveredProfile === profile.id
                    ? 'text-slate-700 border-l-4 border-l-orange-300'
                    : 'text-slate-700'
                }`}
              >
                {profile.isEditing ? (
                  <input
                    type="text"
                    value={profile.name}
                    onChange={(e) => handleProfileNameChange(profile.id, e.target.value)}
                    onBlur={() => handleStopEditing(profile.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        handleStopEditing(profile.id);
                      }
                    }}
                    autoFocus
                    className="w-full bg-transparent border-none outline-none text-xs"
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="select-none">{profile.name}</span>
                )}
              </div>
            ))
          )}
        </div>

        <div className="w-48 border-r border-stone-200 bg-white p-2 space-y-1">
          {loadingSettings ? (
            <div className="text-xs text-stone-400 text-center py-4">Loading...</div>
          ) : visibleOptions.length === 0 ? (
            <div className="text-xs text-stone-400 text-center py-4">
              No settings saved
            </div>
          ) : (
            visibleOptions.map((option) => (
              <button
                key={option.id}
                onClick={() => setSelectedOption(option.id)}
                className={`w-full text-xs text-left px-2 py-0.5 bg-white border border-stone-200 rounded transition-all ${
                  selectedOption === option.id
                    ? 'text-slate-700 border-l-4 border-l-orange-500'
                    : 'text-slate-700 hover:border-l-4 hover:border-l-orange-300'
                }`}
              >
                {option.label}
              </button>
            ))
          )}
        </div>

        <div className="flex-1 bg-white p-4 overflow-auto">
          {selectedOption === 'panel_joint' && selectedProfile ? (
            <PanelJointSettings
              profileId={selectedProfile}
              profiles={profiles}
              isDefaultProfile={isDefaultProfile()}
              onSettingsSaved={handleSettingsSaved}
            />
          ) : selectedOption === 'back_panel' && selectedProfile ? (
            <BackPanelSettings
              profileId={selectedProfile}
              isDefaultProfile={isDefaultProfile()}
              onSettingsSaved={handleSettingsSaved}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-stone-400 text-sm">
              {isDefaultProfile() ? 'Select a setting' : 'No settings available'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
