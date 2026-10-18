// FreeWater AR on the bottle, in the phone's browser. No app to install.
//
// The camera looks for the codes and the tracking strip printed on this exact bottle. Because we printed the
// label, we know where every one of them sits on the wrap, so any one seen tells us where the bottle is and how
// it's turned. Two kinds of AR follow the bottle:
//   - bottle: a 3D model attached to it (on top, in front, circling it), moving and turning with it;
//   - label: a living label laid over the real one, all the way around, turning as the bottle turns.
// Without a camera (a laptop, or permission refused) a simulated bottle is drawn instead and the very same tracker
// runs on it, so the experience can be tried anywhere.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import jsQR from 'jsqr';
import * as G from '../../modules/ar/geometry';
import { findMarkers } from '../../modules/ar/markers';

type Wrap = { imageUrl?: string; videoUrl?: string; effect?: 'none' | 'shimmer' | 'ripple' | 'sparkle'; color?: string };
export interface ArBlock { mode: 'world' | 'bottle' | 'label'; title: string; model?: { glbUrl: string; alt: string }; placement?: 'top' | 'front' | 'orbit' | 'beside'; motion?: 'none' | 'spin' | 'float'; sizeIn?: number; wrap?: Wrap; caption?: string; cta?: { label: string; url: string } }
interface PrintedCode { text: string; role: 'slot' | 'receipt' | 'marker'; slotIndex?: number; markerId?: number; xIn: number; yIn: number; sizeIn: number; modules: number }
export interface ArMap {
  unitId: string;
  label: { widthIn: number; heightIn: number; seamIn: number; panelWidthIn: number };
  container: { shape: string; diameterIn?: number; heightIn?: number };
  codes: PrintedCode[];
  slots: { slotIndex: number; xIn: number; widthIn: number; advertiser: string; wrap: Wrap | null }[];
  labelSvgUrl: string;
}
export interface OpenOptions {
  block: ArBlock;
  slotIndex: number;
  getMap(): Promise<ArMap>;
  getLabelSvg(url: string): Promise<string>;
  /** Draw a simulated bottle instead of using the camera. */
  simulate?: boolean;
  /** Called once, when the AR has actually loaded (for billing an AR launch only when it worked). */
  onReady(loaded: boolean): void;
  onLink(url: string): void;
  onClose?(): void;
  accent?: string;
}

const CAMERA_FOV_DEG = 65; // across the long side; close enough for phones, and the tracker corrects for the rest
const PROC_W = 800; // the tracker reads frames at this width
const LOST_MS = 700;

const CSS = `
.fwar{position:fixed;inset:0;z-index:2147483000;background:#000;overflow:hidden;touch-action:none;font:15px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff;-webkit-user-select:none;user-select:none}
.fwar video,.fwar canvas.feed{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.fwar canvas.gl{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.fwar .bar{position:absolute;left:0;right:0;top:0;display:flex;align-items:center;gap:10px;padding:max(12px,env(safe-area-inset-top)) 14px 12px;background:linear-gradient(#000a,#0000)}
.fwar .bar b{flex:1;font-size:16px;text-shadow:0 1px 3px #000a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fwar button{font:inherit;border:0;cursor:pointer}
.fwar .x{width:40px;height:40px;border-radius:50%;background:#0008;color:#fff;font-size:22px;line-height:40px;text-align:center}
.fwar .bottom{position:absolute;left:0;right:0;bottom:0;display:flex;flex-direction:column;align-items:center;gap:10px;padding:14px 16px max(18px,env(safe-area-inset-bottom));background:linear-gradient(#0000,#000a)}
.fwar .hint{padding:8px 14px;border-radius:999px;background:#000b;font-size:14px;text-align:center;max-width:90%;transition:opacity .3s}
.fwar .caption{padding:10px 16px;border-radius:14px;background:#fffffff0;color:#0b0b0b;font-weight:600;text-align:center;max-width:92%;transition:opacity .3s,transform .3s}
.fwar .caption.off{opacity:0;transform:translateY(8px)}
.fwar .cta{min-height:48px;padding:0 22px;border-radius:999px;font-weight:700;font-size:16px;color:#0b0b0b}
.fwar .mode{background:none;color:#fff;text-decoration:underline;font-size:13px;opacity:.85}
.fwar .reticle{position:absolute;left:50%;top:46%;width:58vmin;height:58vmin;transform:translate(-50%,-50%);border:2px solid #fff8;border-radius:28px;pointer-events:none;transition:opacity .3s}
.fwar .badge{position:absolute;right:12px;top:calc(max(12px,env(safe-area-inset-top)) + 50px);padding:4px 9px;border-radius:999px;background:#0009;font-size:12px}
`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
const loadImage = (src: string, cors = false) => new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); if (cors) i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = () => rej(new Error('image')); i.src = src; });

/** Put the bottle's pose (camera frame: x right, y down, z ahead) onto a three.js object (y up, looking down -z). */
function applyPose(obj: THREE.Object3D, p: G.Pose) {
  const R = p.R, t = p.t;
  obj.matrix.set(R[0], R[1], R[2], t[0], -R[3], -R[4], -R[5], -t[1], -R[6], -R[7], -R[8], -t[2], 0, 0, 0, 1);
  obj.matrixWorldNeedsUpdate = true;
}
/** A three.js camera that sees exactly like a pinhole camera with these numbers, in a w by h picture. */
function setProjection(cam: THREE.Camera, K: G.Intrinsics, w: number, h: number, near = 0.5, far = 2000) {
  cam.projectionMatrix.set(2 * K.fx / w, 0, 1 - 2 * K.cx / w, 0, 0, 2 * K.fy / h, 2 * K.cy / h - 1, 0, 0, 0, -(far + near) / (far - near), -2 * far * near / (far - near), 0, 0, -1, 0);
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
}
const lensFor = (w: number, h: number): G.Intrinsics => { const f = Math.max(w, h) / 2 / Math.tan((CAMERA_FOV_DEG * Math.PI) / 360); return { fx: f, fy: f, cx: w / 2, cy: h / 2 }; };

export async function open(o: OpenOptions) {
  if (!document.getElementById('fwar-css')) { const s = el('style'); s.id = 'fwar-css'; s.textContent = CSS; document.head.append(s); }
  const root = el('div', 'fwar');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', o.block.title);
  const bar = el('div', 'bar'), close = el('button', 'x', '×'), title = el('b', '', o.block.title);
  close.setAttribute('aria-label', 'Close AR');
  bar.append(title, close);
  const bottom = el('div', 'bottom');
  const caption = el('div', 'caption off', o.block.caption ?? '');
  const hint = el('div', 'hint', 'Getting the AR ready…');
  const reticle = el('div', 'reticle');
  const badge = el('div', 'badge');
  badge.hidden = true;
  const cta = o.block.cta ? el('button', 'cta', o.block.cta.label) : null;
  if (cta) { cta.style.background = o.accent ?? '#7FC6EA'; cta.onclick = () => o.onLink(o.block.cta!.url); }
  const modeBtn = el('button', 'mode', o.simulate ? 'Use my camera' : 'Try it without the camera');
  bottom.append(caption, hint, ...(cta ? [cta] : []), modeBtn);
  const glCanvas = el('canvas', 'gl');
  root.append(glCanvas, reticle, bar, badge, bottom);
  document.body.append(root);
  document.documentElement.style.overflow = 'hidden';

  let stopped = false, raf = 0;
  const cleanups: (() => void)[] = [];
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    for (const c of cleanups) { try { c(); } catch { /* already gone */ } }
    root.remove();
    document.documentElement.style.overflow = '';
    o.onClose?.();
  };
  close.onclick = stop;
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') stop(); };
  document.addEventListener('keydown', onKey);
  cleanups.push(() => document.removeEventListener('keydown', onKey));
  modeBtn.onclick = () => { stop(); void open({ ...o, simulate: !o.simulate }); };

  // 1. What's printed on this bottle.
  let map: ArMap, labelImg: HTMLImageElement;
  try {
    map = await o.getMap();
    const svg = await o.getLabelSvg(map.labelSvgUrl);
    labelImg = await loadImage(URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })));
  } catch {
    hint.textContent = 'AR couldn’t load for this bottle. Check your connection and try again.';
    o.onReady(false);
    return;
  }
  if (stopped) return;
  const g: G.LabelGeometry = map.label;
  const R = G.radius(g), C = G.circumference(g);
  const containerH = map.container.heightIn ?? map.label.heightIn * 1.7;
  const below = Math.min(0.8, (containerH - g.heightIn) * 0.25), above = containerH - g.heightIn - below;
  const markers = new Map<number, PrintedCode>(), byText = new Map<string, PrintedCode>();
  for (const c of map.codes) { if (c.role === 'marker' && c.markerId !== undefined) markers.set(c.markerId, c); else byText.set(c.text, c); }

  // The printed label as a picture, starting at the seam, to wrap around a cylinder.
  const texW = 2048, texH = Math.round((2048 * g.heightIn) / C);
  const base = el('canvas'); base.width = texW; base.height = texH;
  const bctx = base.getContext('2d')!;
  bctx.fillStyle = '#fff'; bctx.fillRect(0, 0, texW, texH);
  bctx.drawImage(labelImg, (g.seamIn / g.widthIn) * labelImg.naturalWidth, 0, (C / g.widthIn) * labelImg.naturalWidth, labelImg.naturalHeight, 0, 0, texW, texH);
  const xToTex = (xIn: number) => ((xIn - g.seamIn) / C) * texW;

  // 2. Where the picture comes from: the camera, or a simulated bottle.
  type Source = { width: number; height: number; display: HTMLVideoElement | HTMLCanvasElement; draw(ctx: CanvasRenderingContext2D, w: number, h: number): void; tick?(dt: number): void };
  let source: Source;
  const startSim = (): Source => {
    const W = Math.max(800, Math.min(1280, root.clientWidth)), Hh = Math.round((W * root.clientHeight) / Math.max(1, root.clientWidth));
    const canvas = el('canvas', 'feed');
    canvas.width = W; canvas.height = Hh;
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    r.setSize(W, Hh, false);
    cleanups.push(() => r.dispose());
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#d9dee3');
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(-3, 4, 6); scene.add(sun);
    const bottle = new THREE.Group(); bottle.matrixAutoUpdate = false; scene.add(bottle);
    const metal = new THREE.MeshStandardMaterial({ color: 0xc9ced3, metalness: 0.75, roughness: 0.32 });
    const bodyH = below + g.heightIn + above * 0.35;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.998, R * 0.998, bodyH, 72), metal);
    body.position.y = -g.heightIn / 2 - below + bodyH / 2; bottle.add(body);
    const shoulder = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.42, R * 0.998, above * 0.45, 72), metal);
    shoulder.position.y = g.heightIn / 2 + above * 0.35 + (above * 0.45) / 2 - 0.001; bottle.add(shoulder);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.4, R * 0.42, above * 0.2, 48), new THREE.MeshStandardMaterial({ color: 0x2d2f33, metalness: 0.3, roughness: 0.5 }));
    neck.position.y = g.heightIn / 2 + above * 0.8 + (above * 0.2) / 2; bottle.add(neck);
    const tex = new THREE.CanvasTexture(base); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    const label = new THREE.Mesh(new THREE.CylinderGeometry(R, R, g.heightIn, 128, 1, true), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, metalness: 0.05 }));
    bottle.add(label);
    const cam = new THREE.Camera();
    const K = lensFor(W, Hh);
    setProjection(cam, K, W, Hh);
    // The simulated hand: turn the bottle by dragging; it also turns slowly by itself.
    let turn = G.angleOf(g, (map.codes.find((c) => c.role === 'slot' && c.slotIndex === o.slotIndex)?.xIn ?? g.widthIn / 2)), spin = 0.35, dragX: number | null = null, idle = 0;
    const dist = Math.max((containerH * 1.35 * K.fy) / Hh, (R * 2 * 2.4 * K.fx) / W); // the whole bottle in view, with room above it
    const down = (e: PointerEvent) => { dragX = e.clientX; spin = 0; idle = 0; };
    const move = (e: PointerEvent) => { if (dragX === null) return; turn += ((dragX - e.clientX) / Math.max(200, root.clientWidth)) * Math.PI * 1.4; dragX = e.clientX; };
    const up = () => { dragX = null; };
    root.addEventListener('pointerdown', down); root.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    cleanups.push(() => { window.removeEventListener('pointerup', up); });
    let t = 0;
    return {
      width: W, height: Hh, display: canvas,
      tick(dt) {
        t += dt; idle += dt;
        if (dragX === null && idle > 1.2) spin = Math.min(0.35, spin + dt * 0.2);
        turn += spin * dt;
        const pose = G.poseLookingAt(turn, dist, 0.12 + Math.sin(t * 0.6) * 0.04, [Math.sin(t * 0.4) * 0.15, containerH * 0.16, 0]);
        applyPose(bottle, pose);
        bottle.updateMatrixWorld(true);
        r.render(scene, cam);
      },
      draw(ctx, w, h) { ctx.drawImage(canvas, 0, 0, w, h); },
    };
  };
  if (o.simulate) {
    source = startSim();
    badge.textContent = 'Simulated bottle · drag to turn it'; badge.hidden = false;
  } else {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
      if (stopped) { stream.getTracks().forEach((tr) => tr.stop()); return; }
      const video = el('video', 'feed');
      video.muted = true; video.playsInline = true; video.setAttribute('playsinline', ''); video.srcObject = stream;
      await video.play();
      cleanups.push(() => stream.getTracks().forEach((tr) => tr.stop()));
      source = { width: video.videoWidth, height: video.videoHeight, display: video, draw(ctx, w, h) { ctx.drawImage(video, 0, 0, w, h); } };
    } catch {
      source = startSim();
      badge.textContent = 'No camera here · simulated bottle'; badge.hidden = false;
    }
  }
  if (stopped) return;
  root.insertBefore(source.display, glCanvas);

  // 3. The AR scene, drawn over the picture.
  const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  cleanups.push(() => renderer.dispose());
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.4));
  const key = new THREE.DirectionalLight(0xffffff, 1.8); key.position.set(-2, 5, 4); scene.add(key);
  const camera = new THREE.Camera();
  const anchor = new THREE.Group(); anchor.matrixAutoUpdate = false; anchor.visible = false; scene.add(anchor);
  // An invisible bottle: it hides whatever passes behind the real one.
  const occluder = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.99, R * 0.99, containerH, 48), new THREE.MeshBasicMaterial({ colorWrite: false }));
  occluder.position.y = -g.heightIn / 2 - below + containerH / 2; occluder.renderOrder = -1; anchor.add(occluder);

  let ready = false;
  const markReady = () => { if (!ready) { ready = true; o.onReady(true); } };
  let frameUpdate: ((t: number, facing: number) => void) | null = null;

  if (o.block.mode === 'label') {
    // The living label: the printed label, with the parts owned by living-label ads brought to life.
    const live = el('canvas'); live.width = texW; live.height = texH;
    const lctx = live.getContext('2d')!;
    const tex = new THREE.CanvasTexture(live); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.012, R * 1.012, g.heightIn * 1.004, 160, 1, true), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
    anchor.add(sleeve);
    const regions = map.slots.map((s) => ({ ...s, wrap: s.slotIndex === o.slotIndex ? (o.block.wrap ?? s.wrap) : s.wrap })).filter((s) => s.wrap);
    const media = new Map<number, HTMLImageElement | HTMLVideoElement>();
    for (const s of regions) {
      if (s.wrap!.videoUrl) { const v = el('video'); v.crossOrigin = 'anonymous'; v.muted = true; v.loop = true; v.playsInline = true; v.src = s.wrap!.videoUrl; v.play().catch(() => {}); media.set(s.slotIndex, v); cleanups.push(() => v.pause()); }
      else if (s.wrap!.imageUrl) loadImage(s.wrap!.imageUrl, true).then((i) => media.set(s.slotIndex, i)).catch(() => {});
    }
    const stars = Array.from({ length: 110 }, (_, i) => ({ u: (i * 0.618) % 1, v: ((i * 0.377) % 1) * 0.85 + 0.05, p: i * 1.7 }));
    frameUpdate = (t) => {
      lctx.globalCompositeOperation = 'source-over';
      lctx.globalAlpha = 1;
      lctx.drawImage(base, 0, 0);
      for (const s of regions) {
        const w = s.wrap!, x0 = xToTex(s.xIn), x1 = xToTex(s.xIn + s.widthIn), rw = x1 - x0;
        lctx.save();
        lctx.beginPath(); lctx.rect(x0, 0, rw, texH); lctx.clip();
        const m = media.get(s.slotIndex);
        if (m) {
          const mw = m instanceof HTMLVideoElement ? m.videoWidth : m.naturalWidth, mh = m instanceof HTMLVideoElement ? m.videoHeight : m.naturalHeight;
          if (mw && mh) { const k = Math.max(rw / mw, texH / mh); try { lctx.drawImage(m, x0 + (rw - mw * k) / 2, (texH - mh * k) / 2, mw * k, mh * k); } catch { /* not ready */ } }
        }
        if (w.effect === 'ripple') {
          // Water running across the art.
          for (let y = 0; y < texH; y += 6) { const dx = Math.sin(y / 23 + t * 2.4) * 9 + Math.sin(y / 61 - t * 1.3) * 5; lctx.drawImage(m ? lctx.canvas : base, x0, y, rw, 6, x0 + dx, y, rw, 6); }
          lctx.fillStyle = w.color ?? '#7FC6EA'; lctx.globalAlpha = 0.16 + 0.06 * Math.sin(t * 1.7); lctx.fillRect(x0, 0, rw, texH); lctx.globalAlpha = 1;
        } else if (w.color) {
          // A slow wave of the advertiser's color washing across their part of the label.
          const gx = x0 + ((t * 0.25) % 1) * rw * 1.6 - rw * 0.3;
          const wash = lctx.createRadialGradient(gx, texH * 0.5, 10, gx, texH * 0.5, rw * 0.6);
          wash.addColorStop(0, w.color); wash.addColorStop(1, 'rgba(0,0,0,0)');
          lctx.globalAlpha = 0.35 + 0.15 * Math.sin(t * 2); lctx.fillStyle = wash; lctx.fillRect(x0, 0, rw, texH); lctx.globalAlpha = 1;
        }
        if (w.effect === 'shimmer' || !w.effect) {
          const band = ((t * 0.45) % 1.6 - 0.3) * rw + x0;
          const grad = lctx.createLinearGradient(band - 140, 0, band + 140, texH * 0.3);
          grad.addColorStop(0, 'rgba(255,255,255,0)'); grad.addColorStop(0.5, 'rgba(255,255,255,0.55)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
          lctx.globalCompositeOperation = 'lighter'; lctx.fillStyle = grad; lctx.fillRect(x0, 0, rw, texH); lctx.globalCompositeOperation = 'source-over';
        }
        if (w.effect === 'sparkle') {
          lctx.fillStyle = '#fff';
          for (const st of stars) {
            const a = Math.max(0, Math.sin(t * 2.2 + st.p)); if (a < 0.05) continue;
            const x = x0 + st.u * rw, y = st.v * texH, r2 = 5 + a * 18;
            lctx.globalAlpha = a;
            lctx.beginPath(); lctx.moveTo(x, y - r2); lctx.lineTo(x + r2 * 0.22, y); lctx.lineTo(x, y + r2); lctx.lineTo(x - r2 * 0.22, y); lctx.closePath(); lctx.fill();
            lctx.beginPath(); lctx.moveTo(x - r2, y); lctx.lineTo(x, y + r2 * 0.22); lctx.lineTo(x + r2, y); lctx.lineTo(x, y - r2 * 0.22); lctx.closePath(); lctx.fill();
          }
          lctx.globalAlpha = 1;
        }
        lctx.restore();
      }
      tex.needsUpdate = true;
    };
    markReady();
  } else if (o.block.mode === 'bottle' && o.block.model) {
    const holder = new THREE.Group(); anchor.add(holder);
    const size = o.block.sizeIn ?? 3;
    const place = o.block.placement ?? 'top';
    const topY = g.heightIn / 2 + above;
    // A soft shadow where the model sits on the bottle's top.
    if (place === 'top') {
      const sh = el('canvas'); sh.width = sh.height = 128; const sc = sh.getContext('2d')!;
      const rg = sc.createRadialGradient(64, 64, 4, 64, 64, 64); rg.addColorStop(0, 'rgba(0,0,0,.45)'); rg.addColorStop(1, 'rgba(0,0,0,0)'); sc.fillStyle = rg; sc.fillRect(0, 0, 128, 128);
      const disc = new THREE.Mesh(new THREE.PlaneGeometry(size * 0.9, size * 0.9), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sh), transparent: true, depthWrite: false }));
      disc.rotation.x = -Math.PI / 2; disc.position.y = topY + 0.02; anchor.add(disc);
    }
    new GLTFLoader().load(o.block.model.glbUrl, (gltf) => {
      const m = gltf.scene;
      const box = new THREE.Box3().setFromObject(m), dim = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
      const k = size / Math.max(dim.x, dim.y, dim.z, 1e-6);
      m.scale.setScalar(k);
      m.position.set(-mid.x * k, -box.min.y * k, -mid.z * k); // sits on its base, centered
      holder.add(m);
      markReady();
    }, undefined, () => { hint.textContent = 'The 3D model didn’t load.'; o.onReady(false); });
    frameUpdate = (t, facing) => {
      const motion = o.block.motion ?? 'spin';
      const bob = motion === 'float' ? Math.sin(t * 2) * 0.25 : 0;
      holder.rotation.y = motion === 'spin' ? t * 0.9 : facing;
      if (place === 'top') holder.position.set(0, topY + bob, 0);
      else {
        const ang = place === 'orbit' ? t * 0.8 : place === 'beside' ? facing + Math.PI / 2 : facing;
        const rr = R + size * 0.55 + (place === 'orbit' ? 0.6 : 0.4);
        holder.position.set(Math.sin(ang) * rr, (place === 'front' ? -size / 2 : -g.heightIn / 2) + bob + (place === 'orbit' ? Math.sin(t * 0.8) * 0.6 : 0), Math.cos(ang) * rr);
        if (motion !== 'spin') holder.rotation.y = ang;
      }
    };
  } else {
    hint.textContent = 'This AR needs a 3D model.';
    o.onReady(false);
  }

  // 4. The loop: read the picture, find the bottle, draw.
  const proc = el('canvas');
  const pw = Math.min(PROC_W, source.width), ph = Math.round((pw * source.height) / source.width);
  proc.width = pw; proc.height = ph;
  const pctx = proc.getContext('2d', { willReadFrequently: true })!;
  const gray = new Uint8Array(pw * ph);
  const Kp = (() => { const K = lensFor(source.width, source.height), s = pw / source.width; return { fx: K.fx * s, fy: K.fy * s, cx: K.cx * s, cy: K.cy * s }; })();
  let pose: G.Pose | null = null, seenAt = 0, frames = 0, lastT = performance.now(), lastTrack = 0, everSeen = false, reads = 0, found = 0;

  const track = (now: number) => {
    source.draw(pctx, pw, ph);
    const img = pctx.getImageData(0, 0, pw, ph);
    const d = img.data;
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (d[j]! * 77 + d[j + 1]! * 150 + d[j + 2]! * 29) >> 8;
    const obs: G.Observation[] = [];
    let biggest = 0;
    for (const m of findMarkers(gray, pw, ph, { minSide: 8 })) {
      const spot = markers.get(m.id);
      if (!spot) continue;
      obs.push({ spot, corners: m.corners });
      biggest = Math.max(biggest, Math.hypot(m.corners[1]![0] - m.corners[0]![0], m.corners[1]![1] - m.corners[0]![1]));
    }
    // The QR codes are read too when few markers are in view (or the bottle has no strip): they're bigger, and they say which bottle this is.
    if (obs.length < 2 && frames % 2 === 0) {
      const q = jsQR(d, pw, ph, { inversionAttempts: 'dontInvert' });
      const spot = q ? byText.get(q.data) : undefined;
      if (q && spot) {
        const L = q.location;
        obs.push({ spot, corners: [[L.topLeftCorner.x, L.topLeftCorner.y], [L.topRightCorner.x, L.topRightCorner.y], [L.bottomRightCorner.x, L.bottomRightCorner.y], [L.bottomLeftCorner.x, L.bottomLeftCorner.y]] });
        biggest = Math.max(biggest, 40);
      }
    }
    reads++;
    if (!obs.length) return;
    const recent = pose && now - seenAt < LOST_MS ? pose : undefined;
    let sol = G.solvePoseMulti(Kp, g, obs, recent);
    if (!sol || sol.error > 2.5) sol = G.solvePoseMulti(Kp, g, obs);
    if (!sol || sol.error > 2.5 || (obs.length < 2 && biggest < 16)) return;
    pose = recent ? G.blendPose(recent, sol.pose, 0.55) : sol.pose;
    seenAt = now; found++;
    everSeen = true;
  };

  const resize = () => {
    const Wd = root.clientWidth, Hd = root.clientHeight;
    renderer.setSize(Wd, Hd, false);
    // The picture fills the screen (cropped, like object-fit: cover): the same lens, scaled and shifted to match.
    const s = Math.max(Wd / source.width, Hd / source.height), K = lensFor(source.width, source.height);
    setProjection(camera, { fx: K.fx * s, fy: K.fy * s, cx: K.cx * s + (Wd - source.width * s) / 2, cy: K.cy * s + (Hd - source.height * s) / 2 }, Wd, Hd);
  };
  resize();
  const ro = new ResizeObserver(resize); ro.observe(root); cleanups.push(() => ro.disconnect());

  const t0 = performance.now();
  const loop = () => {
    if (stopped) return;
    raf = requestAnimationFrame(loop);
    const now = performance.now(), dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now; frames++;
    source.tick?.(dt);
    if (now - lastTrack > 30) { lastTrack = now; try { track(now); } catch { /* a bad frame */ } }
    const tracking = !!pose && now - seenAt < LOST_MS;
    anchor.visible = tracking;
    reticle.style.opacity = tracking ? '0' : '1';
    caption.classList.toggle('off', !tracking || !caption.textContent);
    hint.style.opacity = tracking && everSeen ? '0' : '1';
    if (!tracking) hint.textContent = everSeen ? 'Hold the bottle so its label faces the camera' : o.block.mode === 'label' ? 'Point your camera at the label, then turn the bottle' : 'Point your camera at the bottle’s label';
    if (tracking) { applyPose(anchor, pose!); anchor.updateMatrixWorld(true); }
    frameUpdate?.((now - t0) / 1000, pose ? G.facingAngle(pose) : 0);
    renderer.render(scene, camera);
    (window as any).__FWAR_STATE = { tracking, everSeen, facing: pose ? G.facingAngle(pose) : null, ready, reads, found };
  };
  hint.textContent = 'Point your camera at the bottle’s label';
  loop();
  return { close: stop };
}

(window as any).FWAR = { open };
