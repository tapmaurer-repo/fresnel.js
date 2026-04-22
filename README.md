# fresnel.js

A physically-accurate refractive glass component for the web. Per-pixel Snell's law via SVG displacement maps, applied as `backdrop-filter`. **Not a blur.**

![Chromium only](https://img.shields.io/badge/engine-Chromium-blue)
![React](https://img.shields.io/badge/React-18%2B-61dafb)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6)
![License](https://img.shields.io/badge/license-MIT-green)

**→ Live demo: [fresnel-js.timothymaurer.nl](https://fresnel-js.timothymaurer.nl)**

Named after [Augustin-Jean Fresnel](https://en.wikipedia.org/wiki/Augustin-Jean_Fresnel), the French physicist who figured out how light actually bends through curved surfaces — which is the math this component runs on every pixel of the bevel.

Made by [Tim Maurer](https://timothymaurer.nl).

---

## Why this exists

Most "glass" CSS you find online is `backdrop-filter: blur() saturate()`. That's **frosted** glass — a uniform blur. The refractive glass you see on Apple's iOS 26 lock screen, on high-end product pages, and in optical diagrams is something different: a **curved piece of glass** sitting over content, where the bezel bends light through Snell's law. The middle is almost clear; the edges distort what's behind them; a specular highlight streaks the rim.

You can't fake that with a blur. It needs a per-pixel displacement field derived from the physics of the bevel geometry. That's what Fresnel does.

---

## Features

- **Four bevel profiles** — `convex_squircle` (the Apple look), `convex_circle`, `concave`, `lip`
- **Five shapes** — `rectangle`, `squircle`, `circle`, `pill`, `triangle` (proper SDF, not a clip-path hack)
- **Real refraction** — Snell's law per-pixel at the bevel, pre-computed into an RGBA displacement map
- **Specular highlight** — separate overlay computed from bevel normal × light vector
- **Vertex softening for triangles** — configurable smoothing where edges converge, so pointed shapes don't pool into dark focal hotspots
- **Draggable** — optional, with pointer capture and click-vs-drag detection
- **Safari/Firefox fallback** — degrades cleanly to a frosted `backdrop-filter` when the engine can't do SVG filters on backdrops
- **Zero runtime dependencies** — just React
- **TypeScript-first** — fully typed

---

## Lineage

Fresnel stands on two predecessors — credit where it's due.

**[Chris Feijoo's kube.io article][kube]** is the source of the *technique itself*. The insight that you can pre-compute Snell's-law refraction into an RGBA displacement map and feed it to an SVG `<feDisplacementMap>` as a `backdrop-filter` — that invention lives in that article. Every implementation of curved-bevel web glass you'll find traces back there, and this one is no exception. If you want to understand how this all works under the hood, that's the article to read.

**[`mkj0kjay/vue-web-liquid-glass`][vue-repo]** was the first public implementation of the technique as a reusable component. Our physics engine — the four surface equations, the Snell's-law lookup table, the bezel-zone iteration with corner/edge branching for rounded rectangles — is functionally the same, because there's essentially one correct way to implement the article. Porting this to a new framework doesn't change the math.

What Fresnel adds on top of that foundation:

- **React + TypeScript port.** The upstream ships as a Vue 3 single-file component. Fresnel is a clean standalone React component with full type definitions, exported as a default — drop it into any React codebase from React 18 upward and it works. For the React ecosystem this is the first drop-in option using the kube.io method; previously you had to either rewrite it yourself or reach for WebGL-shader-based alternatives that solve a different problem.

- **Triangle shape with proper SDF refraction.** The upstream supports rectangle, circle, pill, and squircle. Triangles aren't a "change the corner radius" case — there's no corner radius concept, the bevel has to track three edges with outward-pointing normals, and a point-in-triangle test replaces the corner-quadrant logic. That's ~80 lines of genuinely new physics code (`triVerts`, `nearestTriangleEdge`, `insideTriangle`, the centroid-sign trick for outward normals), not a port. And because three-edge convergence creates dark focal hotspots at the vertices (refraction vectors from adjacent edges stacking), there's a `cornerSoftness` parameter with a smootherstep falloff that attenuates displacement near each vertex — plus a matching squared edge-falloff on the specular map so highlights stay proportional to the rectangle's. If you have a use case for triangular glass — icons with directional emphasis, prism-like flourishes, pointed UI elements — this is the only implementation that does it with real refraction rather than clip-path fakery.

- **Interactive demo playground.** Click any shape in [the live demo](https://fresnel-js.timothymaurer.nl) to open a settings panel with sliders for every parameter, tweak until it looks right, then hit **Generate code** to get a ready-to-paste `<Fresnel />` JSX snippet with your exact values. Shapes are draggable so you can see how the refraction tracks against varied content. Backgrounds cycle across hand-picked photos. The upstream has a basic demo page; this is a full tuning environment and doubles as the integration handoff for anyone using the component.

- **Integration gotcha docs.** The [backdrop-root ancestors](#-integration-gotcha-backdrop-root-ancestors) section below documents the single most common reason this effect silently breaks when dropped into an existing codebase — a parent component somewhere up the tree has `filter`, `clip-path`, or `opacity < 1` and the glass goes blank. Not covered anywhere else, painful to rediscover.

Short version: same physics engine, new component surface, one extra shape that required new physics, and a tuning environment built around it. MIT license upstream and downstream, lineage acknowledged, no confusion about who did what.

[kube]: https://kube.io/blog/liquid-glass-css-svg/
[vue-repo]: https://github.com/mkj0kjay/vue-web-liquid-glass

---

## Install

Copy [`Fresnel.tsx`](./Fresnel.tsx) into your project. That's the whole install.

```tsx
import Fresnel from "./Fresnel"

<div style={{ width: 300, height: 300 }}>
  <Fresnel
    shape="rectangle"
    cornerRadius={0.08}
    bezelType="convex_squircle"
    bezelWidth={12}
    glassThickness={120}
    refractiveIndex={1.5}
  />
</div>
```

The component sizes to `100% / 100%` of its parent — always wrap it in a sized container.

### The demo is standalone

[`index.html`](./index.html) is a single HTML file with the entire physics engine ported to vanilla JS. No build, no React, no bundler. Open it in Chrome and it works. Use it as a reference implementation or as a sandbox for tuning values before committing them to your React project — the **Generate code** button on each shape's settings panel emits a ready-to-paste `<Fresnel />` JSX snippet with your current values.

---

## Property reference

### Shape

| Prop                | Type                                                             | Default       | Notes                                                        |
| ------------------- | ---------------------------------------------------------------- | ------------- | ------------------------------------------------------------ |
| `shape`             | `"rectangle" \| "squircle" \| "circle" \| "pill" \| "triangle"`  | `"rectangle"` | `pill` forces half-size radius; `circle` forces 1:1          |
| `cornerRadius`      | `number`                                                         | `0.15`        | Normalized 0–1, only for `rectangle` and `squircle`          |
| `squircleExponent`  | `number`                                                         | `4`           | Superellipse exponent. `4` is Apple squircle                 |

### Bevel (the glass itself)

| Prop                | Type                                                          | Default             | Notes                                                                 |
| ------------------- | ------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------- |
| `bezelType`         | `"convex_squircle" \| "convex_circle" \| "concave" \| "lip"`  | `"convex_squircle"` | Surface profile of the bevel                                          |
| `bezelWidth`        | `number`                                                      | `12`                | Bezel width in px, measured inward                                    |
| `glassThickness`    | `number`                                                      | `120`               | Virtual thickness — higher = more bending                             |
| `refractiveIndex`   | `number`                                                      | `1.5`               | 1.5 = real glass, 1.9+ = exaggerated diamond                          |
| `scaleRatio`        | `number`                                                      | `1`                 | Overall displacement multiplier                                       |
| `cornerSoftness`    | `number`                                                      | `0.5`               | Attenuates refraction near triangle vertices. Triangle-only; 0–1      |

### Surface

| Prop                 | Type     | Default | Notes                                       |
| -------------------- | -------- | ------- | ------------------------------------------- |
| `blur`               | `number` | `0.25`  | Gaussian blur before displacement           |
| `frost`              | `number` | `0`     | Optional post-displacement blur layer       |
| `specularOpacity`    | `number` | `0.45`  | Highlight opacity (0–1)                     |
| `specularSaturation` | `number` | `4`     | Saturation boost for refracted light        |

### Tint / Border / Shadow

| Prop                    | Type      | Default       |
| ----------------------- | --------- | ------------- |
| `tintColor`             | `string`  | `"#ffffff"`   |
| `tintOpacity`           | `number`  | `4` (0–50)    |
| `showBorder`            | `boolean` | `true`        |
| `borderWidth`           | `number`  | `1.5`         |
| `borderColor`           | `string`  | `"#cccccc"`   |
| `borderOpacity`         | `number`  | `35` (0–100)  |
| `showShadow`            | `boolean` | `true`        |
| `shadowX/Y/Blur/Spread` | `number`  | `0, 8, 32, 0` |
| `shadowColor`           | `string`  | `"#000000"`   |
| `shadowOpacity`         | `number`  | `30` (0–100)  |

### Interaction

| Prop        | Type      | Default | Notes                                   |
| ----------- | --------- | ------- | --------------------------------------- |
| `draggable` | `boolean` | `false` | Enables pointer-drag with pointer capture |

### Fallback (non-Chromium engines)

| Prop                  | Type      | Default     |
| --------------------- | --------- | ----------- |
| `simulateFallback`    | `boolean` | `false`     |
| `fallbackBlur`        | `number`  | `12`        |
| `fallbackTintColor`   | `string`  | `"#ffffff"` |
| `fallbackTintOpacity` | `number`  | `10`        |
| `fallbackSaturation`  | `number`  | `120`       |

---

## How it works

Three things combine to produce the effect:

**1. Bevel geometry as a function.** Each profile is a pure function `y = f(x)` mapping distance from the outer edge (0) to the inner edge (1) to a height. `convex_squircle`, the default, is `(1 − (1 − x)⁴)^(1/4)` — the Apple squircle curve.

**2. Snell's law, pre-computed.** For 128 sampled positions across the bevel, we calculate the surface normal, refract a vertical ray at `1/IOR`, and record how far it ends up laterally after traveling through `bezelWidth × f(x) + glassThickness` of glass. This gives a 1D lookup table of pixel displacements.

**3. A displacement map.** For each pixel inside the shape, we find its distance to the nearest edge, look up the corresponding displacement from step 2, encode the X/Y offsets as RGB (with `128` as zero), and bake it into a PNG. For rounded shapes this uses the classic rect-with-rounded-corners logic. For triangles it uses a proper SDF with three edge distances and outward-pointing normals, plus a smootherstep `cornerSoftness` falloff near each vertex to prevent the dark focal hotspots that appear where adjacent edges' refraction vectors stack. An SVG `<feDisplacementMap>` reads the map and bends the backdrop accordingly, and a separate specular overlay (computed from `dot(bevelNormal, lightVector)`) adds the highlight.

---

## Browser support

Refraction path requires SVG `backdrop-filter`, which today means Chromium only — Chrome, Edge, Brave, Arc, Opera. Safari and Firefox fall back to a regular frosted `backdrop-filter: blur() saturate()`, tunable via the `fallback*` props. The component auto-detects the engine and switches at mount; set `simulateFallback={true}` during development to preview the fallback look on Chrome.

---

## ⚠️ Integration gotcha: backdrop-root ancestors

This is the #1 thing that silently breaks the effect when you drop it into an existing codebase.

**`backdrop-filter` sees only the content within the nearest *backdrop-root* ancestor.** Any ancestor of the glass element with any of these properties becomes a backdrop-root:

- `filter` (including `filter: drop-shadow(...)`, `filter: brightness(...)`)
- `clip-path`
- `opacity` less than `1`
- `mask` / `mask-image`
- `mix-blend-mode` other than `normal`
- `isolation: isolate`

If any parent up the tree has one of these, your glass will look empty (it's refracting nothing — there's no content "behind" it from its perspective). **`transform` is NOT in this list** — it's safe.

Fresnel sidesteps this internally by applying `border-radius`, `clip-path`, and `box-shadow` all directly on the glass element. But your parent components can still break it. If the effect looks dead, check your ancestors.

---

## Credits

See [Lineage](#lineage) above for the full story. Short list:

- [Chris Feijoo — *The SVG `<filter>` behind Apple's Liquid Glass*][kube] — the technique
- [`mkj0kjay/vue-web-liquid-glass`][vue-repo] — Vue 3 implementation this was ported from

---

## License

[MIT](./LICENSE). Use it, ship it, modify it.

If this saved you time and you'd like to say thanks, [a coffee goes a long way](https://www.paypal.com/paypalme/tapmaurer) ☕. Not required — a backlink to [timothymaurer.nl](https://timothymaurer.nl) is equally appreciated.
