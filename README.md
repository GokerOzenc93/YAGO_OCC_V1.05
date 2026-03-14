# YAGO CAD

Modern 3D CAD application built with OpenCascade.js for BREP-based solid modeling.

## Project Structure

```
src/
├── ui/                  # UI Components
│   ├── Layout.tsx       # Main layout wrapper
│   ├── Toolbar.tsx      # Top toolbar with tools
│   ├── StatusBar.tsx    # Bottom status bar
│   └── Terminal.tsx     # Console/terminal overlay
│
├── App.tsx              # Main application
├── Scene.tsx            # 3D scene with Three.js/Fiber
├── store.ts             # Zustand state management
├── opencascade.ts       # OpenCascade BREP utilities
├── main.tsx             # Entry point
└── index.css            # Global styles
```

## Features

- **BREP Geometry**: All geometry created using OpenCascade.js
- **3D Viewport**: Real-time 3D rendering with Three.js
- **Wireframe Display**: Clean edge visualization
- **Transform Controls**: Interactive translate, rotate, and scale tools
- **Object Selection**: Click to select objects, visual feedback
- **Camera Controls**:
  - Perspective/Orthographic toggle
  - Orbit controls with damping
  - Auto-disable during transforms
- **Keyboard Shortcuts**:
  - `Delete` - Delete selected object
  - `Escape` - Deselect object
- **Gizmo**: Visual axis helper
- **Grid**: Infinite grid for reference
- **Terminal**: Built-in console for debugging
- **Live Status Bar**: Object count, selection info, position tracking

## Tech Stack

- **React 18** - UI framework
- **Three.js** - 3D rendering
- **@react-three/fiber** - React renderer for Three.js
- **@react-three/drei** - Useful helpers (OrbitControls, Grid, Gizmo)
- **OpenCascade.js** - CAD kernel for BREP geometry
- **Zustand** - State management
- **TailwindCSS** - Styling
- **TypeScript** - Type safety
- **Vite** - Build tool

## Getting Started

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build
```

## OpenCascade Integration

OpenCascade.js is loaded from CDN to avoid WebAssembly bundling issues. The library is loaded dynamically at runtime via script injection. If OpenCascade fails to load, the application falls back to Three.js primitives.

### Creating Geometry

```typescript
import { createOCGeometry, convertOCShapeToThreeGeometry } from './opencascade';

const ocShape = createOCGeometry(opencascadeInstance, {
  type: 'box',
  width: 600,
  height: 600,
  depth: 600
});

const geometry = convertOCShapeToThreeGeometry(opencascadeInstance, ocShape);
```

### Boolean Operations

```typescript
import { performOCBoolean } from './opencascade';

const result = performOCBoolean(
  opencascadeInstance,
  shape1,
  shape2,
  'subtract' // or 'union', 'intersect'
);
```

## State Management

Global state is managed with Zustand:

```typescript
const { shapes, addShape, selectShape, opencascadeInstance } = useAppStore();
```

## Development Notes

- OpenCascade.js is loaded from CDN (jsDelivr) to avoid Vite WebAssembly issues
- All geometry is BREP-based for precision
- Wireframe-only display (opacity: 0 on meshes)
- TransformControls automatically disable OrbitControls during drag
- Two-level file structure for simplicity
- UI components isolated in `/ui` folder

## Usage

1. **Add Geometry**: Click "Add Geometry" in toolbar to create a box
2. **Select Object**: Click on any object in the 3D view
3. **Transform**: Use toolbar tools (Move/Rotate/Scale) to transform selected object
4. **Delete**: Press `Delete` key to remove selected object
5. **Camera**: Toggle Perspective/Orthographic from toolbar
6. **Console**: Click terminal icon (bottom-right) for debug output

## License

Proprietary - YAGO Design
