// Fresnel.js for Framer — Code Component
// v0.2.0-beta
// Port of vue-web-liquid-glass (mkj0kjay) + triangle SDF extension
// Based on kube.io/blog/liquid-glass-css-svg/
// Chrome-only (SVG backdrop-filter); clean frosted-glass fallback for other engines
// Made by Tim Maurer — https://github.com/tapmaurer-repo/fresnel.js

import { addPropertyControls, ControlType } from "framer"
import { useRef, useState, useCallback, useEffect, useId } from "react"

// ═══════════════════════════════════════════════════════════
// 1. SURFACE EQUATIONS
// ═══════════════════════════════════════════════════════════

const CONVEX_SQUIRCLE = (x: number) => Math.pow(1 - Math.pow(1 - x, 4), 1 / 4)
const CONVEX_CIRCLE = (x: number) => Math.sqrt(1 - (1 - x) ** 2)
const CONCAVE_FN = (x: number) => 1 - CONVEX_CIRCLE(x)
const LIP_FN = (x: number) => {
    const convex = CONVEX_SQUIRCLE(x * 2)
    const concave = CONCAVE_FN(x) + 0.1
    const smootherstep = 6 * x ** 5 - 15 * x ** 4 + 10 * x ** 3
    return convex * (1 - smootherstep) + concave * smootherstep
}
const SURFACE_FNS: Record<string, (x: number) => number> = {
    convex_squircle: CONVEX_SQUIRCLE,
    convex_circle: CONVEX_CIRCLE,
    concave: CONCAVE_FN,
    lip: LIP_FN,
}

// ═══════════════════════════════════════════════════════════
// 2. DISPLACEMENT MAP — Snell's law precomputation
// ═══════════════════════════════════════════════════════════

function calculateDisplacementMap(
    glassThickness: number,
    bezelWidth: number,
    bezelHeightFn: (x: number) => number,
    refractiveIndex: number,
    samples: number = 128
): number[] {
    const eta = 1 / refractiveIndex
    function refract(nX: number, nY: number): [number, number] | null {
        const dot = nY
        const k = 1 - eta * eta * (1 - dot * dot)
        if (k < 0) return null
        const kSqrt = Math.sqrt(k)
        return [-(eta * dot + kSqrt) * nX, eta - (eta * dot + kSqrt) * nY]
    }
    return Array.from({ length: samples }, (_, i) => {
        const x = i / samples
        const y = bezelHeightFn(x)
        const dx = x < 1 ? 0.0001 : -0.0001
        const y2 = bezelHeightFn(x + dx)
        const derivative = (y2 - y) / dx
        const magnitude = Math.sqrt(derivative * derivative + 1)
        const normal: [number, number] = [
            -derivative / magnitude,
            -1 / magnitude,
        ]
        const refracted = refract(normal[0], normal[1])
        if (!refracted) return 0
        const remainingHeight = y * bezelWidth + glassThickness
        return refracted[0] * (remainingHeight / refracted[1])
    })
}

// ═══════════════════════════════════════════════════════════
// TRIANGLE SDF HELPERS — for shape === "triangle"
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
    const dx = p[0] - cx, dy = p[1] - cy
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
// 3a. DISPLACEMENT MAP 2D — circle-based
// ═══════════════════════════════════════════════════════════

function calculateDisplacementMap2(
    canvasW: number,
    canvasH: number,
    objW: number,
    objH: number,
    radius: number,
    bezelWidth: number,
    maxDisp: number,
    precomputed: number[],
    dpr: number = 1
): ImageData {
    const bW = Math.floor(canvasW * dpr),
        bH = Math.floor(canvasH * dpr)
    const imageData = new ImageData(bW, bH)
    new Uint32Array(imageData.data.buffer).fill(0xff008080)
    const r = radius * dpr,
        bz = bezelWidth * dpr
    const r2 = r ** 2,
        rp2 = (r + 1) ** 2,
        rmb2 = (r - bz) ** 2
    const oW = objW * dpr,
        oH = objH * dpr
    const wBR = oW - r * 2,
        hBR = oH - r * 2
    const oX = (bW - oW) / 2,
        oY = (bH - oH) / 2
    for (let y1 = 0; y1 < oH; y1++) {
        for (let x1 = 0; x1 < oW; x1++) {
            const idx = ((oY + y1) * bW + oX + x1) * 4
            const isL = x1 < r,
                isR = x1 >= oW - r,
                isT = y1 < r,
                isB = y1 >= oH - r
            const x = isL ? x1 - r : isR ? x1 - r - wBR : 0
            const y = isT ? y1 - r : isB ? y1 - r - hBR : 0
            const d2 = x * x + y * y
            if (d2 <= rp2 && d2 >= rmb2) {
                const opacity =
                    d2 < r2
                        ? 1
                        : 1 -
                          (Math.sqrt(d2) - Math.sqrt(r2)) /
                              (Math.sqrt(rp2) - Math.sqrt(r2))
                const dfc = Math.sqrt(d2),
                    dfs = r - dfc
                const cos = x / dfc,
                    sin = y / dfc
                const bi = ((dfs / bz) * precomputed.length) | 0
                const dist = precomputed[bi] ?? 0
                const dX = (-cos * dist) / maxDisp,
                    dY = (-sin * dist) / maxDisp
                imageData.data[idx] = 128 + dX * 127 * opacity
                imageData.data[idx + 1] = 128 + dY * 127 * opacity
                imageData.data[idx + 2] = 0
                imageData.data[idx + 3] = 255
            }
        }
    }
    return imageData
}

// ═══════════════════════════════════════════════════════════
// 3b. DISPLACEMENT MAP 2D — shape-aware (rectangle/squircle/pill/triangle)
// ═══════════════════════════════════════════════════════════

type ShapeType = "circle" | "squircle" | "rectangle" | "pill" | "triangle"

function calculateDisplacementMapWithShape(
    canvasW: number,
    canvasH: number,
    objW: number,
    objH: number,
    bezelWidth: number,
    maxDisp: number,
    precomputed: number[],
    shape: ShapeType = "circle",
    cornerRadius: number = 1.0,
    squircleExponent: number = 4,
    dpr: number = 1,
    cornerSoftness: number = 0
): ImageData {
    const bW = Math.floor(canvasW * dpr),
        bH = Math.floor(canvasH * dpr)
    const imageData = new ImageData(bW, bH)
    new Uint32Array(imageData.data.buffer).fill(0xff008080)
    const oW = objW * dpr,
        oH = objH * dpr,
        bz = bezelWidth * dpr
    const oX = (bW - oW) / 2,
        oY = (bH - oH) / 2

    // ─── Triangle branch ───
    // Three-edge SDF. The cornerSoftness smootherstep attenuates refraction
    // near each vertex — without it, adjacent edges' refraction vectors stack
    // and produce dark focal hotspots at the three points.
    if (shape === "triangle") {
        const [A, B, C] = triVerts(oW, oH)
        const softRadius = Math.min(oW, oH) * 0.45
        for (let y1 = 0; y1 < oH; y1++) {
            for (let x1 = 0; x1 < oW; x1++) {
                if (!insideTriangle(x1, y1, oW, oH)) continue
                const { d, nx, ny } = nearestTriEdge(x1, y1, oW, oH)
                if (d > bz) continue // inside-non-bezel: already neutral from fill
                const idx = ((oY + y1) * bW + oX + x1) * 4
                const bi = Math.min(
                    precomputed.length - 1,
                    Math.max(0, ((d / bz) * precomputed.length) | 0)
                )
                const dist = precomputed[bi] ?? 0

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
                imageData.data[idx] = 128 + dX * 127
                imageData.data[idx + 1] = 128 + dY * 127
                imageData.data[idx + 2] = 0
                imageData.data[idx + 3] = 255
            }
        }
        return imageData
    }

    // ─── Rectangle / squircle / pill branch ───
    const maxCR = Math.min(oW, oH) / 2
    let actualRadius: number
    switch (shape) {
        case "circle":
            actualRadius = maxCR
            break
        case "pill":
            actualRadius = Math.min(oW, oH) / 2
            break
        case "rectangle":
            actualRadius = cornerRadius * maxCR
            break
        case "squircle":
        default:
            actualRadius = cornerRadius * maxCR
            break
    }
    const r = actualRadius,
        r2 = r ** 2,
        rp2 = (r + 1) ** 2
    const rmb2 = Math.max(0, (r - bz) ** 2)
    const wBR = Math.max(0, oW - r * 2),
        hBR = Math.max(0, oH - r * 2)
    const squircleDistance = (
        x: number,
        y: number,
        rad: number,
        n: number
    ): number => {
        if (rad === 0) return Math.sqrt(x * x + y * y)
        const aX = Math.abs(x) / rad,
            aY = Math.abs(y) / rad
        return Math.pow(Math.pow(aX, n) + Math.pow(aY, n), 1 / n) * rad
    }
    for (let y1 = 0; y1 < oH; y1++) {
        for (let x1 = 0; x1 < oW; x1++) {
            const idx = ((oY + y1) * bW + oX + x1) * 4
            const isL = x1 < r,
                isR = x1 >= oW - r,
                isT = y1 < r,
                isB = y1 >= oH - r
            let x = 0,
                y = 0,
                distToEdge = 0,
                nX = 0,
                nY = 0,
                inBezel = false
            if ((isL || isR) && (isT || isB)) {
                x = isL ? x1 - r : x1 - (oW - r)
                y = isT ? y1 - r : y1 - (oH - r)
                const dfc =
                    shape === "squircle" && cornerRadius > 0
                        ? squircleDistance(x, y, r, squircleExponent)
                        : Math.sqrt(x * x + y * y)
                distToEdge = r - dfc
                if (distToEdge >= -1 && distToEdge <= bz) {
                    inBezel = true
                    const mag = Math.sqrt(x * x + y * y) || 1
                    nX = x / mag
                    nY = y / mag
                }
            } else if (isL || isR) {
                distToEdge = isL ? x1 : oW - 1 - x1
                if (distToEdge <= bz) {
                    inBezel = true
                    nX = isL ? -1 : 1
                    nY = 0
                }
            } else if (isT || isB) {
                distToEdge = isT ? y1 : oH - 1 - y1
                if (distToEdge <= bz) {
                    inBezel = true
                    nX = 0
                    nY = isT ? -1 : 1
                }
            }
            if (inBezel && distToEdge >= 0) {
                const opacity =
                    distToEdge >= 0 ? 1 : Math.max(0, 1 + distToEdge)
                const bi = Math.min(
                    precomputed.length - 1,
                    Math.max(0, ((distToEdge / bz) * precomputed.length) | 0)
                )
                const dist = precomputed[bi] ?? 0
                const dX = (-nX * dist) / maxDisp,
                    dY = (-nY * dist) / maxDisp
                imageData.data[idx] = 128 + dX * 127 * opacity
                imageData.data[idx + 1] = 128 + dY * 127 * opacity
                imageData.data[idx + 2] = 0
                imageData.data[idx + 3] = 255
            }
        }
    }
    return imageData
}

// ═══════════════════════════════════════════════════════════
// 4. SPECULAR
// ═══════════════════════════════════════════════════════════

function calculateRefractionSpecular(
    objW: number,
    objH: number,
    radius: number,
    bezelWidth: number,
    shape: ShapeType = "circle",
    specularAngle: number = Math.PI / 3,
    dpr: number = 1
): ImageData {
    const bW = Math.floor(objW * dpr),
        bH = Math.floor(objH * dpr)
    const imageData = new ImageData(bW, bH)
    const bz = bezelWidth * dpr
    const sv = [Math.cos(specularAngle), Math.sin(specularAngle)]
    new Uint32Array(imageData.data.buffer).fill(0x00000000)

    // ─── Triangle branch ───
    // Squared edge-falloff concentrates the highlight at the edge itself —
    // otherwise the full bezel ribbon lights up roughly 3x the area of the
    // rectangle's corner arcs, making specularSaturation look wildly
    // different per shape.
    if (shape === "triangle") {
        for (let y1 = 0; y1 < bH; y1++) {
            for (let x1 = 0; x1 < bW; x1++) {
                if (!insideTriangle(x1, y1, bW, bH)) continue
                const { d, nx, ny } = nearestTriEdge(x1, y1, bW, bH)
                if (d <= bz && d >= 0) {
                    const idx = (y1 * bW + x1) * 4
                    const dot = Math.abs(nx * sv[0] + (-ny) * sv[1])
                    const edgeFalloff = Math.pow(1 - d / bz, 2)
                    const coeff =
                        dot *
                        Math.sqrt(1 - (1 - (bz - d) / bz) ** 2) *
                        edgeFalloff
                    const color = 255 * coeff
                    imageData.data[idx] = color
                    imageData.data[idx + 1] = color
                    imageData.data[idx + 2] = color
                    imageData.data[idx + 3] = color * coeff
                }
            }
        }
        return imageData
    }

    // ─── Rectangle / squircle / pill / circle branch ───
    const r = radius * dpr
    const r2 = r ** 2,
        rp2 = (r + dpr) ** 2,
        rmb2 = (r - bz) ** 2
    const wBR = bW - r * 2,
        hBR = bH - r * 2
    for (let y1 = 0; y1 < bH; y1++) {
        for (let x1 = 0; x1 < bW; x1++) {
            const idx = (y1 * bW + x1) * 4
            const isL = x1 < r,
                isR = x1 >= bW - r,
                isT = y1 < r,
                isB = y1 >= bH - r
            const x = isL ? x1 - r : isR ? x1 - r - wBR : 0
            const y = isT ? y1 - r : isB ? y1 - r - hBR : 0
            const d2 = x * x + y * y
            if (d2 <= rp2 && d2 >= rmb2) {
                const dfc = Math.sqrt(d2),
                    dfs = r - dfc
                const opacity =
                    d2 < r2
                        ? 1
                        : 1 -
                          (dfc - Math.sqrt(r2)) /
                              (Math.sqrt(rp2) - Math.sqrt(r2))
                const cos = x / dfc,
                    sin = -y / dfc
                const dot = Math.abs(cos * sv[0] + sin * sv[1])
                const coeff = dot * Math.sqrt(1 - (1 - dfs / (1 * dpr)) ** 2)
                const color = 255 * coeff
                const finalOpacity = color * coeff * opacity
                imageData.data[idx] = color
                imageData.data[idx + 1] = color
                imageData.data[idx + 2] = color
                imageData.data[idx + 3] = finalOpacity
            }
        }
    }
    return imageData
}

// ═══════════════════════════════════════════════════════════
// 5. HELPERS
// ═══════════════════════════════════════════════════════════

function imageDataToDataUrl(imageData: ImageData): string {
    const c = document.createElement("canvas")
    c.width = imageData.width
    c.height = imageData.height
    c.getContext("2d")!.putImageData(imageData, 0, 0)
    return c.toDataURL("image/png")
}

function getEffectiveRadius(
    shape: ShapeType,
    w: number,
    h: number,
    cr: number
): number {
    const maxCR = Math.min(w, h) / 2
    switch (shape) {
        case "circle":
            return maxCR
        case "pill":
            return Math.min(w, h) / 2
        case "triangle":
            return 0
        default:
            return cr * maxCR
    }
}

function getCSSBorderRadius(
    shape: ShapeType,
    w: number,
    h: number,
    cr: number
): string {
    switch (shape) {
        case "circle":
            return "50%"
        case "pill":
            return `${Math.min(w, h) / 2}px`
        case "triangle":
            return "0"
        default:
            return `${(cr * Math.min(w, h)) / 2}px`
    }
}

const TRI_CLIP = "polygon(50% 0%, 100% 100%, 0% 100%)"

// ═══════════════════════════════════════════════════════════
// 6. COMPONENT
// ═══════════════════════════════════════════════════════════

interface Props {
    width: number
    height: number
    children?: React.ReactNode[]
    shape: ShapeType
    cornerRadius: number
    squircleExponent: number
    cornerSoftness: number
    bezelType: string
    bezelWidth: number
    glassThickness: number
    refractiveIndex: number
    scaleRatio: number
    blur: number
    frost: number
    specularOpacity: number
    specularSaturation: number
    tintColor: string
    tintOpacity: number
    showBorder: boolean
    borderWidth: number
    borderColor: string
    borderOpacity: number
    showShadow: boolean
    shadowX: number
    shadowY: number
    shadowBlur: number
    shadowSpread: number
    shadowColor: string
    shadowOpacity: number
    draggable: boolean
    simulateFallback: boolean
    fallbackBlur: number
    fallbackTintColor: string
    fallbackTintOpacity: number
    fallbackSaturation: number
}

function Fresnel(props: Props) {
    const {
        width = 300,
        height = 200,
        children,
        shape = "pill",
        cornerRadius = 1.0,
        squircleExponent = 4,
        cornerSoftness = 0.5,
        bezelType = "convex_squircle",
        bezelWidth = 40,
        glassThickness = 120,
        refractiveIndex = 1.5,
        scaleRatio = 1,
        blur = 0.2,
        frost = 0,
        specularOpacity = 0.4,
        specularSaturation = 4,
        tintColor = "#ffffff",
        tintOpacity = 5,
        showBorder = true,
        borderWidth = 1.5,
        borderColor = "#707070",
        borderOpacity = 38,
        showShadow = true,
        shadowX = 0,
        shadowY = 4,
        shadowBlur = 20,
        shadowSpread = 0,
        shadowColor = "#000000",
        shadowOpacity = 24,
        draggable = false,
        simulateFallback = false,
        fallbackBlur = 12,
        fallbackTintColor = "#ffffff",
        fallbackTintOpacity = 10,
        fallbackSaturation = 120,
    } = props

    const reactId = useId()
    const filterId = `fresnel${reactId.replace(/:/g, "-")}`
    const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 })
    const dragState = useRef({ active: false, sx: 0, sy: 0, ox: 0, oy: 0 })
    const outerRef = useRef<HTMLDivElement>(null)

    // Detect Chromium
    const [isChromium, setIsChromium] = useState(true)
    useEffect(() => {
        if (typeof window === "undefined") return
        const ua = navigator.userAgent
        const chromium = /Chrome\//.test(ua) || /CriOS\//.test(ua)
        setIsChromium(chromium)
    }, [])

    const useFallback = simulateFallback || !isChromium
    const isTriangle = shape === "triangle"

    // Measure actual rendered size
    const [size, setSize] = useState<[number, number]>([0, 0])
    const lastSize = useRef<[number, number]>([0, 0])
    useEffect(() => {
        const el = outerRef.current
        if (!el) return
        const update = () => {
            const rect = el.getBoundingClientRect()
            const w = Math.round(rect.width)
            const h = Math.round(rect.height)
            if (w !== lastSize.current[0] || h !== lastSize.current[1]) {
                lastSize.current = [w, h]
                if (w > 4 && h > 4) setSize([w, h])
            }
        }
        update()
        const ro = new ResizeObserver(update)
        ro.observe(el)
        return () => ro.disconnect()
    }, [])

    const W = size[0] || 4
    const H = size[1] || 4
    const ready = W > 4 && H > 4

    const effectiveRadius = getEffectiveRadius(shape, W, H, cornerRadius)
    const cssBorderRadius = getCSSBorderRadius(shape, W, H, cornerRadius)
    const quality = 2

    // Color helpers
    const toHexAlpha = (opacity100: number) =>
        Math.round((opacity100 / 100) * 255)
            .toString(16)
            .padStart(2, "0")
    const tintBg =
        tintOpacity > 0 ? `${tintColor}${toHexAlpha(tintOpacity)}` : "transparent"
    const borderStyle = showBorder
        ? `${borderWidth}px solid ${borderColor}${toHexAlpha(borderOpacity)}`
        : "none"
    const rectShadowStyle = showShadow
        ? `${shadowX}px ${shadowY}px ${shadowBlur}px ${shadowSpread}px ${shadowColor}${toHexAlpha(shadowOpacity)}`
        : "none"
    // Triangle shadow uses CSS filter: drop-shadow on the glass element
    // itself. drop-shadow respects clip-path and casts from the clipped
    // silhouette, so the shadow is triangle-shaped instead of rectangular.
    // filter on the same element as backdrop-filter does NOT create a
    // backdrop-root for that element's own backdrop — only for descendants.
    const triangleDropShadow =
        isTriangle && showShadow
            ? `drop-shadow(${shadowX}px ${shadowY}px ${shadowBlur}px ${shadowColor}${toHexAlpha(shadowOpacity)})`
            : undefined

    // Map generation
    const [maps, setMaps] = useState<{
        dispUrl: string
        specUrl: string
        maxDisp: number
    } | null>(null)

    useEffect(() => {
        if (typeof document === "undefined") return
        if (!ready || useFallback) return
        try {
            const surfaceFn = SURFACE_FNS[bezelType] || CONVEX_SQUIRCLE
            const precomputed = calculateDisplacementMap(
                glassThickness,
                bezelWidth,
                surfaceFn,
                refractiveIndex,
                128
            )
            const md =
                Math.max(...precomputed.map((v) => Math.abs(v))) || 1
            let dispImageData: ImageData
            if (shape !== "circle") {
                dispImageData = calculateDisplacementMapWithShape(
                    W,
                    H,
                    W,
                    H,
                    bezelWidth,
                    100,
                    precomputed,
                    shape,
                    cornerRadius,
                    squircleExponent,
                    quality,
                    cornerSoftness
                )
            } else {
                dispImageData = calculateDisplacementMap2(
                    W,
                    H,
                    W,
                    H,
                    effectiveRadius,
                    bezelWidth,
                    100,
                    precomputed,
                    quality
                )
            }
            const specImageData = calculateRefractionSpecular(
                W,
                H,
                effectiveRadius,
                bezelWidth,
                shape,
                undefined,
                quality
            )
            setMaps({
                dispUrl: imageDataToDataUrl(dispImageData),
                specUrl: imageDataToDataUrl(specImageData),
                maxDisp: md,
            })
        } catch (e) {
            console.warn("[Fresnel] Map generation failed:", e)
        }
    }, [
        bezelType,
        bezelWidth,
        glassThickness,
        refractiveIndex,
        W,
        H,
        effectiveRadius,
        shape,
        cornerRadius,
        squircleExponent,
        cornerSoftness,
        ready,
        useFallback,
    ])

    const scale = maps ? maps.maxDisp * scaleRatio : 0

    // Drag
    const onPointerDown = useCallback(
        (e: React.PointerEvent) => {
            if (!draggable) return
            dragState.current = {
                active: true,
                sx: e.clientX,
                sy: e.clientY,
                ox: dragOffset.x,
                oy: dragOffset.y,
            }
            ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
            e.preventDefault()
        },
        [draggable, dragOffset]
    )
    const onPointerMove = useCallback((e: React.PointerEvent) => {
        if (!dragState.current.active) return
        setDragOffset({
            x: dragState.current.ox + e.clientX - dragState.current.sx,
            y: dragState.current.oy + e.clientY - dragState.current.sy,
        })
    }, [])
    const onPointerUp = useCallback(() => {
        dragState.current.active = false
    }, [])

    const fallbackTintBg =
        fallbackTintOpacity > 0
            ? `${fallbackTintColor}${toHexAlpha(fallbackTintOpacity)}`
            : "transparent"

    // Shape-specific clipping applied to each descendant that needs it
    // (clip-path on an ANCESTOR would create a backdrop-root and break
    // the glass element's backdrop-filter).
    const clipStyle: React.CSSProperties = isTriangle
        ? { clipPath: TRI_CLIP, WebkitClipPath: TRI_CLIP }
        : { borderRadius: cssBorderRadius }

    // Outer wrapper: for non-triangle, holds border-radius + box-shadow.
    // For triangle, just holds size/transform — shadow moves to the glass div.
    const outerShapeStyle: React.CSSProperties = isTriangle
        ? {}
        : { borderRadius: cssBorderRadius, boxShadow: rectShadowStyle }

    // Inner wrapper: for non-triangle, clips content via border-radius +
    // overflow hidden. For triangle, no-op — each descendant clips itself.
    const innerShapeStyle: React.CSSProperties = isTriangle
        ? {}
        : { borderRadius: cssBorderRadius, overflow: "hidden" }

    return (
        <div
            ref={outerRef}
            style={{
                position: "relative",
                width: "100%",
                height: "100%",
                ...outerShapeStyle,
                transform: draggable
                    ? `translate(${dragOffset.x}px, ${dragOffset.y}px)`
                    : undefined,
                cursor: draggable ? "grab" : undefined,
            }}
            onPointerDown={draggable ? onPointerDown : undefined}
            onPointerMove={draggable ? onPointerMove : undefined}
            onPointerUp={draggable ? onPointerUp : undefined}
        >
            <div
                style={{
                    position: "absolute",
                    inset: 0,
                    ...innerShapeStyle,
                }}
            >
                {/* ═══ CHROMIUM PATH ═══ */}
                {!useFallback && (
                    <>
                        {maps && (
                            <svg
                                style={{
                                    position: "absolute",
                                    width: 0,
                                    height: 0,
                                    overflow: "hidden",
                                }}
                                colorInterpolationFilters="sRGB"
                            >
                                <defs>
                                    <filter id={filterId}>
                                        <feGaussianBlur
                                            in="SourceGraphic"
                                            stdDeviation={blur}
                                            result="blurred_source"
                                        />
                                        <feImage
                                            href={maps.dispUrl}
                                            x="0"
                                            y="0"
                                            width={W}
                                            height={H}
                                            result="displacement_map"
                                        />
                                        <feDisplacementMap
                                            in="blurred_source"
                                            in2="displacement_map"
                                            scale={scale}
                                            xChannelSelector="R"
                                            yChannelSelector="G"
                                            result="displaced"
                                        />
                                        <feColorMatrix
                                            in="displaced"
                                            type="saturate"
                                            values={specularSaturation.toString()}
                                            result="displaced_saturated"
                                        />
                                        <feImage
                                            href={maps.specUrl}
                                            x="0"
                                            y="0"
                                            width={W}
                                            height={H}
                                            result="specular_layer"
                                        />
                                        <feComposite
                                            in="displaced_saturated"
                                            in2="specular_layer"
                                            operator="in"
                                            result="specular_saturated"
                                        />
                                        <feComponentTransfer
                                            in="specular_layer"
                                            result="specular_faded"
                                        >
                                            <feFuncA
                                                type="linear"
                                                slope={specularOpacity.toString()}
                                            />
                                        </feComponentTransfer>
                                        <feBlend
                                            in="specular_saturated"
                                            in2="displaced"
                                            mode="normal"
                                            result="withSaturation"
                                        />
                                        <feBlend
                                            in="specular_faded"
                                            in2="withSaturation"
                                            mode="normal"
                                        />
                                    </filter>
                                </defs>
                            </svg>
                        )}
                        <div
                            style={{
                                position: "absolute",
                                inset: 0,
                                ...clipStyle,
                                filter: triangleDropShadow,
                                ...(maps
                                    ? {
                                          backdropFilter: `url(#${filterId})`,
                                          WebkitBackdropFilter: `url(#${filterId})`,
                                      }
                                    : {}),
                                backgroundColor: tintBg,
                                border: borderStyle,
                            }}
                        />
                    </>
                )}

                {/* ═══ FALLBACK PATH ═══ */}
                {useFallback && (
                    <div
                        style={{
                            position: "absolute",
                            inset: 0,
                            ...clipStyle,
                            filter: triangleDropShadow,
                            backdropFilter: `blur(${fallbackBlur}px) saturate(${fallbackSaturation}%)`,
                            WebkitBackdropFilter: `blur(${fallbackBlur}px) saturate(${fallbackSaturation}%)`,
                            backgroundColor: fallbackTintBg,
                            border: borderStyle,
                        }}
                    />
                )}

                {/* Frost layer */}
                {!useFallback && frost > 0 && (
                    <div
                        style={{
                            position: "absolute",
                            inset: 0,
                            ...clipStyle,
                            backdropFilter: `blur(${frost}px)`,
                            WebkitBackdropFilter: `blur(${frost}px)`,
                            pointerEvents: "none",
                        }}
                    />
                )}

                {/* Content slot */}
                <div
                    style={{
                        position: "absolute",
                        inset: 0,
                        zIndex: 1,
                        ...clipStyle,
                        ...(isTriangle ? {} : { overflow: "hidden" }),
                    }}
                >
                    {Array.isArray(children)
                        ? children.map((child, i) => (
                              <div
                                  key={i}
                                  style={{
                                      position: "absolute",
                                      inset: 0,
                                      display: "flex",
                                      alignItems: "center",
                                      justifyContent: "center",
                                  }}
                              >
                                  {child}
                              </div>
                          ))
                        : children && (
                              <div
                                  style={{
                                      position: "absolute",
                                      inset: 0,
                                      display: "flex",
                                      alignItems: "center",
                                      justifyContent: "center",
                                  }}
                              >
                                  {children}
                              </div>
                          )}
                </div>
            </div>
        </div>
    )
}

// ═══════════════════════════════════════════════════════════
// 7. PROPERTY CONTROLS
// ═══════════════════════════════════════════════════════════

addPropertyControls(Fresnel, {
    children: {
        type: ControlType.Array,
        title: "Content",
        control: { type: ControlType.ComponentInstance },
    },
    shape: {
        type: ControlType.Enum,
        title: "Shape",
        options: ["pill", "circle", "rectangle", "squircle", "triangle"],
        optionTitles: ["Pill", "Circle", "Rectangle", "Squircle", "Triangle"],
        defaultValue: "pill",
    },
    cornerRadius: {
        type: ControlType.Number,
        title: "Corner Radius",
        min: 0,
        max: 1,
        step: 0.05,
        defaultValue: 0.5,
        hidden: (p) =>
            p.shape === "pill" ||
            p.shape === "circle" ||
            p.shape === "triangle",
    },
    squircleExponent: {
        type: ControlType.Number,
        title: "Squircle Power",
        min: 2,
        max: 10,
        step: 1,
        defaultValue: 4,
        hidden: (p) => p.shape !== "squircle",
    },
    cornerSoftness: {
        type: ControlType.Number,
        title: "Vertex Softness",
        min: 0,
        max: 1,
        step: 0.05,
        defaultValue: 0.5,
        description:
            "Softens refraction near the three triangle vertices to prevent dark focal hotspots.",
        hidden: (p) => p.shape !== "triangle",
    },
    bezelType: {
        type: ControlType.Enum,
        title: "Bevel Profile",
        options: ["convex_squircle", "convex_circle", "concave", "lip"],
        optionTitles: ["Squircle (Apple)", "Circle", "Concave", "Lip"],
        defaultValue: "convex_squircle",
    },
    bezelWidth: {
        type: ControlType.Number,
        title: "Bezel Width",
        min: 5,
        max: 80,
        step: 1,
        defaultValue: 40,
    },
    glassThickness: {
        type: ControlType.Number,
        title: "Thickness",
        min: 10,
        max: 400,
        step: 5,
        defaultValue: 120,
    },
    refractiveIndex: {
        type: ControlType.Number,
        title: "IOR",
        min: 1.0,
        max: 3.0,
        step: 0.05,
        defaultValue: 1.5,
    },
    scaleRatio: {
        type: ControlType.Number,
        title: "Scale",
        min: 0.1,
        max: 2.0,
        step: 0.05,
        defaultValue: 1.0,
    },
    blur: {
        type: ControlType.Number,
        title: "Blur",
        min: 0,
        max: 5,
        step: 0.1,
        defaultValue: 0.2,
    },
    frost: {
        type: ControlType.Number,
        title: "Frost",
        min: 0,
        max: 20,
        step: 0.5,
        defaultValue: 0,
    },
    specularOpacity: {
        type: ControlType.Number,
        title: "Specular",
        min: 0,
        max: 1,
        step: 0.05,
        defaultValue: 0.4,
    },
    specularSaturation: {
        type: ControlType.Number,
        title: "Saturation",
        min: 0,
        max: 20,
        step: 1,
        defaultValue: 4,
    },
    tintColor: {
        type: ControlType.Color,
        title: "Tint Color",
        defaultValue: "#ffffff",
    },
    tintOpacity: {
        type: ControlType.Number,
        title: "Tint Opacity",
        min: 0,
        max: 50,
        step: 1,
        defaultValue: 5,
        unit: "%",
    },
    showBorder: {
        type: ControlType.Boolean,
        title: "Border",
        defaultValue: true,
        enabledTitle: "Show",
        disabledTitle: "Hide",
    },
    borderWidth: {
        type: ControlType.Number,
        title: "Border Width",
        min: 0.5,
        max: 5,
        step: 0.5,
        defaultValue: 1.5,
        unit: "px",
        hidden: (p) => !p.showBorder,
    },
    borderColor: {
        type: ControlType.Color,
        title: "Border Color",
        defaultValue: "#707070",
        hidden: (p) => !p.showBorder,
    },
    borderOpacity: {
        type: ControlType.Number,
        title: "Border Opacity",
        min: 0,
        max: 100,
        step: 1,
        defaultValue: 38,
        unit: "%",
        hidden: (p) => !p.showBorder,
    },
    showShadow: {
        type: ControlType.Boolean,
        title: "Shadow",
        defaultValue: true,
        enabledTitle: "Show",
        disabledTitle: "Hide",
    },
    shadowX: {
        type: ControlType.Number,
        title: "Shadow X",
        min: -50,
        max: 50,
        step: 1,
        defaultValue: 0,
        unit: "px",
        hidden: (p) => !p.showShadow,
    },
    shadowY: {
        type: ControlType.Number,
        title: "Shadow Y",
        min: -50,
        max: 50,
        step: 1,
        defaultValue: 4,
        unit: "px",
        hidden: (p) => !p.showShadow,
    },
    shadowBlur: {
        type: ControlType.Number,
        title: "Shadow Blur",
        min: 0,
        max: 100,
        step: 1,
        defaultValue: 20,
        unit: "px",
        hidden: (p) => !p.showShadow,
    },
    shadowSpread: {
        type: ControlType.Number,
        title: "Shadow Spread",
        min: -20,
        max: 50,
        step: 1,
        defaultValue: 0,
        unit: "px",
        description:
            "Not used for triangle shape (CSS drop-shadow doesn't support spread)",
        hidden: (p) => !p.showShadow || p.shape === "triangle",
    },
    shadowColor: {
        type: ControlType.Color,
        title: "Shadow Color",
        defaultValue: "#000000",
        hidden: (p) => !p.showShadow,
    },
    shadowOpacity: {
        type: ControlType.Number,
        title: "Shadow Opacity",
        min: 0,
        max: 100,
        step: 1,
        defaultValue: 24,
        unit: "%",
        hidden: (p) => !p.showShadow,
    },
    draggable: {
        type: ControlType.Boolean,
        title: "Draggable",
        defaultValue: false,
        enabledTitle: "Yes",
        disabledTitle: "No",
    },

    // ── Fallback (non-Chromium) ──
    simulateFallback: {
        type: ControlType.Boolean,
        title: "Simulate Fallback",
        defaultValue: false,
        enabledTitle: "On",
        disabledTitle: "Off",
        description: "Preview the Safari/Firefox fallback in the editor",
    },
    fallbackBlur: {
        type: ControlType.Number,
        title: "Fallback Blur",
        min: 0,
        max: 40,
        step: 1,
        defaultValue: 12,
        unit: "px",
        hidden: (p) => !p.simulateFallback,
    },
    fallbackTintColor: {
        type: ControlType.Color,
        title: "Fallback Tint",
        defaultValue: "#ffffff",
        hidden: (p) => !p.simulateFallback,
    },
    fallbackTintOpacity: {
        type: ControlType.Number,
        title: "Fallback Tint %",
        min: 0,
        max: 60,
        step: 1,
        defaultValue: 10,
        unit: "%",
        hidden: (p) => !p.simulateFallback,
    },
    fallbackSaturation: {
        type: ControlType.Number,
        title: "Fallback Saturation",
        min: 50,
        max: 200,
        step: 5,
        defaultValue: 120,
        unit: "%",
        hidden: (p) => !p.simulateFallback,
    },
})

export default Fresnel
