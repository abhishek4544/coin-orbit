# Coin Studio

A 3D coin-animation tool that recreates the Chainova hero: five metallic coins
fanned in an arc, slowly rotating and floating, with a live shadcn-style control
panel on the left. Built with React + Vite + Tailwind v4 + three.js.

## Run it

Requires Node.js 18+ (22+ recommended).

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually http://localhost:5173).

## Build for production

```bash
npm run build
npm run preview
```

## Where things live

- `src/CoinStudio.jsx` — the whole tool (3D scene + controls).
- `src/App.jsx` — renders CoinStudio.
- `src/main.jsx` — React entry point.
- `src/index.css` — Tailwind import + full-height reset.

## Controls

Playback (play/pause, reset), rotation speed + direction, float amplitude/speed,
pose (tilt/spread/size), material (metalness/roughness/BTC glow), lighting
(intensity + accent hue), and scene toggles (dot grid, auto-orbit). Drag the
stage to orbit the camera. Defaults are tuned to match the reference frame.

## Notes

- Uses the modern three.js color API (`SRGBColorSpace` / `outputColorSpace`),
  so it works with three r152+. `three` is pinned to ^0.169.0.
- Tailwind v4 needs no `tailwind.config.js`; the `@tailwindcss/vite` plugin and
  the `@import "tailwindcss";` line in `index.css` are the whole setup.
# coin-orbit
