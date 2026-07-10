// CRA resolves absolute modules from src but does not honor the "@/..." path
// mapping. Keep the frozen import contract working without rewriting tab lanes.
export * from '../../../shared/components/DetailSidebar';
