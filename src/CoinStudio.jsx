import { useRef, useEffect, useState, useCallback } from "react";
import * as THREE from "three";
import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";

// =========================================================================
//  TEXTURE HELPERS
// =========================================================================
// Face/halo/shadow canvas resolution. Bumped from 512 → 2048 so uploaded coin
// artwork stays crisp at 4K exports (a coin rendered ~1200px on the export
// canvas now has enough source pixels to match without visible upscaling).
const S = 2048;
const canvas = () => {
  const c = document.createElement("canvas");
  c.width = c.height = S;
  return c;
};
const rgb = (r, g, b) => `rgb(${r},${g},${b})`;

function faceGradient(ctx, top, bot) {
  const g = ctx.createLinearGradient(0, 0, 0, S);
  g.addColorStop(0, top);
  g.addColorStop(1, bot);
  ctx.save();
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  ctx.restore();
}

function bevel(ctx, light) {
  const r = S / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(r, r, r - 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.strokeStyle = light;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(r, r, r * 0.86, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 0.18;
  const sh = ctx.createLinearGradient(0, 0, S, S);
  sh.addColorStop(0, "rgba(255,255,255,1)");
  sh.addColorStop(0.45, "rgba(255,255,255,0)");
  ctx.fillStyle = sh;
  ctx.beginPath();
  ctx.arc(r, r, r - 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.22;
  const vg = ctx.createRadialGradient(r, r * 0.7, r * 0.2, r, r, r);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(0,0,0,1)");
  ctx.fillStyle = vg;
  ctx.beginPath();
  ctx.arc(r, r, r - 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function makeTex(painter) {
  const c = canvas();
  painter(c.getContext("2d"));
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 16;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function plainFaceTex(pal) {
  return makeTex((ctx) => {
    faceGradient(ctx, pal.top, pal.bot);
    bevel(ctx, pal.rim);
  });
}

function imageFaceTex(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const c = canvas();
      const ctx = c.getContext("2d");
      ctx.save();
      ctx.beginPath();
      ctx.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2);
      ctx.clip();
      const r = Math.max(S / img.width, S / img.height);
      const w = img.width * r, h = img.height * r;
      ctx.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
      // Soft top-left sheen only — no inner vignette / dark arc — so the
      // uploaded image reads cleanly and the lighting stays consistent.
      const sh = ctx.createLinearGradient(0, 0, S, S);
      sh.addColorStop(0, "rgba(255,255,255,0.14)");
      sh.addColorStop(0.5, "rgba(255,255,255,0)");
      ctx.fillStyle = sh;
      ctx.fillRect(0, 0, S, S);
      ctx.restore();
      const t = new THREE.CanvasTexture(c);
      t.anisotropy = 16;
      t.colorSpace = THREE.SRGBColorSpace;
      resolve(t);
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// Rim colour texture — subtle vertical banding
function edgeTex(a, b) {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 16;
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 0, 16);
  g.addColorStop(0, a);
  g.addColorStop(0.5, b);
  g.addColorStop(1, a);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 16);
  for (let x = 0; x < 512; x += 3) {
    ctx.fillStyle = "rgba(255,255,255,0.18)"; ctx.fillRect(x, 0, 1, 16);
    ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.fillRect(x + 1, 0, 1, 16);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.set(64, 1);
  t.anisotropy = 16;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Reeded-rim normal map — fine vertical grooves for real coin edge.
// Blue channel stays near 255 (facing outward); only red varies to tilt X.
function reedingNormal() {
  const c = document.createElement("canvas");
  c.width = 512; c.height = 32;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "rgb(128,128,255)";
  ctx.fillRect(0, 0, 512, 32);
  const period = 6;
  for (let x = 0; x < 512; x += period) {
    const g = ctx.createLinearGradient(x, 0, x + period, 0);
    g.addColorStop(0,   "rgb(96,128,255)");
    g.addColorStop(0.5, "rgb(128,128,255)");
    g.addColorStop(1,   "rgb(160,128,255)");
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, period, 32);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.set(64, 1);
  // normal maps must be linear, NOT sRGB — this was tinting the rim blue.
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

// Soft radial halo used behind each coin — additively blended, controls the glow.
function haloTex() {
  const c = canvas();
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0.00, "rgba(255,255,255,1)");
  g.addColorStop(0.18, "rgba(200,215,255,0.55)");
  g.addColorStop(0.5,  "rgba(140,170,255,0.14)");
  g.addColorStop(1.0,  "rgba(140,170,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(c);
}

// Sample the average colour of a horizontal band from an image URL.
// Used to blend the coin rim with the uploaded front/back faces.
function averageColor(dataUrl, band = [0.35, 0.65]) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const w = 64, h = 64;
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      const y0 = Math.floor(band[0] * h);
      const y1 = Math.floor(band[1] * h);
      let r = 0, g = 0, b = 0, n = 0;
      try {
        const d = ctx.getImageData(0, y0, w, y1 - y0).data;
        for (let i = 0; i < d.length; i += 4) {
          const alpha = d[i + 3]; if (alpha < 24) continue;
          r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
        }
      } catch (e) { return reject(e); }
      if (!n) return reject(new Error("empty"));
      resolve(`rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`);
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function shadowTex() {
  const c = canvas();
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, "rgba(40,44,90,0.42)");
  g.addColorStop(0.55, "rgba(40,44,90,0.16)");
  g.addColorStop(1, "rgba(40,44,90,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(c);
}

// =========================================================================
//  PATH & EASING HELPERS
// =========================================================================
// Universal easing applied to a normalized loop parameter t ∈ [0, 1). Ease
// functions preserve f(0)=0 and f(1)=1 so a looping animation stays continuous.
function easeFn(t, mode, k = 2) {
  switch (mode) {
    case "in":    return Math.pow(t, k);
    case "out":   return 1 - Math.pow(1 - t, k);
    case "inout": return t < 0.5
      ? 0.5 * Math.pow(2 * t, k)
      : 1 - 0.5 * Math.pow(2 - 2 * t, k);
    default:      return t;
  }
}
// =========================================================================
//  COIN MESH (thick body + reeded rim + bevel rings on both edges)
// =========================================================================
const BASE_THICK = 0.22;
function buildCoinMeshes(palette) {
  const seg = 192;
  const edge = edgeTex(palette.edge[0], palette.edge[1]);
  const normal = reedingNormal();
  const edgeMat = new THREE.MeshPhysicalMaterial({
    map: edge,
    normalMap: normal,
    normalScale: new THREE.Vector2(0.35, 0.35),
    metalness: 0.7,
    roughness: 0.42,
    clearcoat: 0.12,
    clearcoatRoughness: 0.55,
    envMapIntensity: 0.2,
  });
  const faceTexA = plainFaceTex(palette);
  const faceTexB = plainFaceTex(palette);
  // A softly emissive base keeps the face artwork readable when tilted, while
  // the physical layer still lets the draggable softbox add visible light.
  const faceOpts = {
    color: 0x222222,
    metalness: 0, roughness: 1,
    clearcoat: 0, clearcoatRoughness: 1,
    envMapIntensity: 0,
    emissive: 0xffffff, emissiveIntensity: 0.85,
  };
  const fA = new THREE.MeshPhysicalMaterial({ ...faceOpts, map: faceTexA, emissiveMap: faceTexA, side: THREE.FrontSide });
  const fB = new THREE.MeshPhysicalMaterial({ ...faceOpts, map: faceTexB, emissiveMap: faceTexB, side: THREE.FrontSide });
  // Body split: an open-ended cylinder for the reeded edge + two disc caps for
  // the faces. Separate meshes let us give front/back independent renderOrder
  // so a "Face priority" control can pick which side wins visual collisions.
  const edgeGeo = new THREE.CylinderGeometry(1, 1, BASE_THICK, seg, 1, true);
  const body = new THREE.Mesh(edgeGeo, edgeMat);
  const capGeo = new THREE.CircleGeometry(1, seg);
  const faceFront = new THREE.Mesh(capGeo, fA);
  faceFront.rotation.x = -Math.PI / 2;
  faceFront.position.y = BASE_THICK / 2 + 0.0001;
  const faceBack = new THREE.Mesh(capGeo.clone(), fB);
  faceBack.rotation.x = Math.PI / 2;
  faceBack.position.y = -BASE_THICK / 2 - 0.0001;
  const bevelGeo = new THREE.TorusGeometry(0.997, 0.022, 14, seg);
  const bevelA = new THREE.Mesh(bevelGeo, edgeMat);
  bevelA.rotation.x = Math.PI / 2;
  bevelA.position.y = BASE_THICK / 2;
  const bevelB = new THREE.Mesh(bevelGeo, edgeMat);
  bevelB.rotation.x = Math.PI / 2;
  bevelB.position.y = -BASE_THICK / 2;
  const coin = new THREE.Group();
  coin.add(body, faceFront, faceBack, bevelA, bevelB);
  coin.rotation.x = Math.PI / 2;
  return { coin, body, faceFront, faceBack, bevelA, bevelB, edgeMat, faceMats: [fA, fB] };
}

// =========================================================================
//  PALETTES — used to seed new coins
// =========================================================================
const PALETTES = {
  sage:   { top: rgb(142, 150, 240), bot: rgb(168, 168, 196), edge: ["#8b93ff", "#3a2fb0"], rim: "rgb(150,160,255)" },
  steel:  { top: rgb(153, 184, 202), bot: rgb(60, 72, 84),    edge: ["#2a3444", "#0f151d"], rim: "rgb(200,235,245)" },
  night:  { top: rgb(12, 14, 40),    bot: rgb(2, 2, 12),      edge: ["#1c2250", "#05061c"], rim: "rgb(70,110,220)" },
  violet: { top: rgb(84, 88, 224),   bot: rgb(46, 48, 155),   edge: ["#b3a6ff", "#3a2bb5"], rim: "rgb(210,205,255)" },
  indigo: { top: rgb(150, 155, 250), bot: rgb(120, 128, 235), edge: ["#9aa2ff", "#4038c8"], rim: "rgb(180,190,255)" },
};
const PALETTE_KEYS = Object.keys(PALETTES);

// Default Nepal coin set. The four-face rhythm matches the supplied reference:
// cow, then three map coins, with the mountain artwork on every reverse.
const DEFAULT_COW_FRONT = "/images/coins/nepal-cow.png";
const DEFAULT_MAP_FRONT = "/images/coins/nepal-map.jpg";
const DEFAULT_BACK = "/images/coins/nepal-mountain.jpg";
const DEFAULT_FRONTS = [
  DEFAULT_COW_FRONT,
  DEFAULT_MAP_FRONT,
  DEFAULT_MAP_FRONT,
  DEFAULT_MAP_FRONT,
];
const DEFAULT_COIN_COUNT = 10;

const newId = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) ||
  Math.random().toString(36).slice(2) + Date.now().toString(36);

const defaultFrontForIndex = (index) => DEFAULT_FRONTS[index % DEFAULT_FRONTS.length];
const createDefaultCoin = (index) => ({
  key: newId(),
  palette: PALETTE_KEYS[index % PALETTE_KEYS.length],
  front: defaultFrontForIndex(index),
  back: DEFAULT_BACK,
  phase: index * 1.2,
  angleOffset: 0,
});
const createDefaultCoins = () =>
  Array.from({ length: DEFAULT_COIN_COUNT }, (_, index) => createDefaultCoin(index));

// =========================================================================
//  UI PRIMITIVES
// =========================================================================
// Row: stacked label above, slider/control below (per component rules — no
// side-label form). Optional `unit` suffix uses the compact-vs-spaced format:
// %, px, °, s, ms, fps render tight; longer word units render with a space.
const COMPACT_UNITS = new Set(["%", "px", "°", "s", "ms", "fps", "deg"]);
const Row = ({ label, value, unit, children }) => {
  let display = value;
  if (value !== undefined && unit) {
    const compact = COMPACT_UNITS.has(unit);
    display = `${value}${compact ? unit : ` ${unit}`}`;
  }
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11.5px] font-medium text-slate-200">{label}</span>
        {display !== undefined && (
          <span className="text-[11px] tabular-nums text-slate-400 font-mono">{display}</span>
        )}
      </div>
      {children}
    </div>
  );
};
// Shared WebAudio context — plays a soft tick each time a slider steps.
// One AudioContext lives for the app lifetime; short envelopes prevent build-up.
let __audioCtx = null;
const getAudioCtx = () => {
  if (typeof window === "undefined") return null;
  if (!__audioCtx) {
    try { __audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch { return null; }
  }
  if (__audioCtx.state === "suspended") __audioCtx.resume().catch(() => {});
  return __audioCtx;
};
const playTick = (pct) => {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  // Frequency rides the slider position so higher values → higher pitch.
  const freq = 520 + Math.max(0, Math.min(1, pct)) * 380;
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.045, t + 0.003);
  gain.gain.exponentialRampToValueAtTime(0.0005, t + 0.055);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.07);
  // Light haptic tap on devices that support it.
  if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(6);
};

const Slider = ({ min, max, step, value, onChange }) => {
  const pct = ((value - min) / (max - min)) * 100;
  const lastPlayed = useRef(0);
  const handleChange = (e) => {
    const v = parseFloat(e.target.value);
    const now = performance.now();
    // Throttle audio to avoid an aggressive buzz — one tick per ~28ms.
    if (now - lastPlayed.current > 28) {
      playTick((v - min) / (max - min));
      lastPlayed.current = now;
    }
    onChange(v);
  };
  return (
    <input type="range" min={min} max={max} step={step} value={value}
      onChange={handleChange}
      className="cs-slider" style={{ "--pct": pct + "%" }} />
  );
};
const Switch = ({ checked, onChange }) => (
  <button onClick={() => onChange(!checked)}
    className={"cs-switch " + (checked ? "cs-switch-on" : "cs-switch-off")}>
    <span className="cs-knob" />
  </button>
);
// shadcn-style Tabs (30% smaller). Muted container, active pill swaps to
// foreground/background with a subtle shadow.
const Segment = ({ options, value, onChange }) => (
  <div className="inline-flex w-full h-6 p-0.5 rounded bg-slate-800/70 border border-slate-700/70">
    {options.map((o) => (
      <button key={o.v} onClick={() => onChange(o.v)}
        className={"flex-1 inline-flex items-center justify-center h-5 px-1.5 rounded-sm " +
          "text-[10.5px] font-medium transition-colors " +
          (value === o.v
            ? "bg-slate-100 text-slate-900 shadow-sm"
            : "text-slate-400 hover:text-slate-100")}>
        {o.l}
      </button>
    ))}
  </div>
);
const SectionLabel = ({ children }) => (
  <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 mt-5 mb-2.5 first:mt-0">
    {children}
  </div>
);
// Collapsible section (kept for Effects) — shadcn-flavored heading + chevron.
const Collapsible = ({ title, defaultOpen = true, children }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-slate-800/60 first:border-t-0">
      <button onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between py-3 text-left">
        <div className="text-[12px] font-semibold text-slate-100 tracking-tight">{title}</div>
        <span className={"text-slate-500 text-base leading-none transition-transform duration-150 " +
          (open ? "" : "-rotate-90")}>⌄</span>
      </button>
      {open && <div className="pb-3">{children}</div>}
    </div>
  );
};
// Always-open section header — sits above content, no toggle.
const PanelHeader = ({ title }) => (
  <div className="pt-3 pb-2 border-t border-slate-800/60 first:border-t-0 mt-2 first:mt-0">
    <div className="text-[12px] font-semibold text-slate-100 tracking-tight">{title}</div>
  </div>
);
// shadcn-style compact button (30% smaller than default). Ghost/outline until
// active, uses ring treatment for the active state instead of a color fill.
const Chip = ({ active, onClick, children }) => (
  <button onClick={onClick}
    className={"inline-flex items-center h-5 px-2 rounded text-[10.5px] font-medium " +
      "transition-colors border focus:outline-none focus-visible:ring-1 focus-visible:ring-slate-400 " +
      (active
        ? "bg-slate-100 text-slate-900 border-slate-100"
        : "bg-transparent text-slate-300 border-slate-700 hover:bg-slate-800 hover:text-slate-50")}>
    {children}
  </button>
);
const ChipRow = ({ children }) => (
  <div className="flex flex-wrap gap-1.5 mb-2.5">{children}</div>
);
// Grouped dropdown select — mirrors the modern editor "Mode / Blend" picker:
// current value shown as a pill button, click opens a scrollable panel with
// section headings and a checkmark on the active row.
const DropdownSelect = ({ value, onChange, groups, placeholder = "Select" }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  let currentLabel = placeholder;
  for (const g of groups) for (const item of g.items) if (item.v === value) currentLabel = item.l;
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between h-6 px-2 rounded bg-transparent border border-slate-700 text-slate-100 text-[10.5px] font-medium hover:bg-slate-800 transition-colors">
        <span>{currentLabel}</span>
        <span className={"text-slate-500 text-[10px] leading-none transition-transform duration-150 " + (open ? "rotate-180" : "")}>⌄</span>
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 rounded-md bg-slate-950 border border-slate-800 shadow-xl max-h-72 overflow-y-auto cs-panel py-1">
          {groups.map((g, gi) => (
            <div key={gi}>
              {g.label && (
                <div className="px-2.5 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  {g.label}
                </div>
              )}
              {g.items.map((item) => (
                <button key={item.v}
                  onClick={() => { onChange(item.v); setOpen(false); }}
                  className={"w-full flex items-center gap-2 pl-2 pr-2.5 py-1 text-[10.5px] font-medium text-left hover:bg-slate-800 " +
                    (value === item.v ? "text-white" : "text-slate-300")}>
                  <span className={"w-3 text-[10px] " + (value === item.v ? "text-slate-100" : "text-transparent")}>✓</span>
                  <span>{item.l}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// =========================================================================
//  UTILITIES
// =========================================================================
function download(name, blob) {
  if (!(blob instanceof Blob) || blob.size === 0) {
    alert(`Could not create ${name}. Please try the export again.`);
    return false;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  // Safari can still be reading the object URL after the click handler has
  // returned. Revoking it immediately can leave a downloaded file at 0 bytes.
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 60_000);
  return true;
}
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

// =========================================================================
const DEFAULTS = {
  playing: true, rotSpeed: 0.36, dir: 1, orbitSpeed: 0.4,
  floatAmp: 0.08, floatSpeed: 0.55, tilt: 0,
  orbitR: 2.3, size: 0.54, thick: 0.14, overallScale: 1.27,
  metalness: 0.48, roughness: 0.55,
  light: 1.4, grid: false, autoOrbit: false,
  // Face reflection controls — visibility (opacity) + softness (blur) of the
  // specular highlight the drag light paints on the coin face. Coin texture
  // itself is untouched; only the highlight responds.
  reflectionOpacity: 0.55, reflectionBlur: 0.35,
  rightLightX: 7.9, rightLightY: 7.1, rightLightZ: 10,
  rightLightSoftness: 12,
  bgColor: "#ffffff",
  showRing: false, showShadow: false,
  glow: 0.4, glowRange: 1.71,
  naturalTilt: false, naturalTiltAmount: 0.35, naturalTiltWobble: 0.4,
  perspectiveMode: "perspective", perspectiveIntensity: 0.3,
  scatterEnabled: false, scatterAmount: 0.5,
  coinOrder: "asc",
  easing: "linear", easingStrength: 2,
  coinLayering: "auto",
  // Post-processing (CSS + tone-mapping based — no shader pipeline needed)
  toneMap: "none", toneExposure: 1, stylePreset: "none",
  fxBlur: 0, fxGrain: 0, fxVignette: 0, fxSaturation: 1, fxContrast: 1, fxBloom: 0,
  fxHue: 0,
  transparentBg: false,
  exportDuration: 5, exportFps: 30, exportBitrate: 60, exportGifQuality: 10,
  exportPreset: "square4k",
  exportWidth: 4096, exportHeight: 4096,
  showExportFrame: true,
};

const EXPORT_PRESETS = {
  viewport:  { label: "Viewport" },
  square1080:{ label: "Square · 1080 × 1080", w: 1080, h: 1080 },
  square1440:{ label: "Square · 1440 × 1440", w: 1440, h: 1440 },
  square2k:  { label: "Square · 2K (2048 × 2048)", w: 2048, h: 2048 },
  square4k:  { label: "Square · 4K (4096 × 4096)", w: 4096, h: 4096 },
  landscape: { label: "16:9 · 1920×1080", w: 1920, h: 1080 },
  portrait:  { label: "9:16 · 1080×1920", w: 1080, h: 1920 },
  wide:      { label: "21:9 · 2560×1080", w: 2560, h: 1080 },
  hd:        { label: "720p · 1280×720",  w: 1280, h: 720  },
  custom:    { label: "Custom" },
};

export default function CoinStudio() {
  const mountRef = useRef(null);
  const stageRef = useRef(null);
  const draggingLightRef = useRef(false);
  const api = useRef(null);
  const settings = useRef({ ...DEFAULTS });
  const [ui, setUi] = useState({ ...DEFAULTS });
  const [draggingLight, setDraggingLight] = useState(false);
  const [stageSize, setStageSize] = useState({ w: 800, h: 600 });

  // Track the stage's live size so the export frame can render at its true
  // proportional size (small dims → small frame) instead of always filling 94%.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setStageSize({ w: r.width, h: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const set = useCallback((patch) => {
    setUi((p) => { const n = { ...p, ...patch }; settings.current = n; return n; });
  }, []);

  // The stage light control maps its on-screen position directly to the
  // softbox's horizontal and vertical world coordinates.
  const moveStageLight = useCallback((event) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    set({
      rightLightX: (x - 0.5) * 20,
      rightLightY: (0.5 - y) * 20,
    });
  }, [set]);

  const beginStageLightDrag = useCallback((event) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingLightRef.current = true;
    setDraggingLight(true);
    moveStageLight(event);
  }, [moveStageLight]);

  // Listen on the window as well as the handle. This keeps the controller
  // responsive when a drag crosses the canvas or leaves the source circle.
  useEffect(() => {
    const move = (event) => {
      if (draggingLightRef.current) moveStageLight(event);
    };
    const end = () => {
      if (!draggingLightRef.current) return;
      draggingLightRef.current = false;
      setDraggingLight(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("mousemove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("mouseup", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("mouseup", end);
    };
  }, [moveStageLight]);

  // Frame-resize state — dragging an edge/corner of the export overlay writes
  // exportWidth/exportHeight directly (auto-switching preset to "custom").
  const frameDragRef = useRef(null);
  useEffect(() => {
    const move = (e) => {
      const d = frameDragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      // Convert cursor CSS pixels back to export pixels via the frame's live
      // display scale at drag start. Frame is centered, so 1px cursor movement
      // = 2px change in export dimension.
      let w = d.startW, h = d.startH;
      if (d.edge.includes("e")) w = d.startW + 2 * dx / d.displayScale;
      if (d.edge.includes("w")) w = d.startW - 2 * dx / d.displayScale;
      if (d.edge.includes("s")) h = d.startH + 2 * dy / d.displayScale;
      if (d.edge.includes("n")) h = d.startH - 2 * dy / d.displayScale;
      w = Math.max(128, Math.min(4096, Math.round(w)));
      h = Math.max(128, Math.min(4096, Math.round(h)));
      set({ exportWidth: w, exportHeight: h });
    };
    const end = () => { frameDragRef.current = null; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [set]);

  const beginFrameResize = useCallback((edge) => (event) => {
    event.preventDefault();
    event.stopPropagation();
    const s = settings.current;
    const preset = EXPORT_PRESETS[s.exportPreset];
    const startW = (preset && preset.w) || s.exportWidth;
    const startH = (preset && preset.h) || s.exportHeight;
    // Same fit math the overlay uses — keeps cursor movement matched to the
    // frame's visible edge throughout the drag.
    const displayScale = Math.min(
      (stageSize.w * 0.94) / startW,
      (stageSize.h * 0.94) / startH
    );
    set({ exportPreset: "custom", exportWidth: startW, exportHeight: startH });
    frameDragRef.current = {
      edge,
      startX: event.clientX,
      startY: event.clientY,
      startW, startH,
      displayScale: Math.max(0.001, displayScale),
    };
    if (event.currentTarget.setPointerCapture) {
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
    }
  }, [set, stageSize]);

  // Coin list — this is the source of truth.  Each entry is a "spec".
  const [coins, setCoins] = useState(createDefaultCoins);

  const addCoin = useCallback(() => {
    setCoins((cs) => [...cs, createDefaultCoin(cs.length)]);
  }, []);
  const removeCoin = useCallback((key) => {
    setCoins((cs) => (cs.length > 1 ? cs.filter((c) => c.key !== key) : cs));
  }, []);
  const dupCoin = useCallback((key) => {
    setCoins((cs) => {
      const src = cs.find((c) => c.key === key);
      if (!src) return cs;
      return [...cs, { ...src, key: newId(), phase: src.phase + 0.7 }];
    });
  }, []);
  const setCoinCount = useCallback((n) => {
    n = Math.max(1, Math.min(64, Math.floor(n) || 1));
    setCoins((cs) => {
      if (n === cs.length) return cs;
      if (n < cs.length) return cs.slice(0, n);
      const add = [];
      for (let i = cs.length; i < n; i++) {
        add.push(createDefaultCoin(i));
      }
      return [...cs, ...add];
    });
  }, []);

  const uploadFace = useCallback((key, side, file) => {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      setCoins((cs) => cs.map((c) => (c.key === key ? { ...c, [side]: r.result } : c)));
    };
    r.readAsDataURL(file);
  }, []);

  const reset = useCallback(() => {
    settings.current = { ...DEFAULTS };
    setUi({ ...DEFAULTS });
    setCoins(createDefaultCoins());
    api.current && api.current.resetOrbit();
  }, []);

  // -------------------------------------------------------------------- SCENE
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    // set after renderer exists (below)
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    camera.position.set(0, 0, 13);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({
      antialias: true, alpha: true, preserveDrawingBuffer: true,
      premultipliedAlpha: false,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.setClearColor(new THREE.Color(DEFAULTS.bgColor), 1);
    RectAreaLightUniformsLib.init();
    const pmrem = new THREE.PMREMGenerator(renderer);
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.cursor = "grab";

    // The face artwork carries its own stable natural brightness. The
    // draggable softbox below is the only dynamic scene light.
    // Studio HDR-style environment — this is the primary source of soft light
    // on the coin faces. Higher sigma (blur) gives a wrap-around ambient.
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.25).texture;
    // Draggable key softbox — huge emitter and lower peak intensity so
    // Lambertian shading spreads over a broad gradient instead of a hard wedge.
    const rightSoftbox = new THREE.RectAreaLight(0xfff4dc, 4, 22, 22);
    rightSoftbox.position.set(8, 7, 10);
    rightSoftbox.lookAt(0, 0, 0);
    scene.add(rightSoftbox);
    // Wrap fills (sky + warm floor) — strong enough to lift the shadow side so
    // the transition on tilted coins reads smooth, not clipped.
    const fill = new THREE.HemisphereLight(0xf5f2ff, 0xfff3e0, 1.4);
    scene.add(fill);
    // Rim / kicker from opposite side — subtle backlight that separates coin
    // silhouettes from the background, standard 3-point studio move.
    const rim = new THREE.DirectionalLight(0xffffff, 0.35);
    rim.position.set(-6, 4, -4);
    scene.add(rim);

    const world = new THREE.Group();
    scene.add(world);

    // Visible orbit ring — a thin flat disc-ring the coins travel along.
    const ringGeo = new THREE.RingGeometry(0.985, 1.0, 192);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x6366f1, side: THREE.DoubleSide, transparent: true, opacity: 0.5,
    });
    const orbitRing = new THREE.Mesh(ringGeo, ringMat);
    world.add(orbitRing);

    const shadowMap = shadowTex();
    const haloMap = haloTex();
    const registry = new Map(); // key -> entry
    let currentList = [];


    const buildEntry = (spec) => {
      const pal = PALETTES[spec.palette] || PALETTES.sage;
      const built = buildCoinMeshes(pal);
      const spin = new THREE.Group(); spin.add(built.coin);
      const tilt = new THREE.Group(); tilt.add(spin);
      tilt.rotation.x = 0.14;
      const floatG = new THREE.Group(); floatG.add(tilt);
      // halo — sits just behind the coin, additive blend for a natural glow
      const haloMat = new THREE.SpriteMaterial({
        map: haloMap, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, opacity: 0.4,
      });
      const halo = new THREE.Sprite(haloMat);
      halo.position.set(0, 0, -0.35);
      halo.scale.setScalar(3);
      floatG.add(halo);
      const shadow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: shadowMap, transparent: true, depthWrite: false,
      }));
      shadow.scale.set(2.4, 0.9, 1);
      shadow.position.set(0, -1.35, -0.6);
      floatG.add(shadow);
      world.add(floatG);
      // Per-coin random data drives Perspective mode (each coin tumbles on its
      // own axis at its own speed) and the scatter offsets for the ring.
      const axis = new THREE.Vector3(
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
        Math.random() * 2 - 1
      );
      if (axis.lengthSq() < 1e-4) axis.set(0, 1, 0);
      axis.normalize();
      return {
        floatG, tilt, spin,
        coin: built.coin, body: built.body,
        faceFront: built.faceFront, faceBack: built.faceBack,
        bevelA: built.bevelA, bevelB: built.bevelB,
        faceMats: built.faceMats, edgeMat: built.edgeMat,
        halo, haloMat, shadow,
        phase: spec.phase, angle: 0,
        applied: { front: null, back: null },
        rimColors: { a: pal.edge[0], b: pal.edge[1] },
        flipAxis: axis,
        flipSpeed: 0.5 + Math.random() * 1.8,
        flipPhase: Math.random() * Math.PI * 2,
        scatterAngle: (Math.random() * 2 - 1),
        scatterRadius: (Math.random() * 2 - 1) * 0.5,
        angleOffset: spec.angleOffset || 0,
      };
    };

    const disposeEntry = (entry) => {
      world.remove(entry.floatG);
      entry.coin.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach((m) => {
            if (m.map) m.map.dispose && m.map.dispose();
            if (m.normalMap) m.normalMap.dispose && m.normalMap.dispose();
            m.dispose && m.dispose();
          });
        }
      });
    };

    const refreshRim = (entry) => {
      const { a, b } = entry.rimColors;
      const newMap = edgeTex(a, b);
      if (entry.edgeMat.map && entry.edgeMat.map.dispose) entry.edgeMat.map.dispose();
      entry.edgeMat.map = newMap;
      entry.edgeMat.needsUpdate = true;
    };

    const applyFace = (entry, side, dataUrl) => {
      if (!dataUrl) return;
      if (entry.applied[side] === dataUrl) return;
      entry.applied[side] = dataUrl;
      const idx = side === "front" ? 0 : 1;
      imageFaceTex(dataUrl)
        .then((t) => {
          const m = entry.faceMats[idx];
          if (m.map && m.map.dispose) m.map.dispose();
          m.map = t;
          m.emissiveMap = t;
          m.needsUpdate = true;
        })
        .catch(() => { /* palette fallback */ });
      // Blend the rim colour with the uploaded image (front → top band, back → bottom band).
      averageColor(dataUrl)
        .then((col) => {
          entry.rimColors[side === "front" ? "a" : "b"] = col;
          refreshRim(entry);
        })
        .catch(() => {});
    };

    const syncCoins = (specs) => {
      const keep = new Set(specs.map((s) => s.key));
      for (const [k, e] of registry) {
        if (!keep.has(k)) { disposeEntry(e); registry.delete(k); }
      }
      specs.forEach((s) => {
        if (!registry.has(s.key)) registry.set(s.key, buildEntry(s));
        const e = registry.get(s.key);
        e.phase = s.phase;
        e.angleOffset = s.angleOffset || 0;
        applyFace(e, "front", s.front);
        applyFace(e, "back", s.back);
      });
      currentList = specs;
    };

    // pointer / orbit
    let oY = 0, oX = 0, tY = 0, tX = 0, drag = false, px = 0, py = 0;
    const dom = renderer.domElement;
    const down = (e) => { drag = true; px = e.clientX; py = e.clientY; dom.style.cursor = "grabbing"; };
    const move = (e) => {
      if (!drag) return;
      tY += (e.clientX - px) * 0.006;
      tX += (e.clientY - py) * 0.004;
      tX = Math.max(-0.45, Math.min(0.45, tX));
      tY = Math.max(-0.9, Math.min(0.9, tY));
      px = e.clientX; py = e.clientY;
    };
    const up = () => { drag = false; dom.style.cursor = "grab"; };
    dom.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);

    // Export override — while active, fitCamera and resize use these dims
    // and the on-screen canvas is temporarily forced to the target resolution.
    const exportOverride = { active: false, w: 0, h: 0, prevRatio: 1 };

    const fitCamera = () => {
      const w = exportOverride.active ? exportOverride.w : mount.clientWidth;
      const h = exportOverride.active ? exportOverride.h : mount.clientHeight;
      if (!w || !h) return;
      const aspect = w / h;
      const s = settings.current;
      // Fit for the ring at scale=1 so the user's `overallScale` genuinely
      // zooms in/out (previously the camera pulled back proportional to
      // overallScale, cancelling the zoom above ~0.7).
      const outer = s.orbitR + s.size;
      const R = outer * 1.5;
      const fovR = camera.fov * Math.PI / 180;
      const distV = R / Math.tan(fovR / 2);
      const distH = R / (Math.tan(fovR / 2) * aspect);
      camera.position.z = Math.max(distV, distH, 4);
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    };
    const resize = () => {
      if (exportOverride.active) return; // don't fight the export sizing
      const w = mount.clientWidth, h = mount.clientHeight;
      if (!w || !h) return;
      // Keep the canvas's CSS dimensions in sync with the stage. With
      // `updateStyle` disabled, the high-DPI drawing buffer became the layout
      // size as well, which clipped the orbit to the top-left of the stage.
      renderer.setSize(w, h);
      fitCamera();
    };
    const ro = new ResizeObserver(resize); ro.observe(mount); resize();

    const clock = new THREE.Clock();
    let ft = 0, raf;
    const tick = () => {
      const s = settings.current;
      const dt = Math.min(clock.getDelta(), 0.05);
      if (s.playing) ft += dt;

      fitCamera();
      const bgAlpha = s.transparentBg ? 0 : 1;
      if (s.bgColor) renderer.setClearColor(new THREE.Color(s.bgColor), bgAlpha);
      // Tonemap + exposure — real three.js knobs, changes bake into the render.
      const tmMap = {
        none:     THREE.NoToneMapping,
        linear:   THREE.LinearToneMapping,
        reinhard: THREE.ReinhardToneMapping,
        cineon:   THREE.CineonToneMapping,
        aces:     THREE.ACESFilmicToneMapping,
        agx:      THREE.AgXToneMapping ?? THREE.ACESFilmicToneMapping,
      };
      const tm = tmMap[s.toneMap] ?? THREE.ACESFilmicToneMapping;
      if (renderer.toneMapping !== tm) renderer.toneMapping = tm;
      renderer.toneMappingExposure = s.toneExposure;

      // Depth 0 turns off only the optional drag-light overlay; the neutral
      // studio base remains visible underneath.
      const dragLightOn = s.rightLightZ > 0;
      // The visible Intensity control adjusts only the draggable softbox.
      // The face base remains stable even when the coin is tilted.
      // Lower intensity coefficient (studio softbox is broad, not punchy).
      rightSoftbox.intensity = dragLightOn ? 1.1 * s.light : 0;
      rightSoftbox.position.set(s.rightLightX, s.rightLightY, s.rightLightZ);
      // Really large emitter — a big softbox at close range gives that
      // wrap-around, gradient studio look instead of a directional wedge.
      rightSoftbox.width = s.rightLightSoftness * 3.5;
      rightSoftbox.height = s.rightLightSoftness * 3.5;
      rightSoftbox.lookAt(0, 0, 0);

      const N = currentList.length;
      const perspective = s.perspectiveMode === "perspective";
      currentList.forEach((spec, i) => {
        const entry = registry.get(spec.key);
        if (!entry) return;
        if (s.playing) {
          entry.angle += dt * s.rotSpeed * s.dir;
        }
        if (perspective) {
          // Each coin tumbles on its own random axis; intensity scales the
          // continuous flip speed so 0 freezes the pose and 1 tumbles fast.
          const flipAngle =
            entry.flipPhase + ft * entry.flipSpeed * s.dir * s.perspectiveIntensity * 2
            + entry.angle;
          entry.spin.quaternion.setFromAxisAngle(entry.flipAxis, flipAngle);
        } else {
          // Rotate around the face-normal (Z after coin.rotation.x = π/2) so
          // the design spins in-plane and the face stays toward the camera.
          entry.spin.rotation.set(0, 0, entry.angle);
        }
        const scatterA = s.scatterEnabled ? entry.scatterAngle * s.scatterAmount * 1.6 : 0;
        const scatterR = s.scatterEnabled ? entry.scatterRadius * s.scatterAmount * s.orbitR : 0;
        const orderIdx = s.coinOrder === "desc" ? (N - 1 - i) : i;
        // Normalized loop parameter — same value drives circle angle and
        // curve parameter, so easing behaves the same across modes.
        const rawT = (
          (orderIdx / N)
          + (ft * s.orbitSpeed * s.dir) / (Math.PI * 2)
          + (scatterA + (entry.angleOffset || 0)) / (Math.PI * 2)
        );
        let tParam = rawT - Math.floor(rawT);
        const et = easeFn(tParam, s.easing, s.easingStrength);
        const radius = s.orbitR + scatterR;
        const orbitA = et * Math.PI * 2 - Math.PI / 2;
        entry.floatG.position.x = Math.cos(orbitA) * radius;
        entry.floatG.position.y = Math.sin(orbitA) * radius
          + Math.sin(ft * s.floatSpeed + entry.phase) * s.floatAmp;
        // Coin layering: nudge each coin's Z so overlapping neighbours don't
        // cut through each other. "first" = index 0 on top; "last" = last on
        // top; "auto" defers to real 3D depth (behaviour before this control).
        if (s.coinLayering === "first") {
          entry.floatG.position.z = (N - 1 - i) * 0.02;
        } else if (s.coinLayering === "last") {
          entry.floatG.position.z = i * 0.02;
        } else {
          entry.floatG.position.z = 0;
        }
        entry.tilt.rotation.x = 0.14 + s.tilt;
        entry.floatG.scale.setScalar(s.size);
        // Dynamic thickness — scale the cylinder in local Y and shift the
        // bevel rings so they hug the new rim edges.
        const yScale = s.thick / BASE_THICK;
        entry.body.scale.y = yScale;
        // Keep both artwork caps attached to the resized rim. Previously only
        // the rim and bevels moved with Thickness, leaving a visible seam
        // between the edge and the front/back faces at larger thicknesses.
        entry.faceFront.position.y = s.thick / 2 + 0.0001;
        entry.faceBack.position.y = -s.thick / 2 - 0.0001;
        entry.bevelA.position.y = s.thick / 2;
        entry.bevelB.position.y = -s.thick / 2;
        // Halo stays neutral and remains part of the base studio presentation.
        entry.halo.scale.setScalar(3 * s.glowRange);
        entry.haloMat.opacity = s.glow;
        entry.haloMat.color.setRGB(1, 1, 1);
        entry.shadow.visible = !!s.showShadow;
        entry.edgeMat.metalness = s.metalness;
        entry.edgeMat.roughness = s.roughness;
        // Reflection Opacity → face metalness (brighter specular highlight).
        // Reflection Blur → roughness (0.2 sharp glint … 1.0 fully diffuse).
        // Emissive is fixed so the coin artwork itself never changes brightness
        // — only the highlight/reflection responds to the sliders.
        const refl = Math.max(0, Math.min(1, s.reflectionOpacity ?? 0));
        const blur = Math.max(0, Math.min(1, s.reflectionBlur ?? 0));
        entry.faceMats.forEach((m) => {
          m.metalness = refl * 0.7;
          m.roughness = 0.2 + blur * 0.8;
          m.envMapIntensity = 0.6 + refl * 0.8;
          m.emissiveIntensity = 0.85;
        });
      });

      orbitRing.visible = !!s.showRing;
      orbitRing.scale.setScalar(s.orbitR);

      if (s.autoOrbit && s.playing) tY += dt * 0.15;
      oY += (tY - oY) * 0.08; oX += (tX - oX) * 0.08;
      world.rotation.y = oY; world.rotation.x = oX;
      world.scale.setScalar(s.overallScale);

      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    api.current = {
      resetOrbit: () => { tY = 0; tX = 0; },
      sync: (specs) => syncCoins(specs),
      snapshotPng: () => {
        renderer.render(scene, camera);
        return renderer.domElement.toDataURL("image/png");
      },
      getCanvas: () => renderer.domElement,
      beginExport: (w, h) => {
        exportOverride.prevRatio = renderer.getPixelRatio();
        exportOverride.active = true;
        exportOverride.w = w;
        exportOverride.h = h;
        renderer.setPixelRatio(1);
        renderer.setSize(w, h, false);
        // Make the on-screen canvas display the true pixels while exporting
        // so the user can see the framing.
        renderer.domElement.style.width = "100%";
        renderer.domElement.style.height = "100%";
        renderer.domElement.style.objectFit = "contain";
        fitCamera();
      },
      endExport: () => {
        exportOverride.active = false;
        renderer.setPixelRatio(exportOverride.prevRatio || Math.min(window.devicePixelRatio, 2));
        renderer.domElement.style.width = "";
        renderer.domElement.style.height = "";
        renderer.domElement.style.objectFit = "";
        resize();
      },
    };

    return () => {
      cancelAnimationFrame(raf); ro.disconnect();
      dom.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      for (const e of registry.values()) disposeEntry(e);
      registry.clear();
      pmrem.dispose();
      renderer.dispose();
      if (dom.parentNode) dom.parentNode.removeChild(dom);
    };
  }, []);

  // Push coin-list changes to the scene
  useEffect(() => {
    if (api.current) api.current.sync(coins);
  }, [coins]);


  // -------------------------------------------------------------------- EXPORT
  const exportJSON = () => {
    const data = { settings: settings.current, coins };
    download(
      "coin-studio.json",
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
    );
  };
  // Resolve the current export dimensions from preset/custom settings.
  const exportDims = () => {
    const s = settings.current;
    if (s.exportPreset === "viewport") {
      const el = mountRef.current;
      return { w: (el && el.clientWidth) || 1280, h: (el && el.clientHeight) || 720 };
    }
    const preset = EXPORT_PRESETS[s.exportPreset];
    if (preset && preset.w) return { w: preset.w, h: preset.h };
    return { w: s.exportWidth, h: s.exportHeight };
  };

  const exportPNG = async () => {
    if (!api.current) return;
    api.current.resetOrbit();
    const { w, h } = exportDims();
    api.current.beginExport(w, h);
    await new Promise((r) => setTimeout(r, 350));
    const url = api.current.snapshotPng();
    api.current.endExport();
    fetch(url).then((r) => r.blob()).then((b) => download("coin-studio.png", b));
  };
  const [recording, setRecording] = useState(null);
  // Shared recorder — the only difference between the WebM and MP4 exports is
  // the mime candidate list and the file extension.
  const recordVideo = async (fmt) => {
    if (!api.current || recording) return;
    const candidates = fmt === "mp4"
      ? ["video/mp4;codecs=avc1.42E01E", "video/mp4;codecs=h264", "video/mp4"]
      : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    const mime = candidates.find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) {
      alert(fmt === "mp4"
        ? "This browser can't record MP4 directly. Use Chrome/Safari, or export WebM and convert with ffmpeg."
        : "This browser doesn't support WebM recording.");
      return;
    }
    const s = settings.current;
    api.current.resetOrbit();
    const { w, h } = exportDims();
    api.current.beginExport(w, h);
    await new Promise((r) => setTimeout(r, 350));
    const canvasEl = api.current.getCanvas();
    const stream = canvasEl.captureStream(s.exportFps);
    let rec;
    try {
      rec = new MediaRecorder(stream, {
        mimeType: mime,
        videoBitsPerSecond: Math.round(s.exportBitrate * 1_000_000),
      });
    } catch (error) {
      api.current.endExport();
      alert(`Could not start ${fmt.toUpperCase()} recording in this browser.`);
      return;
    }
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      api.current.endExport();
      stream.getTracks().forEach((track) => track.stop());
      const video = new Blob(chunks, { type: mime });
      if (video.size === 0) {
        alert(fmt === "mp4"
          ? "Your browser could not encode this MP4. Export WebM, then convert it to MP4, or try Safari."
          : "Your browser could not encode this WebM. Please try again.");
      } else {
        download(`coin-studio.${fmt}`, video);
      }
      setRecording(null);
    };
    rec.onerror = () => {
      if (rec.state !== "inactive") rec.stop();
    };
    setRecording(fmt);
    // Request periodic chunks so browsers do not depend on one final chunk at
    // stop time (a common source of empty MP4 downloads).
    rec.start(1_000);
    setTimeout(() => rec.stop(), Math.max(500, s.exportDuration * 1000));
  };
  const exportWebM = () => recordVideo("webm");
  const exportMP4 = async () => {
    if (!api.current || recording) return;

    // MediaRecorder advertises MP4 support in some Chromium builds, but then
    // emits no data from a canvas stream. WebCodecs gives us the actual H.264
    // encoder and mp4-muxer packages the frames into a standards-compliant MP4.
    if (!("VideoEncoder" in window) || !("VideoFrame" in window)) {
      recordVideo("mp4");
      return;
    }

    const s = settings.current;
    api.current.resetOrbit();
    const { w, h } = exportDims();
    api.current.beginExport(w, h);
    setRecording("mp4");

    try {
      await new Promise((resolve) => setTimeout(resolve, 350));
      const canvasEl = api.current.getCanvas();
      const bitrate = Math.round(s.exportBitrate * 1_000_000);
      const encoderOptions = ["avc1.640034", "avc1.4D0034", "avc1.42E034", "avc1.420034"];
      let config = null;

      for (const codec of encoderOptions) {
        const candidate = { codec, width: w, height: h, bitrate, framerate: s.exportFps };
        try {
          const support = await VideoEncoder.isConfigSupported(candidate);
          if (support.supported) {
            config = candidate;
            break;
          }
        } catch {
          // Try the next H.264 profile supported by this browser/device.
        }
      }

      if (!config) throw new Error("No supported H.264 encoder configuration");

      const target = new ArrayBufferTarget();
      const muxer = new Muxer({
        target,
        video: { codec: "avc", width: w, height: h, frameRate: s.exportFps },
        fastStart: "in-memory",
      });
      let encoderError = null;
      const encoder = new VideoEncoder({
        output: (chunk, metadata) => muxer.addVideoChunk(chunk, metadata),
        error: (error) => { encoderError = error; },
      });
      encoder.configure(config);

      const totalFrames = Math.max(1, Math.round(s.exportDuration * s.exportFps));
      const frameDuration = Math.round(1_000_000 / s.exportFps);
      const startedAt = performance.now();

      for (let i = 0; i < totalFrames; i += 1) {
        if (encoderError) throw encoderError;
        const frame = new VideoFrame(canvasEl, {
          timestamp: i * frameDuration,
          duration: frameDuration,
        });
        encoder.encode(frame, { keyFrame: i === 0 || i % (s.exportFps * 2) === 0 });
        frame.close();
        // Avoid queueing dozens of 4K frames if the hardware encoder is slower
        // than the requested frame rate.
        if (encoder.encodeQueueSize > 2) await encoder.flush();

        const nextFrameAt = startedAt + ((i + 1) * 1_000) / s.exportFps;
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, nextFrameAt - performance.now())));
      }

      await encoder.flush();
      if (encoderError) throw encoderError;
      encoder.close();
      muxer.finalize();
      download("coin-studio.mp4", new Blob([target.buffer], { type: "video/mp4" }));
    } catch (error) {
      console.error("MP4 export failed", error);
      alert("Could not create an H.264 MP4 on this device. Try a smaller export size, then export again.");
    } finally {
      api.current.endExport();
      setRecording(null);
    }
  };
  const [gifting, setGifting] = useState(false);
  const exportGIF = async () => {
    if (!api.current || gifting) return;
    setGifting(true);
    const s = settings.current;
    const useTransparent = s.transparentBg;
    // Bright magenta as the color key — unlikely to appear in coin content, so
    // only true-empty pixels get flagged transparent (no accidental holes).
    const GIF_KEY_HEX = 0xff00ff;
    const GIF_KEY_CSS = "#ff00ff";
    const origBg = s.bgColor;
    if (useTransparent) settings.current.bgColor = GIF_KEY_CSS;
    try {
      await loadScript("https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.js");
      api.current.resetOrbit();
      const { w, h } = exportDims();
      api.current.beginExport(w, h);
      await new Promise((r) => setTimeout(r, 350));
      const canvasEl = api.current.getCanvas();
      const gif = new window.GIF({
        workers: 2,
        quality: s.exportGifQuality,
        width: canvasEl.width,
        height: canvasEl.height,
        transparent: useTransparent ? GIF_KEY_HEX : null,
        workerScript: "https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js",
      });
      const totalFrames = Math.max(4, Math.round(s.exportDuration * s.exportFps));
      const delay = Math.max(20, Math.round(1000 / s.exportFps));
      for (let i = 0; i < totalFrames; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        gif.addFrame(canvasEl, { copy: true, delay });
      }
      gif.on("finished", (blob) => {
        api.current && api.current.endExport();
        if (useTransparent) settings.current.bgColor = origBg;
        download("coin-studio.gif", blob);
        setGifting(false);
      });
      gif.render();
    } catch (e) {
      alert("GIF export failed to load gif.js — check network.");
      api.current && api.current.endExport();
      if (useTransparent) settings.current.bgColor = origBg;
      setGifting(false);
    }
  };

  // Post-processing effect application — driven by CSS filter on the canvas
  // and overlay layers on the stage (grain SVG noise + vignette radial mask).
  const canvasFilter = [
    ui.fxBlur > 0 ? `blur(${ui.fxBlur.toFixed(2)}px)` : null,
    ui.fxSaturation !== 1 ? `saturate(${ui.fxSaturation.toFixed(2)})` : null,
    ui.fxContrast !== 1 ? `contrast(${ui.fxContrast.toFixed(2)})` : null,
    ui.fxHue !== 0 ? `hue-rotate(${ui.fxHue}deg)` : null,
    ui.fxBloom > 0 ? `drop-shadow(0 0 ${(ui.fxBloom * 20).toFixed(1)}px rgba(255,240,220,${(ui.fxBloom * 0.6).toFixed(2)}))` : null,
  ].filter(Boolean).join(" ");

  // Style presets — bundle several post-processing values for one-tap looks.
  const applyStyle = (preset) => {
    const p = {
      none:  { fxBlur: 0, fxGrain: 0, fxVignette: 0, fxSaturation: 1, fxContrast: 1, fxBloom: 0, fxHue: 0 },
      glow:  { fxBloom: 0.6, fxSaturation: 1.1, fxContrast: 1.05, fxVignette: 0.15 },
      haze:  { fxBlur: 0.6, fxBloom: 0.3, fxSaturation: 0.85, fxContrast: 0.95, fxGrain: 0.1 },
      aura:  { fxBloom: 0.9, fxSaturation: 1.2, fxContrast: 1.08, fxVignette: 0.25 },
      deep:  { fxContrast: 1.25, fxSaturation: 1.1, fxVignette: 0.5, fxGrain: 0.06 },
      shadow:{ fxContrast: 1.35, fxSaturation: 0.9, fxVignette: 0.65 },
      rich:  { fxSaturation: 1.35, fxContrast: 1.1, fxBloom: 0.25, fxVignette: 0.2 },
      punch: { fxSaturation: 1.5, fxContrast: 1.3, fxBloom: 0.15 },
      silk:  { fxBlur: 0.3, fxSaturation: 1.05, fxContrast: 0.98, fxBloom: 0.35 },
      vivid: { fxSaturation: 1.6, fxContrast: 1.15, fxBloom: 0.2 },
      neon:  { fxSaturation: 1.5, fxBloom: 0.9, fxContrast: 1.15, fxHue: 8 },
      vhs:   { fxGrain: 0.35, fxContrast: 1.1, fxSaturation: 1.15, fxHue: -6 },
      film:  { fxGrain: 0.25, fxContrast: 1.15, fxSaturation: 0.95, fxVignette: 0.35 },
      dream: { fxBlur: 0.8, fxBloom: 0.5, fxSaturation: 1.05, fxVignette: 0.1 },
    }[preset] || {};
    set({ ...p, stylePreset: preset });
  };

  // -------------------------------------------------------------------- STYLE
  const gridStyle = ui.grid
    ? {
        backgroundImage: "radial-gradient(rgba(99,102,241,0.18) 1px, transparent 1px)",
        backgroundSize: "20px 20px",
        backgroundPosition: "center",
        WebkitMaskImage: "radial-gradient(32% 32% at 50% 50%, #000 0%, transparent 78%)",
        maskImage: "radial-gradient(32% 32% at 50% 50%, #000 0%, transparent 78%)",
      }
    : {};

  return (
    <div className="cs-root w-full h-screen flex bg-slate-950 text-slate-100 overflow-hidden">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500&display=swap');
        .cs-root, .cs-root * { font-family: 'Geist', ui-sans-serif, system-ui, -apple-system, sans-serif; font-weight:400; }
        /* Weight discipline: only 400 (regular) and 500 (medium) — no bolds. */
        .cs-root .font-medium, .cs-root .font-semibold, .cs-root .font-bold, .cs-root b, .cs-root strong { font-weight:500; }
        /* Minimal pill-fill slider — neutrals only */
        .cs-slider{-webkit-appearance:none;appearance:none;width:100%;height:10px;border-radius:9999px;
          background:linear-gradient(to right,#64748b var(--pct),rgba(30,41,59,0.85) var(--pct));
          outline:none;cursor:ew-resize;transition:filter .15s;
          box-shadow:inset 0 1px 2px rgba(0,0,0,0.35);}
        .cs-slider:hover{filter:brightness(1.15);}
        .cs-slider:active{filter:brightness(1.25);}
        .cs-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:2px;height:10px;
          background:transparent;border:0;cursor:ew-resize;}
        .cs-slider::-moz-range-thumb{width:2px;height:10px;background:transparent;border:0;cursor:ew-resize;}
        .cs-switch{position:relative;width:36px;height:20px;border-radius:9999px;transition:background .2s;flex:none;}
        .cs-switch-on{background:#94a3b8;}
        .cs-switch-off{background:#334155;}
        .cs-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:9999px;background:#fff;
          transition:transform .2s;box-shadow:0 1px 3px rgba(0,0,0,.4);}
        .cs-switch-on .cs-knob{transform:translateX(16px);}
        .cs-panel::-webkit-scrollbar{width:6px;}
        .cs-panel::-webkit-scrollbar-thumb{background:#1e293b;border-radius:9999px;}
        .cs-panel::-webkit-scrollbar-thumb:hover{background:#334155;}
        .cs-panel::-webkit-scrollbar-track{background:transparent;}
      `}</style>

      {/* CONTROL PANEL */}
      <aside className="w-[300px] flex-none h-full border-r border-slate-800 bg-slate-900/80 backdrop-blur flex flex-col">
        <div className="px-4 py-3 border-b border-slate-800 flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-gradient-to-br from-indigo-400 to-violet-600 flex items-center justify-center text-[11px] font-bold">◈</div>
          <div>
            <h1 className="text-[14px] font-semibold leading-tight">Coin Studio</h1>
            <p className="text-[10px] text-slate-500 leading-tight">Circular hero · 3D animator</p>
          </div>
        </div>

        <div className="cs-panel flex-1 overflow-y-auto px-4 py-3">
          <PanelHeader title="Style presets" />
          <div className="mb-4">
            <DropdownSelect
              value={ui.stylePreset}
              onChange={(v) => applyStyle(v)}
              groups={[
                { label: "Base", items: [{ v: "none", l: "None" }] },
                { label: "Soft", items: [
                  { v: "glow",  l: "Glow" },
                  { v: "haze",  l: "Haze" },
                  { v: "silk",  l: "Silk" },
                  { v: "dream", l: "Dream" },
                ]},
                { label: "Bold", items: [
                  { v: "punch", l: "Punch" },
                  { v: "vivid", l: "Vivid" },
                  { v: "rich",  l: "Rich" },
                  { v: "neon",  l: "Neon" },
                  { v: "aura",  l: "Aura" },
                ]},
                { label: "Cinematic", items: [
                  { v: "deep",   l: "Deep" },
                  { v: "shadow", l: "Shadow" },
                  { v: "film",   l: "Film" },
                  { v: "vhs",    l: "VHS" },
                ]},
              ]}
            />
          </div>

          <PanelHeader title="Tonemap" />
          <div className="mb-3">
            <DropdownSelect
              value={ui.toneMap}
              onChange={(v) => set({ toneMap: v })}
              groups={[
                { label: "Cinematic", items: [
                  { v: "aces",   l: "ACES (Cinematic)" },
                  { v: "cineon", l: "Filmic (S-Curve)" },
                ]},
                { label: "Soft", items: [
                  { v: "reinhard", l: "Reinhard (Soft)" },
                  { v: "agx",      l: "AgX (Neutral)" },
                ]},
                { label: "Direct", items: [
                  { v: "linear", l: "Linear" },
                  { v: "none",   l: "None" },
                ]},
              ]}
            />
          </div>
          <Row label="Exposure" value={ui.toneExposure.toFixed(2)}>
            <Slider min={0.2} max={3} step={0.01} value={ui.toneExposure}
              onChange={(v) => set({ toneExposure: v })} />
          </Row>

          <Collapsible
            title="Effects"
            defaultOpen={false}
          >
            <Row label="Blur" value={ui.fxBlur.toFixed(1)} unit="px">
              <Slider min={0} max={8} step={0.1} value={ui.fxBlur}
                onChange={(v) => set({ fxBlur: v })} />
            </Row>
            <Row label="Grain" value={Math.round(ui.fxGrain * 100)} unit="%">
              <Slider min={0} max={1} step={0.01} value={ui.fxGrain}
                onChange={(v) => set({ fxGrain: v })} />
            </Row>
            <Row label="Vignette" value={Math.round(ui.fxVignette * 100)} unit="%">
              <Slider min={0} max={1} step={0.01} value={ui.fxVignette}
                onChange={(v) => set({ fxVignette: v })} />
            </Row>
            <Row label="Bloom" value={Math.round(ui.fxBloom * 100)} unit="%">
              <Slider min={0} max={1.5} step={0.01} value={ui.fxBloom}
                onChange={(v) => set({ fxBloom: v })} />
            </Row>
            <Row label="Saturation" value={ui.fxSaturation.toFixed(2)}>
              <Slider min={0} max={2} step={0.01} value={ui.fxSaturation}
                onChange={(v) => set({ fxSaturation: v })} />
            </Row>
            <Row label="Contrast" value={ui.fxContrast.toFixed(2)}>
              <Slider min={0.5} max={2} step={0.01} value={ui.fxContrast}
                onChange={(v) => set({ fxContrast: v })} />
            </Row>
            <Row label="Hue" value={ui.fxHue} unit="°">
              <Slider min={-180} max={180} step={1} value={ui.fxHue}
                onChange={(v) => set({ fxHue: v })} />
            </Row>
          </Collapsible>

          <SectionLabel>Playback</SectionLabel>
          <div className="flex gap-2 mb-2">
            <button onClick={() => set({ playing: !ui.playing })}
              className="flex-1 h-7 inline-flex items-center justify-center rounded-md bg-slate-100 hover:bg-white text-slate-900 text-[11px] font-medium transition-colors">
              {ui.playing ? "❙❙  Pause" : "▶  Play"}
            </button>
            <button onClick={reset}
              className="h-7 px-3 rounded-md border border-slate-700 hover:bg-slate-800 text-slate-200 text-[11px] font-medium transition-colors">
              Reset
            </button>
          </div>
          <button onClick={() => api.current && api.current.resetOrbit()}
            className="w-full h-7 mb-2 rounded-md border border-slate-700 hover:bg-slate-800 text-slate-300 text-[10.5px] font-medium">
            Reset view (recenter ring)
          </button>

          <SectionLabel>Rotation</SectionLabel>
          <Row label="Spin speed" value={ui.rotSpeed.toFixed(2)}>
            <Slider min={0} max={3} step={0.01} value={ui.rotSpeed} onChange={(v) => set({ rotSpeed: v })} />
          </Row>
          <Row label="Direction">
            <Segment options={[{ v: 1, l: "Forward" }, { v: -1, l: "Reverse" }]} value={ui.dir} onChange={(v) => set({ dir: v })} />
          </Row>
          <Row label="Orbit speed" value={ui.orbitSpeed.toFixed(2)}>
            <Slider min={0} max={2} step={0.01} value={ui.orbitSpeed} onChange={(v) => set({ orbitSpeed: v })} />
          </Row>

          <Collapsible title="Perspective">
          <Row label="Mode">
            <Segment
              options={[{ v: "ring", l: "Ring" }, { v: "perspective", l: "Tumble" }]}
              value={ui.perspectiveMode}
              onChange={(v) => set({ perspectiveMode: v })} />
          </Row>
          {ui.perspectiveMode === "perspective" && (
            <Row label="Flip intensity" value={ui.perspectiveIntensity.toFixed(2)}>
              <Slider min={0} max={2} step={0.01} value={ui.perspectiveIntensity}
                onChange={(v) => set({ perspectiveIntensity: v })} />
            </Row>
          )}
          <div className="flex items-center justify-between mb-3">
            <span className="text-[13px] font-medium text-slate-200">Scatter positions</span>
            <Switch checked={ui.scatterEnabled} onChange={(v) => set({ scatterEnabled: v })} />
          </div>
          {ui.scatterEnabled && (
            <Row label="Scatter amount" value={ui.scatterAmount.toFixed(2)}>
              <Slider min={0} max={1} step={0.01} value={ui.scatterAmount}
                onChange={(v) => set({ scatterAmount: v })} />
            </Row>
          )}
          </Collapsible>

          <Collapsible title="Easing">
          <Row label="Curve">
            <Segment
              options={[
                { v: "linear", l: "Linear" },
                { v: "in", l: "In" },
                { v: "out", l: "Out" },
                { v: "inout", l: "InOut" },
              ]}
              value={ui.easing}
              onChange={(v) => set({ easing: v })} />
          </Row>
          {ui.easing !== "linear" && (
            <Row label="Strength (sharp ↔ soft)" value={ui.easingStrength.toFixed(2)}>
              <Slider min={1} max={5} step={0.1} value={ui.easingStrength}
                onChange={(v) => set({ easingStrength: v })} />
            </Row>
          )}
          </Collapsible>

          <Collapsible title="Layout">
          <Row label="Overall scale" value={ui.overallScale.toFixed(2)}>
            <Slider min={0.2} max={2} step={0.01} value={ui.overallScale}
              onChange={(v) => set({ overallScale: v })} />
          </Row>
          <Row label="Orbit radius" value={ui.orbitR.toFixed(2)}>
            <Slider min={0.5} max={5} step={0.05} value={ui.orbitR} onChange={(v) => set({ orbitR: v })} />
          </Row>
          <Row label="Coin size" value={ui.size.toFixed(2)}>
            <Slider min={0.3} max={2} step={0.01} value={ui.size} onChange={(v) => set({ size: v })} />
          </Row>
          <Row label="Thickness" value={ui.thick.toFixed(2)}>
            <Slider min={0.05} max={0.7} step={0.01} value={ui.thick} onChange={(v) => set({ thick: v })} />
          </Row>
          <Row label="Tilt" value={ui.tilt.toFixed(2)}>
            <Slider min={-0.6} max={0.6} step={0.01} value={ui.tilt} onChange={(v) => set({ tilt: v })} />
          </Row>
          </Collapsible>

          <Collapsible title="Float">
          <Row label="Amplitude" value={ui.floatAmp.toFixed(2)}>
            <Slider min={0} max={1} step={0.01} value={ui.floatAmp} onChange={(v) => set({ floatAmp: v })} />
          </Row>
          <Row label="Speed" value={ui.floatSpeed.toFixed(2)}>
            <Slider min={0} max={3} step={0.01} value={ui.floatSpeed} onChange={(v) => set({ floatSpeed: v })} />
          </Row>
          </Collapsible>

          <Collapsible title="Material">
          <Row label="Metalness" value={ui.metalness.toFixed(2)}>
            <Slider min={0} max={1} step={0.01} value={ui.metalness} onChange={(v) => set({ metalness: v })} />
          </Row>
          <Row label="Roughness" value={ui.roughness.toFixed(2)}>
            <Slider min={0} max={1} step={0.01} value={ui.roughness} onChange={(v) => set({ roughness: v })} />
          </Row>
          </Collapsible>

          <Collapsible title="Glow">
          <Row label="Intensity" value={ui.glow.toFixed(2)}>
            <Slider min={0} max={1.5} step={0.01} value={ui.glow} onChange={(v) => set({ glow: v })} />
          </Row>
          <Row label="Range" value={ui.glowRange.toFixed(2)}>
            <Slider min={0.6} max={3} step={0.01} value={ui.glowRange} onChange={(v) => set({ glowRange: v })} />
          </Row>
          </Collapsible>

          <Collapsible title="Lighting">
          <Row label="Intensity" value={ui.light.toFixed(2)}>
            <Slider min={0} max={4} step={0.01} value={ui.light} onChange={(v) => set({ light: v })} />
          </Row>
          <div className="mb-3 rounded-md border border-slate-700 bg-slate-800/40 p-2.5">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">
              Face reflection
            </div>
            <Row label="Intensity" value={ui.reflectionOpacity.toFixed(2)}>
              <Slider min={0} max={1} step={0.01} value={ui.reflectionOpacity}
                onChange={(v) => set({ reflectionOpacity: v })} />
            </Row>
            <Row label="Blur (sharp ↔ soft)" value={ui.reflectionBlur.toFixed(2)}>
              <Slider min={0} max={1} step={0.01} value={ui.reflectionBlur}
                onChange={(v) => set({ reflectionBlur: v })} />
            </Row>
          </div>
          <div className="mb-3 rounded-md border border-slate-700 bg-slate-800/40 p-2.5">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">Right soft light</div>
            <Row label="Horizontal" value={ui.rightLightX.toFixed(1)}>
              <Slider min={-10} max={10} step={0.1} value={ui.rightLightX} onChange={(v) => set({ rightLightX: v })} />
            </Row>
            <Row label="Vertical" value={ui.rightLightY.toFixed(1)}>
              <Slider min={-10} max={10} step={0.1} value={ui.rightLightY} onChange={(v) => set({ rightLightY: v })} />
            </Row>
            <Row label="Depth" value={ui.rightLightZ.toFixed(1)}>
              <Slider min={-10} max={10} step={0.1} value={ui.rightLightZ} onChange={(v) => set({ rightLightZ: v })} />
            </Row>
            <Row label="Softness" value={ui.rightLightSoftness.toFixed(1)}>
              <Slider min={1} max={20} step={0.1} value={ui.rightLightSoftness} onChange={(v) => set({ rightLightSoftness: v })} />
            </Row>
          </div>
          </Collapsible>

          <Collapsible title="Scene">
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-[11.5px] font-medium text-slate-200">Dot grid</span>
            <Switch checked={ui.grid} onChange={(v) => set({ grid: v })} />
          </div>
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-[11.5px] font-medium text-slate-200">Auto-orbit</span>
            <Switch checked={ui.autoOrbit} onChange={(v) => set({ autoOrbit: v })} />
          </div>
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-[11.5px] font-medium text-slate-200">Orbit ring</span>
            <Switch checked={ui.showRing} onChange={(v) => set({ showRing: v })} />
          </div>
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-[11.5px] font-medium text-slate-200">Shadow</span>
            <Switch checked={ui.showShadow} onChange={(v) => set({ showShadow: v })} />
          </div>
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-[11.5px] font-medium text-slate-200">Background</span>
            <input type="color" value={ui.bgColor}
              onChange={(e) => set({ bgColor: e.target.value })}
              className="w-10 h-7 rounded border border-slate-700 bg-transparent cursor-pointer" />
          </div>
          </Collapsible>

          <SectionLabel>Coins</SectionLabel>
          <Row label="Order">
            <Segment
              options={[{ v: "asc", l: "Ascend" }, { v: "desc", l: "Descend" }]}
              value={ui.coinOrder}
              onChange={(v) => set({ coinOrder: v })} />
          </Row>
          <Row label="Layering">
            <Segment
              options={[
                { v: "auto",  l: "Auto" },
                { v: "first", l: "First top" },
                { v: "last",  l: "Last top" },
              ]}
              value={ui.coinLayering}
              onChange={(v) => set({ coinLayering: v })} />
          </Row>
          <button
            onClick={() => setCoins((cs) => cs.map((c) => ({ ...c, angleOffset: 0 })))}
            className="w-full h-7 mb-2.5 rounded-md border border-slate-700 hover:bg-slate-800 text-slate-300 text-[10.5px] font-medium">
            Reset all positions
          </button>
          <div className="flex items-center gap-2 mb-2.5">
            <label className="text-[11px] text-slate-300 flex-none">Count</label>
            <input type="number" min={1} max={64} value={coins.length}
              onChange={(e) => setCoinCount(parseInt(e.target.value, 10))}
              className="w-14 h-6 px-2 rounded bg-slate-900 border border-slate-700 text-slate-100 text-[10.5px] tabular-nums" />
            <button onClick={addCoin}
              className="flex-1 h-6 inline-flex items-center justify-center rounded-md bg-slate-100 hover:bg-white text-slate-900 text-[10.5px] font-medium">
              + Add
            </button>
          </div>
          <div className="space-y-3">
            {coins.map((c, i) => (
              <div key={c.key} className="p-2.5 rounded-md bg-slate-800/50 border border-slate-700">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-medium text-slate-200">#{i + 1} · {c.palette}</span>
                  <div className="flex gap-1">
                    <button onClick={() => dupCoin(c.key)} title="Duplicate"
                      className="px-2 py-0.5 rounded text-[11px] bg-slate-700 hover:bg-slate-600">⧉</button>
                    <button onClick={() => removeCoin(c.key)} title="Remove" disabled={coins.length <= 1}
                      className="px-2 py-0.5 rounded text-[11px] bg-slate-700 hover:bg-rose-600 disabled:opacity-40">✕</button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 mb-2">
                  {["front", "back"].map((side) => (
                    <label key={side} className="flex flex-col gap-1 cursor-pointer">
                      <span className="text-[10px] uppercase tracking-wider text-slate-400">{side}</span>
                      <div className="h-14 rounded border border-dashed border-slate-600 hover:border-slate-400 flex items-center justify-center overflow-hidden bg-slate-900/60">
                        {c[side]
                          ? <img src={c[side]} alt="" className="w-full h-full object-cover" />
                          : <span className="text-[10px] text-slate-500">Upload</span>}
                      </div>
                      <input type="file" accept="image/*" className="hidden"
                        onChange={(e) => uploadFace(c.key, side, e.target.files && e.target.files[0])} />
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <SectionLabel>Export</SectionLabel>
          <Row label="Resolution frame">
            <select value={ui.exportPreset}
              onChange={(e) => set({ exportPreset: e.target.value })}
              className="w-full h-7 px-2 rounded-md bg-slate-900 border border-slate-700 text-slate-100 text-[10.5px]">
              {Object.entries(EXPORT_PRESETS).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </Row>
          {ui.exportPreset === "custom" && (
            <div className="grid grid-cols-2 gap-2 mb-3">
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wider text-slate-400">Width</span>
                <input type="number" min={64} max={4096} value={ui.exportWidth}
                  onChange={(e) => set({ exportWidth: Math.max(64, parseInt(e.target.value, 10) || 64) })}
                  className="w-full px-2 py-1 rounded bg-slate-900 border border-slate-700 text-slate-100 text-[12px]" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wider text-slate-400">Height</span>
                <input type="number" min={64} max={4096} value={ui.exportHeight}
                  onChange={(e) => set({ exportHeight: Math.max(64, parseInt(e.target.value, 10) || 64) })}
                  className="w-full px-2 py-1 rounded bg-slate-900 border border-slate-700 text-slate-100 text-[12px]" />
              </label>
            </div>
          )}
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-[11.5px] font-medium text-slate-200">Show frame overlay</span>
            <Switch checked={ui.showExportFrame} onChange={(v) => set({ showExportFrame: v })} />
          </div>
          <Row label="Duration" value={ui.exportDuration.toFixed(1)} unit="s">
            <Slider min={1} max={30} step={0.5} value={ui.exportDuration}
              onChange={(v) => set({ exportDuration: v })} />
          </Row>
          <Row label="FPS">
            <Segment
              options={[{v:24,l:"24"},{v:30,l:"30"},{v:60,l:"60"}]}
              value={ui.exportFps}
              onChange={(v) => set({ exportFps: v })} />
          </Row>
          <Row label="Video bitrate" value={ui.exportBitrate.toFixed(0)} unit="Mbps">
            <Slider min={2} max={80} step={1} value={ui.exportBitrate}
              onChange={(v) => set({ exportBitrate: v })} />
          </Row>
          <Row label="GIF quality (lower=better)" value={ui.exportGifQuality}>
            <Slider min={1} max={30} step={1} value={ui.exportGifQuality}
              onChange={(v) => set({ exportGifQuality: v })} />
          </Row>
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-[11.5px] font-medium text-slate-200">Transparent bg</span>
            <Switch checked={ui.transparentBg} onChange={(v) => set({ transparentBg: v })} />
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <button onClick={exportJSON}
              className="h-7 rounded-md border border-slate-700 hover:bg-slate-800 text-slate-200 text-[10.5px] font-medium">JSON</button>
            <button onClick={exportPNG}
              className="h-7 rounded-md border border-slate-700 hover:bg-slate-800 text-slate-200 text-[10.5px] font-medium">PNG</button>
            <button onClick={exportWebM} disabled={!!recording}
              className="h-7 rounded-md border border-slate-700 hover:bg-slate-800 text-slate-200 text-[10.5px] font-medium disabled:opacity-60">
              {recording === "webm" ? "Recording…" : "WebM"}
            </button>
            <button onClick={exportMP4} disabled={!!recording}
              className="h-7 rounded-md border border-slate-700 hover:bg-slate-800 text-slate-200 text-[10.5px] font-medium disabled:opacity-60">
              {recording === "mp4" ? "Recording…" : "MP4"}
            </button>
            <button onClick={exportGIF} disabled={gifting}
              className="col-span-2 h-7 rounded-md border border-slate-700 hover:bg-slate-800 text-slate-200 text-[10.5px] font-medium disabled:opacity-60">
              {gifting ? "Encoding…" : "GIF"}
            </button>
          </div>
          <p className="text-[10px] text-slate-500 mt-2 leading-relaxed">
            For a website with no background, enable <b>Transparent bg</b> and export as <b>PNG</b> (static) or
            <b> WebM (VP9)</b> — both keep alpha. GIFs use 1-bit transparency and may fringe. For true MP4,
            convert the WebM with ffmpeg: <code className="text-slate-400">ffmpeg -i in.webm -c:v libx264 -pix_fmt yuv420p out.mp4</code>.
          </p>
        </div>

        <div className="px-4 py-2.5 border-t border-slate-800 text-[10px] text-slate-500">
          Drag the stage to orbit
        </div>
      </aside>

      {/* STAGE */}
      <main ref={stageRef} className="relative flex-1 h-full overflow-hidden">
        <div className="absolute inset-0" style={{ background: ui.bgColor }} />
        <div className="absolute inset-0"
          style={{ background: "radial-gradient(22% 24% at 50% 50%, rgba(120,130,255,0.20), transparent 70%)" }} />
        <div className="absolute inset-0" style={gridStyle} />
        <div className="absolute inset-x-0 top-0 h-40 pointer-events-none"
          style={{ background: "linear-gradient(#ffffffcc, transparent)" }} />
        <div className="absolute inset-0 flex items-center justify-center text-center pointer-events-none z-0">
          <div>
            <div className="text-[20px] font-semibold text-slate-800/70 tracking-tight">A New Era of Digital Ownership</div>
            <div className="text-[11px] text-slate-500/80 mt-1">Empowered by blockchain — yours to shape</div>
          </div>
        </div>
        <div ref={mountRef} className="absolute inset-0 z-10"
          style={{ filter: canvasFilter || undefined }} />
        {ui.fxVignette > 0 && (
          <div className="absolute inset-0 pointer-events-none z-20"
            style={{
              background: `radial-gradient(ellipse at center, transparent ${(1 - ui.fxVignette) * 55 + 20}%, rgba(0,0,0,${(ui.fxVignette * 0.9).toFixed(2)}) 100%)`,
            }} />
        )}
        {ui.fxGrain > 0 && (
          <div className="absolute inset-0 pointer-events-none z-20 mix-blend-overlay"
            style={{
              opacity: ui.fxGrain,
              backgroundImage:
                "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 1 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")",
              backgroundSize: "180px 180px",
            }} />
        )}
        {/* On-canvas light source: drag it around the open space to choose
            where the broad right softbox shines from. */}
        <div className="absolute z-30 pointer-events-none"
          style={{
            left: `${5 + ((ui.rightLightX + 10) / 20) * 90}%`,
            top: `${95 - ((ui.rightLightY + 10) / 20) * 90}%`,
            transform: "translate(-50%, -50%)",
          }}>
          <span className="pointer-events-none absolute left-1/2 top-10 -translate-x-1/2 -translate-y-1/2 rounded-full border border-slate-400/35 bg-slate-200/5 transition-[width,height,opacity] duration-150"
            style={{
              width: `${Math.max(100, ui.rightLightSoftness * 24)}px`,
              height: `${Math.max(100, ui.rightLightSoftness * 24)}px`,
              opacity: ui.light > 0 ? Math.min(0.75, 0.2 + ui.light * 0.14) : 0.12,
            }} />
          <button type="button"
            onPointerDown={beginStageLightDrag}
            onPointerUp={(event) => {
              draggingLightRef.current = false;
              setDraggingLight(false);
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
            }}
            onPointerCancel={() => { draggingLightRef.current = false; setDraggingLight(false); }}
            onLostPointerCapture={() => { draggingLightRef.current = false; setDraggingLight(false); }}
            className={"group pointer-events-auto flex flex-col items-center gap-2 select-none " +
              (draggingLight ? "cursor-grabbing" : "cursor-grab")}>
            <span className={"relative grid h-20 w-20 place-items-center rounded-full border-2 transition-all " +
              (draggingLight
                ? "border-slate-300 bg-slate-100/90 shadow-[0_0_0_10px_rgba(148,163,184,0.18),0_0_38px_rgba(148,163,184,0.45)]"
                : "border-slate-400/80 bg-white/75 shadow-[0_0_0_7px_rgba(148,163,184,0.12),0_8px_24px_rgba(30,41,59,0.35)] group-hover:border-slate-200 group-hover:bg-white/95") }>
              <span className="absolute inset-2 rounded-full border border-slate-300/80" />
              <span className="grid h-9 w-9 place-items-center rounded-full bg-slate-800 text-lg text-white shadow-lg">✦</span>
            </span>
            <span className="rounded-full bg-slate-900/75 px-2.5 py-1 text-[11px] font-medium text-white shadow-sm backdrop-blur">
              Drag light
            </span>
          </button>
        </div>
        {/* Export frame overlay — dashed rectangle showing the target aspect */}
        {ui.showExportFrame && ui.exportPreset !== "viewport" && (() => {
          const preset = EXPORT_PRESETS[ui.exportPreset];
          const w = (preset && preset.w) || ui.exportWidth;
          const h = (preset && preset.h) || ui.exportHeight;
          // Show the frame at its true proportional size relative to the stage
          // so dragging it visibly grows and shrinks the crop region.
          const displayScale = Math.min(
            (stageSize.w * 0.94) / w,
            (stageSize.h * 0.94) / h
          );
          const cssW = Math.max(24, w * displayScale);
          const cssH = Math.max(24, h * displayScale);
          return (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
              <div data-export-frame className="relative border-2 border-dashed border-indigo-500/70 shadow-[0_0_0_9999px_rgba(15,23,42,0.35)]"
                style={{ width: `${cssW}px`, height: `${cssH}px` }}>
                <div onPointerDown={beginFrameResize("n")} className="pointer-events-auto absolute left-6 right-6 -top-1 h-2 cursor-ns-resize" />
                <div onPointerDown={beginFrameResize("s")} className="pointer-events-auto absolute left-6 right-6 -bottom-1 h-2 cursor-ns-resize" />
                <div onPointerDown={beginFrameResize("w")} className="pointer-events-auto absolute top-6 bottom-6 -left-1 w-2 cursor-ew-resize" />
                <div onPointerDown={beginFrameResize("e")} className="pointer-events-auto absolute top-6 bottom-6 -right-1 w-2 cursor-ew-resize" />
                <div onPointerDown={beginFrameResize("nw")} className="pointer-events-auto absolute -top-1.5 -left-1.5 w-3 h-3 cursor-nwse-resize bg-indigo-500 rounded-sm shadow" />
                <div onPointerDown={beginFrameResize("ne")} className="pointer-events-auto absolute -top-1.5 -right-1.5 w-3 h-3 cursor-nesw-resize bg-indigo-500 rounded-sm shadow" />
                <div onPointerDown={beginFrameResize("sw")} className="pointer-events-auto absolute -bottom-1.5 -left-1.5 w-3 h-3 cursor-nesw-resize bg-indigo-500 rounded-sm shadow" />
                <div onPointerDown={beginFrameResize("se")} className="pointer-events-auto absolute -bottom-1.5 -right-1.5 w-3 h-3 cursor-nwse-resize bg-indigo-500 rounded-sm shadow" />
              </div>
              <div className="absolute top-3 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded bg-indigo-500 text-white text-[10px] font-medium pointer-events-none">
                {w} × {h}
              </div>
            </div>
          );
        })()}
      </main>
    </div>
  );
}
