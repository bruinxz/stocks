# Frontend Layout Primitives

This directory holds **layout-only** shared components — chrome, not features.

## Current contents

- `WorkspaceLayout.tsx` — the shared shell used by all 6 workspaces in `pages/workspace/`. Renders a 96px KPI bar on top and an optional 220px left tab rail. See `pages/workspace/CLAUDE.md` for the props contract and slot conventions.

## When to add a file here

Add a file in this directory only when:

- It's a layout primitive (header / sider / shell / grid wrapper), not a domain feature.
- It will be reused by **two or more** pages — one-off shells belong inside the page file.
- It has no data fetching of its own — layouts should accept slots/children, never call services.

If you find yourself importing from `services/` here, you're in the wrong directory; move the component into the page or a feature directory under `components/`.

## Class naming

CSS for these components lives at the bottom of `frontend/src/index.css` under a banner that names the originating story (e.g. `Workspace shell (US-002)`). Use the BEM-ish `.workspace-kpi-bar__inner` style so dev-tools searches find the rules quickly.
