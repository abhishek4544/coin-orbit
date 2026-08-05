import { useRef, useEffect, useState, useCallback } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

// =========================================================================
//  TEXTURE HELPERS
// =========================================================================
const S = 512;
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
  t.anisotropy = 8;
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
      t.anisotropy = 8;
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
  t.anisotropy = 8;
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
    metalness: 0.95,
    roughness: 0.28,
    clearcoat: 0.35,
    clearcoatRoughness: 0.4,
    envMapIntensity: 1.15,
  });
  const faceTexA = plainFaceTex(palette);
  const faceTexB = plainFaceTex(palette);
  const faceOpts = {
    metalness: 0.55, roughness: 0.28,
    clearcoat: 0.4, clearcoatRoughness: 0.35,
    envMapIntensity: 1.1,
  };
  const fA = new THREE.MeshPhysicalMaterial({ ...faceOpts, map: faceTexA });
  const fB = new THREE.MeshPhysicalMaterial({ ...faceOpts, map: faceTexB });
  const bodyGeo = new THREE.CylinderGeometry(1, 1, BASE_THICK, seg);
  const body = new THREE.Mesh(bodyGeo, [edgeMat, fA, fB]);
  const bevelGeo = new THREE.TorusGeometry(0.997, 0.022, 14, seg);
  const bevelA = new THREE.Mesh(bevelGeo, edgeMat);
  bevelA.rotation.x = Math.PI / 2;
  bevelA.position.y = BASE_THICK / 2;
  const bevelB = new THREE.Mesh(bevelGeo, edgeMat);
  bevelB.rotation.x = Math.PI / 2;
  bevelB.position.y = -BASE_THICK / 2;
  const coin = new THREE.Group();
  coin.add(body, bevelA, bevelB);
  coin.rotation.x = Math.PI / 2;
  return { coin, body, bevelA, bevelB, edgeMat, faceMats: [fA, fB] };
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

// Default face assets — drop the front/back images from your screenshot into
// `public/images/coins/` and every new coin picks them up automatically.
// If the files are missing, the coin falls back to its palette gradient.
const DEFAULT_FRONT = "/images/coins/front.png";
const DEFAULT_BACK  = "/images/coins/back.png";
// Start with a complete, balanced orbit. Seven coins gives the hero enough
// presence without making the individual faces feel crowded or cropped.
const DEFAULT_COIN_COUNT = 7;

const newId = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) ||
  Math.random().toString(36).slice(2) + Date.now().toString(36);

// =========================================================================
//  UI PRIMITIVES
// =========================================================================
const Row = ({ label, value, children }) => (
  <div className="mb-4">
    <div className="flex items-center justify-between mb-2">
      <span className="text-[13px] font-medium text-slate-200">{label}</span>
      {value !== undefined && (
        <span className="text-[12px] tabular-nums text-slate-400 font-mono">{value}</span>
      )}
    </div>
    {children}
  </div>
);
const Slider = ({ min, max, step, value, onChange }) => {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <input type="range" min={min} max={max} step={step} value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      className="cs-slider" style={{ "--pct": pct + "%" }} />
  );
};
const Switch = ({ checked, onChange }) => (
  <button onClick={() => onChange(!checked)}
    className={"cs-switch " + (checked ? "cs-switch-on" : "cs-switch-off")}>
    <span className="cs-knob" />
  </button>
);
const Segment = ({ options, value, onChange }) => (
  <div className="flex gap-1 p-1 rounded-lg bg-slate-800/70 border border-slate-700">
    {options.map((o) => (
      <button key={o.v} onClick={() => onChange(o.v)}
        className={"flex-1 text-[12px] font-medium py-1.5 rounded-md transition-colors " +
          (value === o.v ? "bg-indigo-500 text-white shadow" : "text-slate-300 hover:bg-slate-700/60")}>
        {o.l}
      </button>
    ))}
  </div>
);
const SectionLabel = ({ children }) => (
  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mt-6 mb-3 first:mt-0">
    {children}
  </div>
);

// =========================================================================
//  UTILITIES
// =========================================================================
function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
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
  playing: true, rotSpeed: 0, dir: 1, orbitSpeed: 0.25,
  floatAmp: 0.16, floatSpeed: 0.55, tilt: 0,
  orbitR: 2.2, size: 0.6, thick: 0.13, overallScale: 0.7,
  metalness: 0.85, roughness: 0.28,
  light: 1, accent: 232, grid: true, autoOrbit: false,
  bgColor: "#e9edff",
  rimColor: "#5b6bff",
  showRing: false, showShadow: false,
  glow: 0.4, glowRange: 1.6,
  naturalTilt: false, naturalTiltAmount: 0.35, naturalTiltWobble: 0.4,
  transparentBg: false,
  exportDuration: 5, exportFps: 30, exportBitrate: 8, exportGifQuality: 10,
  exportPreset: "viewport",
  exportWidth: 1080, exportHeight: 1080,
  showExportFrame: true,
};

const EXPORT_PRESETS = {
  viewport:  { label: "Viewport" },
  square:    { label: "1:1 · 1080",     w: 1080, h: 1080 },
  landscape: { label: "16:9 · 1920×1080", w: 1920, h: 1080 },
  portrait:  { label: "9:16 · 1080×1920", w: 1080, h: 1920 },
  wide:      { label: "21:9 · 2560×1080", w: 2560, h: 1080 },
  hd:        { label: "720p · 1280×720",  w: 1280, h: 720  },
  custom:    { label: "Custom" },
};

export default function CoinStudio() {
  const mountRef = useRef(null);
  const api = useRef(null);
  const settings = useRef({ ...DEFAULTS });
  const [ui, setUi] = useState({ ...DEFAULTS });

  const set = useCallback((patch) => {
    setUi((p) => { const n = { ...p, ...patch }; settings.current = n; return n; });
  }, []);

  // Coin list — this is the source of truth.  Each entry is a "spec".
  const [coins, setCoins] = useState(() =>
    Array.from({ length: DEFAULT_COIN_COUNT }, (_, i) => ({
      key: newId(),
      palette: PALETTE_KEYS[i % PALETTE_KEYS.length],
      front: DEFAULT_FRONT,
      back: DEFAULT_BACK,
      phase: i * 1.2,
    }))
  );

  const addCoin = useCallback(() => {
    setCoins((cs) => [
      ...cs,
      {
        key: newId(),
        palette: PALETTE_KEYS[cs.length % PALETTE_KEYS.length],
        front: DEFAULT_FRONT, back: DEFAULT_BACK,
        phase: cs.length * 1.2,
      },
    ]);
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
        add.push({
          key: newId(),
          palette: PALETTE_KEYS[i % PALETTE_KEYS.length],
          front: DEFAULT_FRONT,
          back: DEFAULT_BACK,
          phase: i * 1.2,
        });
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
    renderer.toneMappingExposure = 1.1;
    renderer.setClearColor(new THREE.Color(DEFAULTS.bgColor), 1);
    // Image-based lighting — the reflections make metallic surfaces read as
    // truly physical rather than plastic.
    const pmrem = new THREE.PMREMGenerator(renderer);
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.cursor = "grab";

    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    const amb = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(amb);
    const keyL = new THREE.DirectionalLight(0xffffff, 1.8);
    keyL.position.set(-4, 6, 8);
    scene.add(keyL);
    const fill = new THREE.DirectionalLight(0xe6ecff, 0.5);
    fill.position.set(6, -1, 5);
    scene.add(fill);
    const rimL = new THREE.PointLight(0x5b6bff, 2.2, 60);
    rimL.position.set(-3, 3, -6); scene.add(rimL);
    const rimL2 = new THREE.PointLight(0x8a5bff, 1.6, 60);
    rimL2.position.set(6, -2, -4); scene.add(rimL2);

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
      return {
        floatG, tilt, spin,
        coin: built.coin, body: built.body,
        bevelA: built.bevelA, bevelB: built.bevelB,
        faceMats: built.faceMats, edgeMat: built.edgeMat,
        halo, haloMat, shadow,
        phase: spec.phase, angle: 0,
        applied: { front: null, back: null },
        rimColors: { a: pal.edge[0], b: pal.edge[1] },
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
      // Clamp both axes so the ring never rotates far enough to leave the frame.
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
      const R = (s.orbitR + s.size) * s.overallScale + 0.8;
      const fovR = camera.fov * Math.PI / 180;
      const distV = R / Math.tan(fovR / 2);
      const distH = R / (Math.tan(fovR / 2) * aspect);
      camera.position.z = Math.max(distV, distH, 6);
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

      // Rim lights — a direct colour picker takes precedence over the accent hue.
      let hue = s.accent / 360;
      if (s.rimColor) {
        const c = new THREE.Color(s.rimColor);
        rimL.color.copy(c);
        const hsl = { h: 0, s: 0, l: 0 };
        c.getHSL(hsl);
        hue = hsl.h;
        rimL2.color.setHSL((hue + 0.08) % 1, hsl.s, hsl.l);
      } else {
        rimL.color.setHSL(hue, 0.8, 0.62);
        rimL2.color.setHSL((hue + 0.08) % 1, 0.8, 0.6);
      }
      keyL.intensity = 1.8 * s.light;
      amb.intensity = 0.55 * s.light;
      rimL.intensity = 2.2 * s.light;
      rimL2.intensity = 1.6 * s.light;

      const N = currentList.length;
      currentList.forEach((spec, i) => {
        const entry = registry.get(spec.key);
        if (!entry) return;
        if (s.playing) {
          entry.angle += dt * s.rotSpeed * s.dir;
          // Rotate around the face-normal (Z after coin.rotation.x = π/2) so
          // the design spins in-plane and the face stays toward the camera,
          // instead of flipping to edge-on at high spin speeds.
          entry.spin.rotation.z = entry.angle;
        }
        const orbitA = (i / N) * Math.PI * 2 + ft * s.orbitSpeed * s.dir - Math.PI / 2;
        entry.floatG.position.x = Math.cos(orbitA) * s.orbitR;
        entry.floatG.position.y = Math.sin(orbitA) * s.orbitR
          + Math.sin(ft * s.floatSpeed + entry.phase) * s.floatAmp;
        entry.tilt.rotation.x = 0.14 + s.tilt;
        entry.floatG.scale.setScalar(s.size);
        // Dynamic thickness — scale the cylinder in local Y and shift the
        // bevel rings so they hug the new rim edges.
        const yScale = s.thick / BASE_THICK;
        entry.body.scale.y = yScale;
        entry.bevelA.position.y = s.thick / 2;
        entry.bevelB.position.y = -s.thick / 2;
        // Halo — colour follows the accent hue, opacity is "glow", scale is "glowRange".
        entry.halo.scale.setScalar(3 * s.glowRange);
        entry.haloMat.opacity = s.glow;
        entry.haloMat.color.setHSL(hue, 0.75, 0.72);
        entry.shadow.visible = !!s.showShadow;
        entry.edgeMat.metalness = s.metalness;
        entry.edgeMat.roughness = s.roughness;
        entry.faceMats.forEach((m) => { m.metalness = s.metalness; m.roughness = s.roughness; });
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
  const [recording, setRecording] = useState(false);
  const exportWebM = async () => {
    if (!api.current || recording) return;
    const s = settings.current;
    // Recenter drag orbit and give the interpolation a beat to settle so the
    // recording opens on a centered ring.
    api.current.resetOrbit();
    const { w, h } = exportDims();
    api.current.beginExport(w, h);
    await new Promise((r) => setTimeout(r, 350));
    const canvasEl = api.current.getCanvas();
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9"
      : "video/webm";
    const stream = canvasEl.captureStream(s.exportFps);
    const rec = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: Math.round(s.exportBitrate * 1_000_000),
    });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      api.current.endExport();
      download("coin-studio.webm", new Blob(chunks, { type: mime }));
      setRecording(false);
    };
    setRecording(true);
    rec.start();
    setTimeout(() => rec.stop(), Math.max(500, s.exportDuration * 1000));
  };
  const [gifting, setGifting] = useState(false);
  const exportGIF = async () => {
    if (!api.current || gifting) return;
    setGifting(true);
    try {
      await loadScript("https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.js");
      const s = settings.current;
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
        transparent: s.transparentBg ? 0x000000 : null,
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
        download("coin-studio.gif", blob);
        setGifting(false);
      });
      gif.render();
    } catch (e) {
      alert("GIF export failed to load gif.js — check network.");
      api.current && api.current.endExport();
      setGifting(false);
    }
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
    <div className="w-full h-screen flex bg-slate-950 text-slate-100 font-sans overflow-hidden">
      <style>{`
        .cs-slider{-webkit-appearance:none;appearance:none;width:100%;height:6px;border-radius:9999px;
          background:linear-gradient(to right,#6366f1 var(--pct),#334155 var(--pct));outline:none;cursor:pointer;}
        .cs-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;border-radius:9999px;
          background:#fff;border:2px solid #6366f1;box-shadow:0 1px 4px rgba(0,0,0,.4);cursor:pointer;transition:transform .1s;}
        .cs-slider::-webkit-slider-thumb:hover{transform:scale(1.15);}
        .cs-slider::-moz-range-thumb{width:16px;height:16px;border-radius:9999px;background:#fff;border:2px solid #6366f1;cursor:pointer;}
        .cs-switch{position:relative;width:40px;height:22px;border-radius:9999px;transition:background .2s;flex:none;}
        .cs-switch-on{background:#6366f1;} .cs-switch-off{background:#475569;}
        .cs-knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:9999px;background:#fff;
          transition:transform .2s;box-shadow:0 1px 3px rgba(0,0,0,.4);}
        .cs-switch-on .cs-knob{transform:translateX(18px);}
        .cs-panel::-webkit-scrollbar{width:8px;} .cs-panel::-webkit-scrollbar-thumb{background:#334155;border-radius:4px;}
        .cs-panel::-webkit-scrollbar-track{background:transparent;}
      `}</style>

      {/* CONTROL PANEL */}
      <aside className="w-[300px] flex-none h-full border-r border-slate-800 bg-slate-900/80 backdrop-blur flex flex-col">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-400 to-violet-600 flex items-center justify-center text-[13px] font-bold">◈</div>
          <div>
            <h1 className="text-[15px] font-semibold leading-tight">Coin Studio</h1>
            <p className="text-[11px] text-slate-500 leading-tight">Circular hero · 3D animator</p>
          </div>
        </div>

        <div className="cs-panel flex-1 overflow-y-auto px-5 py-4">
          <SectionLabel>Playback</SectionLabel>
          <div className="flex gap-2 mb-2">
            <button onClick={() => set({ playing: !ui.playing })}
              className="flex-1 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white text-[13px] font-medium transition-colors">
              {ui.playing ? "❙❙  Pause" : "▶  Play"}
            </button>
            <button onClick={reset}
              className="px-4 py-2 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-200 text-[13px] font-medium transition-colors">
              Reset
            </button>
          </div>
          <button onClick={() => api.current && api.current.resetOrbit()}
            className="w-full py-2 mb-2 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-300 text-[12px] font-medium">
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

          <SectionLabel>Layout</SectionLabel>
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

          <SectionLabel>Float</SectionLabel>
          <Row label="Amplitude" value={ui.floatAmp.toFixed(2)}>
            <Slider min={0} max={1} step={0.01} value={ui.floatAmp} onChange={(v) => set({ floatAmp: v })} />
          </Row>
          <Row label="Speed" value={ui.floatSpeed.toFixed(2)}>
            <Slider min={0} max={3} step={0.01} value={ui.floatSpeed} onChange={(v) => set({ floatSpeed: v })} />
          </Row>

          <SectionLabel>Material</SectionLabel>
          <Row label="Metalness" value={ui.metalness.toFixed(2)}>
            <Slider min={0} max={1} step={0.01} value={ui.metalness} onChange={(v) => set({ metalness: v })} />
          </Row>
          <Row label="Roughness" value={ui.roughness.toFixed(2)}>
            <Slider min={0} max={1} step={0.01} value={ui.roughness} onChange={(v) => set({ roughness: v })} />
          </Row>

          <SectionLabel>Glow</SectionLabel>
          <Row label="Intensity" value={ui.glow.toFixed(2)}>
            <Slider min={0} max={1.5} step={0.01} value={ui.glow} onChange={(v) => set({ glow: v })} />
          </Row>
          <Row label="Range" value={ui.glowRange.toFixed(2)}>
            <Slider min={0.6} max={3} step={0.01} value={ui.glowRange} onChange={(v) => set({ glowRange: v })} />
          </Row>

          <SectionLabel>Lighting</SectionLabel>
          <Row label="Intensity" value={ui.light.toFixed(2)}>
            <Slider min={0.2} max={2} step={0.01} value={ui.light} onChange={(v) => set({ light: v })} />
          </Row>
          <Row label="Accent hue" value={Math.round(ui.accent) + "°"}>
            <Slider min={0} max={360} step={1} value={ui.accent} onChange={(v) => set({ accent: v })} />
          </Row>
          <div className="flex items-center justify-between mb-3">
            <span className="text-[13px] font-medium text-slate-200">Rim colour</span>
            <input type="color" value={ui.rimColor}
              onChange={(e) => set({ rimColor: e.target.value })}
              className="w-10 h-7 rounded border border-slate-700 bg-transparent cursor-pointer" />
          </div>

          <SectionLabel>Scene</SectionLabel>
          <div className="flex items-center justify-between mb-3">
            <span className="text-[13px] font-medium text-slate-200">Dot grid</span>
            <Switch checked={ui.grid} onChange={(v) => set({ grid: v })} />
          </div>
          <div className="flex items-center justify-between mb-3">
            <span className="text-[13px] font-medium text-slate-200">Auto-orbit</span>
            <Switch checked={ui.autoOrbit} onChange={(v) => set({ autoOrbit: v })} />
          </div>
          <div className="flex items-center justify-between mb-3">
            <span className="text-[13px] font-medium text-slate-200">Orbit ring</span>
            <Switch checked={ui.showRing} onChange={(v) => set({ showRing: v })} />
          </div>
          <div className="flex items-center justify-between mb-3">
            <span className="text-[13px] font-medium text-slate-200">Shadow</span>
            <Switch checked={ui.showShadow} onChange={(v) => set({ showShadow: v })} />
          </div>
          <div className="flex items-center justify-between mb-3">
            <span className="text-[13px] font-medium text-slate-200">Background</span>
            <input type="color" value={ui.bgColor}
              onChange={(e) => set({ bgColor: e.target.value })}
              className="w-10 h-7 rounded border border-slate-700 bg-transparent cursor-pointer" />
          </div>

          <SectionLabel>Coins</SectionLabel>
          <div className="flex items-center gap-2 mb-3">
            <label className="text-[12px] text-slate-300 flex-none">Count</label>
            <input type="number" min={1} max={64} value={coins.length}
              onChange={(e) => setCoinCount(parseInt(e.target.value, 10))}
              className="w-16 px-2 py-1 rounded bg-slate-900 border border-slate-700 text-slate-100 text-[12px] tabular-nums" />
            <button onClick={addCoin}
              className="flex-1 py-1.5 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white text-[12px] font-medium">
              + Add
            </button>
          </div>
          <div className="space-y-3">
            {coins.map((c, i) => (
              <div key={c.key} className="p-3 rounded-lg bg-slate-800/50 border border-slate-700">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[12px] font-medium text-slate-200">#{i + 1} · {c.palette}</span>
                  <div className="flex gap-1">
                    <button onClick={() => dupCoin(c.key)} title="Duplicate"
                      className="px-2 py-0.5 rounded text-[11px] bg-slate-700 hover:bg-slate-600">⧉</button>
                    <button onClick={() => removeCoin(c.key)} title="Remove" disabled={coins.length <= 1}
                      className="px-2 py-0.5 rounded text-[11px] bg-slate-700 hover:bg-rose-600 disabled:opacity-40">✕</button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {["front", "back"].map((side) => (
                    <label key={side} className="flex flex-col gap-1 cursor-pointer">
                      <span className="text-[10px] uppercase tracking-wider text-slate-400">{side}</span>
                      <div className="h-14 rounded border border-dashed border-slate-600 hover:border-indigo-400 flex items-center justify-center overflow-hidden bg-slate-900/60">
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
              className="w-full px-2 py-1.5 rounded bg-slate-900 border border-slate-700 text-slate-100 text-[12px]">
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
          <div className="flex items-center justify-between mb-3">
            <span className="text-[13px] font-medium text-slate-200">Show frame overlay</span>
            <Switch checked={ui.showExportFrame} onChange={(v) => set({ showExportFrame: v })} />
          </div>
          <Row label="Duration (s)" value={ui.exportDuration.toFixed(1)}>
            <Slider min={1} max={30} step={0.5} value={ui.exportDuration}
              onChange={(v) => set({ exportDuration: v })} />
          </Row>
          <Row label="FPS">
            <Segment
              options={[{v:24,l:"24"},{v:30,l:"30"},{v:60,l:"60"}]}
              value={ui.exportFps}
              onChange={(v) => set({ exportFps: v })} />
          </Row>
          <Row label="Video bitrate (Mbps)" value={ui.exportBitrate.toFixed(0)}>
            <Slider min={2} max={30} step={1} value={ui.exportBitrate}
              onChange={(v) => set({ exportBitrate: v })} />
          </Row>
          <Row label="GIF quality (lower=better)" value={ui.exportGifQuality}>
            <Slider min={1} max={30} step={1} value={ui.exportGifQuality}
              onChange={(v) => set({ exportGifQuality: v })} />
          </Row>
          <div className="flex items-center justify-between mb-3">
            <span className="text-[13px] font-medium text-slate-200">Transparent bg</span>
            <Switch checked={ui.transparentBg} onChange={(v) => set({ transparentBg: v })} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={exportJSON}
              className="py-2 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-200 text-[12px] font-medium">JSON</button>
            <button onClick={exportPNG}
              className="py-2 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-200 text-[12px] font-medium">PNG</button>
            <button onClick={exportWebM} disabled={recording}
              className="py-2 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-200 text-[12px] font-medium disabled:opacity-60">
              {recording ? "Recording…" : "Video (WebM)"}
            </button>
            <button onClick={exportGIF} disabled={gifting}
              className="py-2 rounded-lg border border-slate-700 hover:bg-slate-800 text-slate-200 text-[12px] font-medium disabled:opacity-60">
              {gifting ? "Encoding…" : "GIF"}
            </button>
          </div>
          <p className="text-[10px] text-slate-500 mt-2 leading-relaxed">
            For a website with no background, enable <b>Transparent bg</b> and export as <b>PNG</b> (static) or
            <b> WebM (VP9)</b> — both keep alpha. GIFs use 1-bit transparency and may fringe. For true MP4,
            convert the WebM with ffmpeg: <code className="text-slate-400">ffmpeg -i in.webm -c:v libx264 -pix_fmt yuv420p out.mp4</code>.
          </p>
        </div>

        <div className="px-5 py-3 border-t border-slate-800 text-[11px] text-slate-500">
          Drag the stage to orbit
        </div>
      </aside>

      {/* STAGE */}
      <main className="relative flex-1 h-full overflow-hidden">
        <div className="absolute inset-0" style={{ background: ui.bgColor }} />
        <div className="absolute inset-0"
          style={{ background: "radial-gradient(22% 24% at 50% 50%, rgba(120,130,255,0.20), transparent 70%)" }} />
        <div className="absolute inset-0" style={gridStyle} />
        <div className="absolute inset-x-0 top-0 h-40 pointer-events-none"
          style={{ background: "linear-gradient(#ffffffcc, transparent)" }} />
        <div className="absolute inset-0 flex items-center justify-center text-center pointer-events-none z-0">
          <div>
            <div className="text-[22px] font-semibold text-slate-800/70 tracking-tight">A New Era of Digital Ownership</div>
            <div className="text-[12px] text-slate-500/80 mt-1">Empowered by blockchain — yours to shape</div>
          </div>
        </div>
        <div ref={mountRef} className="absolute inset-0 z-10" />
        {/* Export frame overlay — dashed rectangle showing the target aspect */}
        {ui.showExportFrame && ui.exportPreset !== "viewport" && (() => {
          const preset = EXPORT_PRESETS[ui.exportPreset];
          const w = (preset && preset.w) || ui.exportWidth;
          const h = (preset && preset.h) || ui.exportHeight;
          return (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
              <div className="border-2 border-dashed border-indigo-500/70 shadow-[0_0_0_9999px_rgba(15,23,42,0.35)]"
                style={{ aspectRatio: `${w}/${h}`, maxWidth: "94%", maxHeight: "94%",
                         width: "100%", height: "100%" }} />
              <div className="absolute top-3 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded bg-indigo-500 text-white text-[10px] font-medium">
                {w} × {h}
              </div>
            </div>
          );
        })()}
      </main>
    </div>
  );
}
