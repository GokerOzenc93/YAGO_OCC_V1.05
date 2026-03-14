import React from 'react';
import { useAppStore } from '../store';

const StatusBar: React.FC = () => {
  const { shapes, selectedShapeId, vertexEditMode, selectedVertexIndex } = useAppStore();

  const selectedShape = shapes.find(s => s.id === selectedShapeId);
  const vertexModCount = selectedShape?.vertexModifications?.length || 0;

  return (
    <div className="absolute bottom-6 left-0 right-0 flex items-center h-5 px-4 bg-stone-800 text-stone-300 text-xs border-t border-stone-700 z-20">
      <div className="flex items-center gap-4">
        <span className="text-stone-400">Objects: {shapes.length}</span>
        <span className="text-stone-400">
          Selected: {selectedShape ? `${selectedShape.type} (${selectedShape.id.slice(0, 8)})` : 'None'}
        </span>
        {selectedShape && (
          <span className="text-stone-400">
            Pos: [{selectedShape.position.map(v => v.toFixed(1)).join(', ')}]
          </span>
        )}
        {vertexEditMode && (
          <span className="text-blue-400">
            Vertex Edit {selectedVertexIndex !== null ? `(V${selectedVertexIndex})` : ''}
          </span>
        )}
        {vertexModCount > 0 && (
          <span className="text-purple-400">
            Vertex Mods: {vertexModCount}
          </span>
        )}
      </div>
    </div>
  );
};

export default StatusBar;
