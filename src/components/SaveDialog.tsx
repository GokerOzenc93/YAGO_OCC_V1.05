import React, { useState, useEffect } from 'react';
import { X, Save } from 'lucide-react';

interface SaveDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: { code: string; description: string; tags: string[]; previewImage?: string }) => void;
  shapeId: string;
  captureSnapshot: () => string;
}

const SaveDialog: React.FC<SaveDialogProps> = ({ isOpen, onClose, onSave, shapeId, captureSnapshot }) => {
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [previewImage, setPreviewImage] = useState<string>('');

  useEffect(() => {
    if (isOpen) {
      const snapshot = captureSnapshot();
      setPreviewImage(snapshot);
    } else {
      setPreviewImage('');
    }
  }, [isOpen, captureSnapshot]);

  if (!isOpen) return null;

  const handleSave = () => {
    const tags = tagsInput.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0);

    if (!code.trim()) {
      alert('Please enter a code');
      return;
    }

    onSave({ code, description, tags, previewImage });
    setCode('');
    setDescription('');
    setTagsInput('');
    setPreviewImage('');
    onClose();
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center"
      onClick={handleOverlayClick}
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md border border-stone-200">
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-200">
          <h2 className="text-lg font-semibold text-slate-800">Save to Catalog</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-stone-100 transition-colors"
          >
            <X size={18} className="text-slate-600" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {previewImage && (
            <div className="w-full aspect-video bg-stone-100 rounded-lg overflow-hidden border border-stone-200">
              <img
                src={previewImage}
                alt="Preview"
                className="w-full h-full object-contain"
              />
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Code *
            </label>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="e.g., CHAIR-001"
              className="w-full px-3 py-2 border border-stone-300 rounded-lg focus:outline-none focus:border-orange-400 focus:ring-1 focus:ring-orange-400 text-slate-800"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Enter description..."
              rows={3}
              className="w-full px-3 py-2 border border-stone-300 rounded-lg focus:outline-none focus:border-orange-400 focus:ring-1 focus:ring-orange-400 text-slate-800 resize-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Tags
            </label>
            <input
              type="text"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="furniture, chair, modern (comma-separated)"
              className="w-full px-3 py-2 border border-stone-300 rounded-lg focus:outline-none focus:border-orange-400 focus:ring-1 focus:ring-orange-400 text-slate-800"
            />
            <p className="text-xs text-stone-500 mt-1">Separate tags with commas</p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-stone-200 bg-stone-50 rounded-b-xl">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-slate-700 hover:bg-stone-200 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 text-sm font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-lg transition-colors flex items-center gap-2"
          >
            <Save size={16} />
            Save to Catalog
          </button>
        </div>
      </div>
    </div>
  );
};

export default SaveDialog;
