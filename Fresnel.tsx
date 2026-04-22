/**
 * Fresnel — Refractive Glass Component
 * ─────────────────────────────────────
 * A physically-accurate refractive glass effect for any React project.
 * Uses pre-computed displacement maps (Snell's law) fed into an SVG
 * `feDisplacementMap`, applied as a `backdrop-filter`.
 *
 * Chromium-only (Chrome, Edge, Brave, Arc, Opera). Other engines fall
 * back to a plain frosted `backdrop-filter: blur() saturate()`.
 *
 * Based on the method described in:
 *   https://kube.io/blog/liquid-glass-css-svg/
 *   https://github.com/mkj0kjay/vue-web-liquid-glass
 *
 * @license    MIT
 * @copyright  (c) 2026 Tim Maurer
 * @see        https://github.com/tapmaurer-repo/fresnel.js
 */

import {
    CSSProperties,
    ReactNode,
    useCallback,
    useEffect,
    useId,
    useRef,
    useState,
} from "react"

// ═══════════════════════════════════════════════════════════
// SURFACE EQUATIONS
// ═══════════════════════════════════════════════════════════

const CONVEX_SQUIRCLE = (x: number) => Math.pow(1 - Math.pow(1 - x, 4), 1 / 4)
const CONVEX_CIRCLE   = (x: number) => Math.sqrt(1 - (1 - x) ** 2)
const CONCAVE_FN      = (x: number) => 1 - CONVEX_CIRCLE(x)
const LIP_FN = (x: number) => {
    const convex = CONVEX_SQUIRCLE(x * 2)
    const concave = CONCAVE_FN(x) + 0.1
    const s = 6 * x ** 5 - 15 * x ** 4 + 10 * x ** 3
    return convex * (1 - s) + concave * s
}
const SURFACE_FNS: Record<string, (x: number) => number> = {
    convex_squircle: CONVEX_SQUIRCLE,
    convex_circle:   CONVEX_CIRCLE,
    concave:         CONCAVE_FN,
    lip:             LIP_FN,
}

// ═══════════════════════════════════════════════════════════
// SNELL'S LAW LOOKUP
// ═══════════════════════════════════════════════════════════

function precomputeDisplacement(
    glassThickness: number,
    bezelWidth: number,
    fn: (x: number) => number,
    ior: number,
    samples = 128
): number[] {
    const eta = 1 / ior
    function refract(nX: number, nY: number): [number, number] | null {
        const dot = nY
        const k = 1 - eta * eta * (1 - dot * dot)
        if (k < 0) return null
        const ks = Math.sqrt(k)
        return [-(eta * dot + ks) * nX, eta - (eta * dot + ks) * nY]
    }
    return Array.from({ length: samples }, (_, i) => {
        const x = i / samples
        const y = fn(x)
        const dx = x < 1 ? 0.0001 : -0.0001
        const slope = (fn(x + dx) - y) / dx
        const mag = Math.sqrt(slope * slope + 1)
        const n: [number, number] = [-slope / mag, -1 / mag]
        const r = refract(n[0], n[1])
        if (!r) return 0
        const remaining = y * bezelWidth + glassThickness
        return r[0] * (remaining / r[1])
    })
}

// ═══════════════════════════════════════════════════════════
// TRIANGLE SDF HELPERS
// ═══════════════════════════════════════════════════════════

type Vec2 = [number, number]

function triVerts(W: number, H: number): [Vec2, Vec2, Vec2] {
    return [[W / 2, 0], [W, H], [0, H]]
}
function triCentroid(W: number, H: number): Vec2 {
    return [W / 2, (2 * H) / 3]
}
function distToSegOutward(p: Vec2, a: Vec2, b: Vec2, c: Vec2) {
    const sx = b[0] - a[0], sy = b[1] - a[1]
    const px = p[0] - a[0], py = p[1] - a[1]
    const len2 = sx * sx + sy * sy || 1
    const t = Math.max(0, Math.min(1, (px * sx + py * sy) / len2))
    const cx = a[0] + t * sx, cy = a[1] + t * sy
    const dx = p[0] - cx,     dy = p[1] - cy
    const d = Math.sqrt(dx * dx + dy * dy)
    const p1: Vec2 = [-sy, sx], p2: Vec2 = [sy, -sx]
    const toC: Vec2 = [c[0] - cx, c[1] - cy]
    const dot1 = p1[0] * toC[0] + p1[1] * toC[1]
    const out = dot1 < 0 ? p1 : p2
    const omag = Math.sqrt(out[0] * out[0] + out[1] * out[1]) || 1
    return { d, nx: out[0] / omag, ny: out[1] / omag }
}
function nearestTriEdge(px: number, py: number, W: number, H: number) {
    const [A, B, C] = triVerts(W, H)
    const cen = triCentroid(W, H)
    const e1 = distToSegOutward([px, py], A, B, cen)
    const e2 = distToSegOutward([px, py], B, C, cen)
    const e3 = distToSegOutward([px, py], C, A, cen)
    if (e1.d <= e2.d && e1.d <= e3.d) return e1
    if (e2.d <= e3.d) return e2
    return e3
}
function insideTriangle(px: number, py: number, W: number, H: number) {
    const [A, B, C] = triVerts(W, H)
    const sign = (p1: Vec2, p2: Vec2, p3: Vec2) =>
        (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
    const p: Vec2 = [px, py]
    const d1 = sign(p, A, B), d2 = sign(p, B, C), d3 = sign(p, C, A)
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0
    return !(hasNeg && hasPos)
}

// ═══════════════════════════════════════════════════════════
// DISPLACEMENT MAP
// ═══════════════════════════════════════════════════════════

type Shape = "rectangle" | "squircle" | "circle" | "pill" | "triangle"

function buildDisplacementMap(
    W: number, H: number, bezelWidth: number,
    precomp: number[], shape: Shape,
    cornerRadius: number, squircleN: number, dpr: number,
    cornerSoftness: number = 0,
): ImageData {
    const bW = Math.floor(W * dpr), bH = Math.floor(H * dpr)
    const imageData = new ImageData(bW, bH)
    new Uint32Array(imageData.data.buffer).fill(0xff008080)
    const bz = bezelWidth * dpr
    const maxDisp = Math.max(...precomp.map(Math.abs)) || 1

    if (shape === "triangle") {
        const [A, B, C] = triVerts(bW, bH)
        const softRadius = Math.min(bW, bH) * 0.45
        for (let y1 = 0; y1 < bH; y1++) {
            for (let x1 = 0; x1 < bW; x1++) {
                if (!insideTriangle(x1, y1, bW, bH)) continue
                const { d, nx, ny } = nearestTriEdge(x1, y1, bW, bH)
                if (d > bz) continue // inside-non-bezel: already (128,128,0,255) from fill
                const idx = (y1 * bW + x1) * 4
                const bi = Math.min(precomp.length - 1, Math.max(0, ((d / bz) * precomp.length) | 0))
                const dist = precomp[bi] ?? 0

                // Vertex softening: adjacent edges' refraction stacks up near
                // vertices, producing dark focal hotspots. Smoothly attenuate
                // the displacement within softRadius of any vertex.
                let vertexFactor = 1
                if (cornerSoftness > 0) {
                    const dvA = Math.hypot(x1 - A[0], y1 - A[1])
                    const dvB = Math.hypot(x1 - B[0], y1 - B[1])
                    const dvC = Math.hypot(x1 - C[0], y1 - C[1])
                    const dv = Math.min(dvA, dvB, dvC)
                    if (dv < softRadius) {
                        const t = dv / softRadius
                        const smooth = t * t * (3 - 2 * t)
                        vertexFactor = 1 - cornerSoftness * (1 - smooth)
                    }
                }

                const dX = (-nx * dist * vertexFactor) / maxDisp
                const dY = (-ny * dist * vertexFactor) / maxDisp
                imageData.data[idx]     = 128 + dX * 127
                imageData.data[idx + 1] = 128 + dY * 127
                imageData.data[idx + 2] = 0
                imageData.data[idx + 3] = 255
            }
        }
        return imageData
    }

    const maxCR = Math.min(bW, bH) / 2
    let r: number
    switch (shape) {
        case "circle": r = maxCR; break
        case "pill":   r = Math.min(bW, bH) / 2; break
        default:       r = cornerRadius * maxCR; break
    }
    const squircleDist = (x: number, y: number, rad: number, n: number): number => {
        if (rad === 0) return Math.hypot(x, y)
        const aX = Math.abs(x) / rad, aY = Math.abs(y) / rad
        return Math.pow(Math.pow(aX, n) + Math.pow(aY, n), 1 / n) * rad
    }
    for (let y1 = 0; y1 < bH; y1++) {
        for (let x1 = 0; x1 < bW; x1++) {
            const idx = (y1 * bW + x1) * 4
            const isL = x1 < r, isR = x1 >= bW - r
            const isT = y1 < r, isB = y1 >= bH - r
            let distToEdge = 0, nX = 0, nY = 0, inBezel = false
            if ((isL || isR) && (isT || isB)) {
                const x = isL ? x1 - r : x1 - (bW - r)
                const y = isT ? y1 - r : y1 - (bH - r)
                const d = (shape === "squircle" && cornerRadius > 0)
                    ? squircleDist(x, y, r, squircleN)
                    : Math.hypot(x, y)
                distToEdge = r - d
                if (distToEdge >= -1 && distToEdge <= bz) {
                    inBezel = true
                    const m = Math.hypot(x, y) || 1
                    nX = x / m; nY = y / m
                }
            } else if (isL || isR) {
                distToEdge = isL ? x1 : bW - 1 - x1
                if (distToEdge <= bz) { inBezel = true; nX = isL ? -1 : 1; nY = 0 }
            } else if (isT || isB) {
                distToEdge = isT ? y1 : bH - 1 - y1
                if (distToEdge <= bz) { inBezel = true; nX = 0; nY = isT ? -1 : 1 }
            }
            if (inBezel && distToEdge >= 0) {
                const bi = Math.min(precomp.length - 1, Math.max(0, ((distToEdge / bz) * precomp.length) | 0))
                const dist = precomp[bi] ?? 0
                const dX = (-nX * dist) / maxDisp
                const dY = (-nY * dist) / maxDisp
                imageData.data[idx]     = 128 + dX * 127
                imageData.data[idx + 1] = 128 + dY * 127
                imageData.data[idx + 2] = 0
                imageData.data[idx + 3] = 255
            }
        }
    }
    return imageData
}

// ═══════════════════════════════════════════════════════════
// SPECULAR MAP
// ═══════════════════════════════════════════════════════════

function buildSpecularMap(
    W: number, H: number, radius: number, bezelWidth: number,
    shape: Shape, dpr: number, angle = Math.PI / 3
): ImageData {
    const bW = Math.floor(W * dpr), bH = Math.floor(H * dpr)
    const imageData = new ImageData(bW, bH)
    const bz = bezelWidth * dpr
    const sv = [Math.cos(angle), Math.sin(angle)]

    if (shape === "triangle") {
        for (let y1 = 0; y1 < bH; y1++) {
            for (let x1 = 0; x1 < bW; x1++) {
                if (!insideTriangle(x1, y1, bW, bH)) continue
                const { d, nx, ny } = nearestTriEdge(x1, y1, bW, bH)
                if (d <= bz && d >= 0) {
                    const idx = (y1 * bW + x1) * 4
                    const dot = Math.abs(nx * sv[0] + (-ny) * sv[1])
                    // Edge-concentrated falloff: without this, the triangle's
                    // full bezel ribbon lights uniformly at ~3x the effective
                    // area of the rectangle's corner arcs, making
                    // specularSaturation look wildly different per shape.
                    const edgeFalloff = Math.pow(1 - d / bz, 2)
                    const coeff = dot * Math.sqrt(1 - (1 - (bz - d) / bz) ** 2) * edgeFalloff
                    const color = 255 * coeff
                    imageData.data[idx]     = color
                    imageData.data[idx + 1] = color
                    imageData.data[idx + 2] = color
                    imageData.data[idx + 3] = color * coeff
                }
            }
        }
        return imageData
    }

    const r = radius * dpr
    const r2 = r ** 2, rp2 = (r + dpr) ** 2, rmb2 = (r - bz) ** 2
    const wBR = bW - r * 2, hBR = bH - r * 2
    for (let y1 = 0; y1 < bH; y1++) {
        for (let x1 = 0; x1 < bW; x1++) {
            const idx = (y1 * bW + x1) * 4
            const isL = x1 < r, isR = x1 >= bW - r, isT = y1 < r, isB = y1 >= bH - r
            const x = isL ? x1 - r : isR ? x1 - r - wBR : 0
            const y = isT ? y1 - r : isB ? y1 - r - hBR : 0
            const d2 = x * x + y * y
            if (d2 <= rp2 && d2 >= rmb2) {
                const dfc = Math.sqrt(d2), dfs = r - dfc
                const opacity = d2 < r2 ? 1 : 1 - (dfc - Math.sqrt(r2)) / (Math.sqrt(rp2) - Math.sqrt(r2))
                const cos = x / dfc, sin = -y / dfc
                const dot = Math.abs(cos * sv[0] + sin * sv[1])
                const coeff = dot * Math.sqrt(1 - (1 - dfs / dpr) ** 2)
                const color = 255 * coeff
                imageData.data[idx]     = color
                imageData.data[idx + 1] = color
                imageData.data[idx + 2] = color
                imageData.data[idx + 3] = color * coeff * opacity
            }
        }
    }
    return imageData
}

function imageDataToDataURL(imageData: ImageData): string {
    const c = document.createElement("canvas")
    c.width = imageData.width
    c.height = imageData.height
    c.getContext("2d")!.putImageData(imageData, 0, 0)
    return c.toDataURL("image/png")
}

// ═══════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════

export interface FresnelProps {
    /** Shape of the glass. `pill` rounds to half-size; `circle` forces 1:1 radius. */
    shape?: Shape
    /** Normalized corner radius (0–1) for rectangle/squircle shapes. */
    cornerRadius?: number
    /** Superellipse exponent for `squircle`. 4 = Apple squircle. */
    squircleExponent?: number

    /** Surface profile of the bevel. `convex_squircle` is the Apple look. */
    bezelType?: "convex_squircle" | "convex_circle" | "concave" | "lip"
    /** Bezel width in px, measured inward from the edge. */
    bezelWidth?: number
    /** Virtual glass thickness — higher = more light bending. */
    glassThickness?: number
    /** Index of refraction. 1.5 = real glass, 1.9+ = exaggerated. */
    refractiveIndex?: number
    /** Overall displacement multiplier. */
    scaleRatio?: number
    /** Attenuates refraction near triangle vertices, where adjacent edges' bends stack into dark focal hotspots. 0 = off, 1 = full softening. Triangle-only; ignored on other shapes. */
    cornerSoftness?: number

    /** Pre-displacement Gaussian blur. */
    blur?: number
    /** Optional post-displacement frosted blur. */
    frost?: number
    /** Specular highlight opacity (0–1). */
    specularOpacity?: number
    /** Refracted-light color saturation boost. */
    specularSaturation?: number

    /** Background tint color. */
    tintColor?: string
    /** Background tint opacity (0–50%). */
    tintOpacity?: number

    showBorder?: boolean
    borderWidth?: number
    borderColor?: string
    borderOpacity?: number

    showShadow?: boolean
    shadowX?: number
    shadowY?: number
    shadowBlur?: number
    shadowSpread?: number
    shadowColor?: string
    shadowOpacity?: number

    /** Draggable via pointer events. */
    draggable?: boolean

    /** Force the frosted-blur fallback on (for designing the fallback look). */
    simulateFallback?: boolean
    fallbackBlur?: number
    fallbackTintColor?: string
    fallbackTintOpacity?: number
    fallbackSaturation?: number

    /** Children rendered on top of the glass. */
    children?: ReactNode

    /** Extra style applied to the outer element. */
    style?: CSSProperties
    className?: string
}

export default function Fresnel(props: FresnelProps) {
    const {
        shape = "rectangle",
        cornerRadius = 0.15,
        squircleExponent = 4,
        bezelType = "convex_squircle",
        bezelWidth = 12,
        glassThickness = 120,
        refractiveIndex = 1.5,
        scaleRatio = 1,
        cornerSoftness = 0.5,
        blur = 0.25,
        frost = 0,
        specularOpacity = 0.45,
        specularSaturation = 4,
        tintColor = "#ffffff",
        tintOpacity = 4,
        showBorder = true,
        borderWidth = 1.5,
        borderColor = "#cccccc",
        borderOpacity = 35,
        showShadow = true,
        shadowX = 0,
        shadowY = 8,
        shadowBlur = 32,
        shadowSpread = 0,
        shadowColor = "#000000",
        shadowOpacity = 30,
        draggable = false,
        simulateFallback = false,
        fallbackBlur = 12,
        fallbackTintColor = "#ffffff",
        fallbackTintOpacity = 10,
        fallbackSaturation = 120,
        children,
        style,
        className,
    } = props

    const reactId = useId()
    const filterId = `fresnel-${reactId.replace(/:/g, "-")}`
    const TRI_CLIP = "polygon(50% 0%, 100% 100%, 0% 100%)"

    // Chromium detection
    const [isChromium, setIsChromium] = useState(true)
    useEffect(() => {
        if (typeof window === "undefined") return
        setIsChromium(/Chrome\//.test(navigator.userAgent) || /CriOS\//.test(navigator.userAgent))
    }, [])
    const useFallback = simulateFallback || !isChromium

    // Measure actual rendered size
    const hostRef = useRef<HTMLDivElement>(null)
    const [size, setSize] = useState<[number, number]>([0, 0])
    useEffect(() => {
        const el = hostRef.current
        if (!el) return
        let lw = 0, lh = 0
        const update = () => {
            const rect = el.getBoundingClientRect()
            const w = Math.round(rect.width), h = Math.round(rect.height)
            if (w !== lw || h !== lh) {
                lw = w; lh = h
                if (w > 4 && h > 4) setSize([w, h])
            }
        }
        update()
        const ro = new ResizeObserver(update)
        ro.observe(el)
        return () => ro.disconnect()
    }, [])

    const [W, H] = size
    const ready = W > 4 && H > 4
    const quality = 2

    // Drag
    const [drag, setDrag] = useState({ x: 0, y: 0 })
    const dragRef = useRef({ active: false, sx: 0, sy: 0, ox: 0, oy: 0 })
    const onPointerDown = useCallback((e: React.PointerEvent) => {
        if (!draggable) return
        dragRef.current = { active: true, sx: e.clientX, sy: e.clientY, ox: drag.x, oy: drag.y }
        ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
        e.preventDefault()
    }, [draggable, drag])
    const onPointerMove = useCallback((e: React.PointerEvent) => {
        if (!dragRef.current.active) return
        setDrag({
            x: dragRef.current.ox + e.clientX - dragRef.current.sx,
            y: dragRef.current.oy + e.clientY - dragRef.current.sy,
        })
    }, [])
    const onPointerUp = useCallback(() => { dragRef.current.active = false }, [])

    // Generate maps
    const [maps, setMaps] = useState<{ dispUrl: string; specUrl: string; maxDisp: number } | null>(null)
    useEffect(() => {
        if (!ready || useFallback) return
        try {
            const surfaceFn = SURFACE_FNS[bezelType] || CONVEX_SQUIRCLE
            const precomp = precomputeDisplacement(glassThickness, bezelWidth, surfaceFn, refractiveIndex, 128)
            const md = Math.max(...precomp.map((v) => Math.abs(v))) || 1
            const effRad = shape === "circle" ? Math.min(W, H) / 2
                : shape === "pill" ? Math.min(W, H) / 2
                : shape === "triangle" ? 0
                : cornerRadius * Math.min(W, H) / 2
            const dispMap = buildDisplacementMap(W, H, bezelWidth, precomp, shape, cornerRadius, squircleExponent, quality, cornerSoftness)
            const specMap = buildSpecularMap(W, H, effRad, bezelWidth, shape, quality)
            setMaps({
                dispUrl: imageDataToDataURL(dispMap),
                specUrl: imageDataToDataURL(specMap),
                maxDisp: md,
            })
        } catch (e) {
            console.warn("[Fresnel] Map generation failed:", e)
        }
    }, [bezelType, bezelWidth, glassThickness, refractiveIndex, W, H, shape, cornerRadius, squircleExponent, cornerSoftness, ready, useFallback])

    const scale = maps ? maps.maxDisp * scaleRatio : 0

    // Shape styling — applied directly to the glass element so no ancestor
    // creates a backdrop-root (which would break backdrop-filter).
    const tintBg = tintOpacity > 0
        ? `${tintColor}${Math.round((tintOpacity / 100) * 255).toString(16).padStart(2, "0")}`
        : "transparent"
    const borderStyle = showBorder
        ? `${borderWidth}px solid ${borderColor}${Math.round((borderOpacity / 100) * 255).toString(16).padStart(2, "0")}`
        : "none"
    const shadowHex = `${shadowColor}${Math.round((shadowOpacity / 100) * 255).toString(16).padStart(2, "0")}`
    const shadowStyle = showShadow
        ? `${shadowX}px ${shadowY}px ${shadowBlur}px ${shadowSpread}px ${shadowHex}`
        : "none"

    const isTriangle = shape === "triangle"
    const cssBorderRadius =
        shape === "circle" ? "50%"
        : shape === "pill" ? `${Math.min(W || 9999, H || 9999) / 2}px`
        : `${cornerRadius * Math.min(W || 9999, H || 9999) / 2}px`

    const outerStyle: CSSProperties = {
        position: "relative",
        width: "100%",
        height: "100%",
        transform: draggable ? `translate(${drag.x}px, ${drag.y}px)` : undefined,
        cursor: draggable ? "grab" : undefined,
        touchAction: draggable ? "none" : undefined,
        ...style,
    }

    // Shared glass layer style
    const glassStyle: CSSProperties = isTriangle
        ? {
              position: "absolute",
              inset: 0,
              clipPath: TRI_CLIP,
              WebkitClipPath: TRI_CLIP,
              background: tintBg,
              border: borderStyle,
          }
        : {
              position: "absolute",
              inset: 0,
              borderRadius: cssBorderRadius,
              boxShadow: shadowStyle,
              background: tintBg,
              border: borderStyle,
          }

    return (
        <div
            ref={hostRef}
            className={className}
            style={outerStyle}
            onPointerDown={draggable ? onPointerDown : undefined}
            onPointerMove={draggable ? onPointerMove : undefined}
            onPointerUp={draggable ? onPointerUp : undefined}
        >
            {/* Triangle shadow plate (box-shadow would be clipped by clip-path) */}
            {isTriangle && showShadow && (
                <div
                    style={{
                        position: "absolute",
                        inset: 0,
                        clipPath: TRI_CLIP,
                        WebkitClipPath: TRI_CLIP,
                        background: shadowColor,
                        opacity: shadowOpacity / 100,
                        filter: `blur(${Math.max(6, shadowBlur / 2)}px)`,
                        transform: `translate(${shadowX}px, ${Math.max(4, shadowY)}px)`,
                        pointerEvents: "none",
                    }}
                />
            )}

            {/* Chromium path */}
            {!useFallback && maps && (
                <>
                    <svg
                        style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }}
                        colorInterpolationFilters="sRGB"
                    >
                        <defs>
                            <filter id={filterId}>
                                <feGaussianBlur in="SourceGraphic" stdDeviation={blur} result="blurred" />
                                <feImage href={maps.dispUrl} x="0" y="0" width={W} height={H} result="dmap" />
                                <feDisplacementMap
                                    in="blurred"
                                    in2="dmap"
                                    scale={scale}
                                    xChannelSelector="R"
                                    yChannelSelector="G"
                                    result="disp"
                                />
                                <feColorMatrix
                                    in="disp"
                                    type="saturate"
                                    values={specularSaturation.toString()}
                                    result="dispSat"
                                />
                                <feImage href={maps.specUrl} x="0" y="0" width={W} height={H} result="spec" />
                                <feComposite in="dispSat" in2="spec" operator="in" result="specSat" />
                                <feComponentTransfer in="spec" result="specFaded">
                                    <feFuncA type="linear" slope={specularOpacity.toString()} />
                                </feComponentTransfer>
                                <feBlend in="specSat" in2="disp" mode="normal" result="withSat" />
                                <feBlend in="specFaded" in2="withSat" mode="normal" />
                            </filter>
                        </defs>
                    </svg>
                    <div
                        style={{
                            ...glassStyle,
                            backdropFilter: `url(#${filterId})`,
                            WebkitBackdropFilter: `url(#${filterId})`,
                        }}
                    />
                    {frost > 0 && (
                        <div
                            style={{
                                ...glassStyle,
                                background: "transparent",
                                border: "none",
                                backdropFilter: `blur(${frost}px)`,
                                WebkitBackdropFilter: `blur(${frost}px)`,
                                pointerEvents: "none",
                            }}
                        />
                    )}
                </>
            )}

            {/* Fallback (Safari, Firefox) */}
            {useFallback && (
                <div
                    style={{
                        ...glassStyle,
                        backdropFilter: `blur(${fallbackBlur}px) saturate(${fallbackSaturation}%)`,
                        WebkitBackdropFilter: `blur(${fallbackBlur}px) saturate(${fallbackSaturation}%)`,
                        background:
                            fallbackTintOpacity > 0
                                ? `${fallbackTintColor}${Math.round((fallbackTintOpacity / 100) * 255).toString(16).padStart(2, "0")}`
                                : "transparent",
                    }}
                />
            )}

            {/* Content */}
            {children && (
                <div
                    style={{
                        position: "absolute",
                        inset: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        pointerEvents: "none",
                        zIndex: 1,
                    }}
                >
                    {children}
                </div>
            )}
        </div>
    )
}
