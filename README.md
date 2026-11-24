# YAGO CAD

Parametric cabinet / furniture CAD in the browser. Solids are real B-Rep geometry (OpenCascade.js through replicad), drawn with Three.js.

## Getting started

```bash
npm install
npm run dev      # development server
npm run build    # production build (dist/)
npm run lint
npx tsc --noEmit -p tsconfig.app.json   # type check (the root tsconfig.json only references the app / node configs)
```

Optional: `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in `.env` enable the geometry catalog. Without them the app runs in local mode.

## Project structure

```
index.html
vite.config.ts              # Vite config (cut worker is bundled as an ES module)
public/
├── icons/                  # toolbar icons (<name>.svg, see IconName in Ui.tsx)
├── sidebar-window.html     # shell page of the detached sidebar window
└── yago_logo.png
src/
├── main.tsx                # entry point + app root
├── store.ts                # Zustand app store (shapes, virtual faces, tools, settings)
├── index.css               # Tailwind entry
└── components/
    ├── Geometry.ts         # geometry core: OCC / replicad helpers, faces, sketch frames, leg layout + polygon helpers
    ├── CutWorker.ts        # boolean cuts in a Web Worker (also the shared cut / mesh core) — must stay its own file
    ├── PanelEngine.ts      # panel build engine: fit, cut, joints, decor (holes), rebuild queue
    ├── PanelGroupService.ts# volumes, cavities, quick body, rails
    ├── DoorService.ts      # door groups
    ├── BackService.ts      # back panel groups
    ├── PlinthService.ts    # plinth sets and legs
    ├── AccessoryService.ts # accessory models (mesh files and DWG import), layers, leg assemblies
    ├── ConnectorService.ts # connectors, hole layouts, panel types
    ├── Draft.ts            # 2D drawing core (commands, snaps, constraints) — no React
    ├── Dim.ts              # 3D dimension / measure core (commands, anchors) — no React
    ├── DraftView.tsx       # scene layers of Draft and Dim (DraftLayer, DimLayer) + Drawing panel
    ├── Scene.tsx           # 3D scene: bodies, panels, gizmos, pick overlays
    ├── Ui.tsx              # toolbar, menus, command line, status bar, sidebar shell, icons
    ├── Assembly.tsx        # Assembly sidebar: quick body, panels, doors, backs, plinths
    ├── Accessories.tsx     # Accessories sidebar: models, connectors, layouts
    └── PanelSchematics.tsx # 2D schematics of door / back / joint settings
dwg2stl/                    # Rust source of the DWG → STL converter (npm run build:dwg2stl)
supabase/                   # database migrations and edge functions
```

## Conventions

- Few large files; no needless sub-folders.
- UI text in English; code comments and logs in Turkish. Failure logs use the `[YAGO][TAG]` prefix.
- `tsconfig.app.json` has `noUnusedLocals` / `noUnusedParameters` on: unused code is a compile error.

## License

Proprietary - YAGO Design
