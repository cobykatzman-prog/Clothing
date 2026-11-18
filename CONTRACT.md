# Threadform – architecture contract

Static site, **no build step**: vanilla ES modules, deployed as a static site (Vercel or Render). No server code, no API keys, no network requests: everything runs in the browser.
No npm runtime deps in the browser. Everything is a 1024x1024 working canvas (`const SIZE = 1024`, exported from `js/util.js`).
All image functions take/return `HTMLCanvasElement` (SIZE x SIZE, RGBA, garment on transparent bg) unless noted.

## Files and owners (do NOT edit files you do not own)
| Owner | Files |
|---|---|
| A shell | `index.html`, `css/style.css`, `js/main.js`, `js/state.js`, `js/canvas.js`, `js/util.js`, `js/ui-*.js` |
| B engine | `js/segment.js`, `js/warp.js`, `js/fabric.js`, `js/variations.js` |
| C prompt | `js/prompt.js`, `vercel.json`, `render.yaml` |
| D design | `js/samples.js`, `js/elements.js`, `js/export.js` |

## Shared module APIs

### js/util.js (A)
`SIZE`, `makeCanvas(w=SIZE,h=SIZE)`, `cloneCanvas(c)`, `loadImageToCanvas(fileOrUrl) -> Promise<canvas>` (contain-fit, centred, transparent padding), `canvasToBlob(c,type)`, `clamp`, `debounce`.

### js/segment.js (B)
```
export const REGION_NAMES = ['body','leftSleeve','rightSleeve','collar','neckline','cuffs','hem','shoulders','sidePanels','stripes','logos','text','fabric'];
export async function segmentGarment(canvas) -> Segmentation
// Segmentation = { mask: canvas(alpha=garment), bbox:{x,y,w,h}, regions: {[name]: canvas(alpha mask)}, landmarks:{neckTop,neckBottom,shoulderL,shoulderR,hemL,hemR,cuffL,cuffR,armpitL,armpitR,centerX} }
// Works on photos (flat/plain background removal via border colour flood + edge threshold) and on already-transparent PNGs.
// "left" = garment's left = viewer's RIGHT.
export function regionAt(seg, x, y) -> regionName|null
export function removeBackground(canvas) -> canvas
```

### js/warp.js (B)
```
export const DEFAULT_PARAMS = { bodyWidth:0, bodyLength:0, shoulderWidth:0, sleeveLength:0, sleeveWidth:0, sleeveFlare:0, sleeveShape:0, collarSize:0, neckOpening:0, hemShape:0, cropLength:0 }; // all sliders -100..100, 0 = unchanged
export const SLEEVE_PRESETS = { straight:{...}, relaxed, oversized, tapered, bell, slightFlare, wideFlare, openHem, ribbedCuff }; // each = partial params
export const FIT_PRESETS = { slim, regular, relaxed, boxy, oversized, cropped }; // each = partial params
export function applyShape(srcCanvas, seg, params, opts?:{region?:canvas mask}) -> Promise<{canvas, seg}>
// Real geometric garment reshaping (mesh/region-wise warps driven by seg.landmarks), not an overlay. Always re-derived from the ORIGINAL srcCanvas + params so sliders are non-destructive. Returns the new segmentation too.
```

### js/fabric.js (B)
```
export const FABRICS = ['cotton','heavyweightCotton','linen','denim','silk','wool','knit','corduroy','leather','satin'];
export function applyColor(canvas, mask|null, {hue,sat,light,tint:'#rrggbb'|null,tintAmount}) -> canvas   // hue -180..180, sat/light -100..100; mask=null → whole garment
export function applyFabric(canvas, mask|null, fabricName, amount=0.6) -> canvas   // procedural weave/texture + shading, preserves folds/shadows
export function eraseRegion... (not needed)
```

### js/variations.js (B)
```
export async function localVariations(canvas, seg, mask|null, ops) -> [{label:'Subtle'|'Medium'|'Bold', canvas, seg}]  // the in-browser variation engine; ops from prompt.js; scales ops by 0.35/0.7/1.0; only touches pixels inside mask (if given) or in the regions named by ops; preserves everything else byte-for-byte
```

### js/prompt.js (C)
```
export function parsePrompt(text) -> { summary:string, paramDeltas:{[paramKey]:number}, sleevePreset?:string, fitPreset?:string, regions:string[] /*REGION_NAMES*/, fabric?:string, color?:{hue?,sat?,light?,tint?}, keep:string[] /*regions to preserve*/, keepAllExcept?:string[], style?:string, addElements:[{type:'stripe'|'piping'|'text'|'patch'|'logo', color?, region?, text?}], confidence:number }
// Rule-based NL → ops, covers all the example prompts in the brief (flared sleeves, remove cuffs, boxy, oversized, long sleeve, collar styles, piping colour, cropped hem, heavyweight cotton, Greek island / vintage styles, "keep everything except X").
export function intensityScale(label) -> 0.35|0.7|1
```

### js/samples.js (D)
```
export function sampleGarment(kind:'tee'|'longSleeve'|'polo'|'hoodie', view:'front'|'back'|'side'|'detail', {color,stripe}) -> canvas   // procedural, shaded, realistic-ish flat-lay garment drawn on canvas with stripes/cuffs/collar, transparent bg
export const SAMPLE_KINDS
```

### js/elements.js (D)
```
export class ElementLayer { id,type,x,y,w,h,rotation,props,view,visible }   // type: text|logo|crest|graphic|stripe|piping|embroidery|print|patch
export function createElement(type, props) -> ElementLayer
export function drawElements(ctx, elements, view, {selectedId, handles:boolean})
export function hitTest(elements, view, x, y) -> {element, handle:'move'|'scale-nw|ne|sw|se'|'rotate'|null}|null
export function moveElement/scaleElement/rotateElement(el, ...)
export function elementsToSVG(elements, view, size) -> string
export const GRAPHIC_LIBRARY  // built-in crests/graphics/patches as SVG strings
```
Elements are vector objects kept in state (`state.elements`), composited above the garment bitmap; independently movable/scalable/editable.

### js/export.js (D)
```
export async function exportPNG({baseCanvas, elements, view, scale=1, transparent=true}) -> Blob
export function exportSVG({elements, view}) -> string    // editable vector graphics
export async function exportDesignSheet({views:{front,back,...}, elements, params, notes, name}) -> Blob  // PNG sheet: title, front+back, detail, colour swatches, spec list
export function download(blobOrString, filename)
```

### js/state.js (A)
Single store: `state = { name, views:{front,back,side,detail}:{original:canvas|null, current:canvas|null, seg, mask:canvas}, activeView, params (per view), elements, references:[canvas], versions:[{id,label,thumb,snapshot}], undo/redo stacks }`; functions `snapshot()`, `undo()`, `redo()`, `pushVersion(label)`, `restoreVersion(id)`, `subscribe(fn)`.

## Rules
- No external CDN/network deps at runtime. No frameworks. Plain ES modules (`<script type="module">`).
- Every module must be importable in a browser with no bundler: relative imports with `.js` extension.
- Keep functions fast: processing at 1024px must finish < ~1s for warps (use typed arrays / ImageData, not per-pixel getPixel calls).
- Honest UX: the studio is a local garment-shape engine, not an AI. Never call the network (CSP is `connect-src 'none'`).
- Test your own modules in headless Chromium (Playwright is preinstalled: `require('playwright')`, launch with no options) via a tiny test page or `page.evaluate`. Do not run `playwright install`.
- Commit nothing; the lead will commit.
