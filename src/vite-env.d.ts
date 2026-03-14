/// <reference types="vite/client" />

declare module 'opencascade.js' {
  export function initOpenCascade(): Promise<any>;
}

interface Window {
  opencascadeLoaded?: boolean;
}

export type OpenCascadeInstance = any;
export type TopoDS_Shape = any;
