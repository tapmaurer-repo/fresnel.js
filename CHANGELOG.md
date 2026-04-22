# Changelog

All notable changes to **fresnel.js** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project loosely follows [Semantic Versioning](https://semver.org/) — though while the API is still `beta` it may shift without a major-version bump.

---

## [0.2.0-beta] — 2026-04-23

### Added

- **Triangle shape** via a three-edge SDF. New `cornerSoftness` prop (default `0.5`) applies a smootherstep attenuation within 45% of `min(width, height)` around each vertex, preventing the dark focal hotspots where adjacent edges' refraction vectors would otherwise stack. The triangle specular branch uses a squared edge-falloff so highlight intensity tracks the rectangle's corner-arc intensity per unit of `specularSaturation`.
- **Framer code component** at `framer/fresnel-framer-js.tsx` — the same physics wrapped with property controls for every prop. Includes a `simulateFallback` toggle to preview the Safari/Firefox path directly in the Framer editor.
- **Info and Framer modals** in the standalone demo (`index.html`). The info modal covers the backdrop-root ancestor gotcha and makes the React-component-not-CSS-class distinction explicit. The Framer modal walks through code-component setup and the `Content` property for children, linking back to the file on GitHub.
- **Roadmap section** in the README: `FresnelText` (per-glyph SDF typography), custom SVG path shapes, anisotropic specular, per-edge bezel profiles.

### Fixed

- **Rect/circle displacement map initialization.** The shape-aware `buildDisplacementMap` now fills the entire buffer with neutral gray (`128, 128, 0, 255`) via `Uint32Array.fill(0xff008080)` before the per-shape branch writes bezel pixels. Transparent interior pixels caused `feDisplacementMap` to read `RGB=(0,0,0)` and apply a constant negative offset across the shape interior — this was the bug that broke rectangle and circle refraction in the standalone demo.
- **Triangle shadow.** Routed through `filter: drop-shadow()` applied to the glass element itself. `drop-shadow` reads the element's clipped silhouette, so the shadow is triangle-shaped rather than a rectangular bounding-box shadow. `filter` on the same element as `backdrop-filter` does *not* create a backdrop-root for that element's own backdrop — only for descendants — so the two coexist.
- **Framer F button styling.** The new button was overriding the shared header-button selector with a near-transparent background that let the page content bleed through. Folded into the existing `.refresh-btn, .github-btn, .coffee-btn, .info-btn` ruleset so all header buttons share one source of truth.
- **Brand chip vertical alignment.** Swapped asymmetric padding-based centering (`8px 14px 7px`) — which had been eyeballed against Silkscreen's off-center glyph metrics — for flex centering inside a fixed 32px box. The chip now lines up with the button row on a single horizontal centerline regardless of font rendering.

### Changed

- `bezelWidth` default lowered from `36` to `12`. The old default was tuned for a very thick slab look; the new one reads as glass at typical UI sizes without having to override every instantiation.
- New `DEFAULTS.square` values in the standalone demo: `cornerRadius: 0.22`, `bezelWidth: 37`, `glassThickness: 290`, `refractiveIndex: 1.55`, `scaleRatio: 1.05`, `blur: 0.2`, `specularOpacity: 0.54`, `specularSaturation: 7.5`. These are HTML-demo defaults only — the React component's own defaults remain conservative.

---

## [0.1.0-beta] — initial release

- Core React component (`Fresnel.tsx`) with four bevel profiles: `convex_squircle`, `convex_circle`, `concave`, `lip`
- Four shapes at first release: `rectangle`, `squircle`, `circle`, `pill`
- Per-pixel refraction via Snell's law, precomputed into an RGBA displacement map and applied through `feDisplacementMap` as a `backdrop-filter`
- Specular highlight layer computed from bevel normal against a light vector
- Safari / Firefox CSS-only frosted-glass fallback (`backdrop-filter: blur() saturate()`) for engines that don't support SVG filters on backdrops
- Standalone HTML demo with the physics ported to vanilla JS, a live parameter-tuning panel, and a Generate-code button that emits ready-to-paste `<Fresnel />` JSX
- Optional `draggable` prop with pointer capture and click-vs-drag detection
- Zero runtime dependencies beyond React

[0.2.0-beta]: https://github.com/tapmaurer-repo/fresnel.js/releases/tag/v0.2.0-beta
[0.1.0-beta]: https://github.com/tapmaurer-repo/fresnel.js/releases/tag/v0.1.0-beta
