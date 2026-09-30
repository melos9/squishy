"use strict";

/* =========================================================================
 * もちもち Squishy — pressurized soft-body physics toy
 * =======================================================================*/

const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");

/* ---- viewport / DPR handling ------------------------------------------ */
let W = 0;
let H = 0;
let DPR = 1;

let GROUND = 0; // y of the floor (kept above the bottom control panel)
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  GROUND = H - (W < 620 ? 210 : 180); // leave room for the HUD buttons
}
window.addEventListener("resize", resize);
resize();

/* ---- global state ------------------------------------------------------ */
const state = {
  gravity: true,
  sound: true,
};

const GRAVITY = 240; // px/s^2 when enabled (gentle: jelly rests as a plump mound)
const FLOOR_PAD = 4;
const WALL_BOUNCE = 0.35;
const FLOOR_BOUNCE = 0.6; // floor restitution (higher = bouncier landing)

/* pastel palettes: [fillTop, fillBottom, shadow] */
const PALETTES = [
  ["#fff2b0", "#ffd76e", "#e9a94c"], // きなこ
  ["#ffd0e4", "#ff9dc4", "#e56fa0"], // さくら
  ["#d6f5d0", "#a5e6a0", "#7bc27a"], // よもぎ
  ["#d4ecff", "#a9d3ff", "#79aee6"], // ラムネ
  ["#efe3ff", "#cbb4ff", "#a488e6"], // ぶどう
  ["#ffe6cf", "#ffc499", "#e59b66"], // みたらし
  ["#ffffff", "#f3f6ff", "#c9d2e6"], // しお
];

/* =========================================================================
 * SoftBody — a ring of mass-points with edge springs + internal pressure.
 * Pressure keeps it puffy; springs keep the outline; together they jiggle.
 * =======================================================================*/
class SoftBody {
  constructor(cx, cy, radius, palette) {
    this.n = Math.max(16, Math.round(radius * 0.34));
    this.radius = radius;
    this.palette = palette;
    this.blink = 0;
    this.blinkTimer = 1 + Math.random() * 4;
    this.squishFlash = 0; // 0..1, drives a happy face when squeezed

    this.points = [];
    for (let i = 0; i < this.n; i++) {
      const a = (i / this.n) * Math.PI * 2 - Math.PI / 2;
      this.points.push({
        x: cx + Math.cos(a) * radius,
        y: cy + Math.sin(a) * radius,
        vx: 0,
        vy: 0,
        fx: 0,
        fy: 0,
      });
    }
    // rest length between neighbours + rest area
    const seg = 2 * radius * Math.sin(Math.PI / this.n);
    this.restLen = seg;
    this.restArea = Math.PI * radius * radius;

    // tuning
    this.ks = 58; // edge spring stiffness
    this.kd = 2.4; // edge spring damping
    this.pressure = 13.5; // internal gas amount (stays puffy / round, resists squash)
    this.kRadial = 56; // shape-memory springs to center (jelly firmness)
    this.kRadialDamp = 3.0; // radial damping (controlled wobble)
    this.kBend = 34; // bending/smoothing springs (keeps outline smooth, no self-cross)
    this.kBendDamp = 1.6; // bending damping
  }

  center() {
    let x = 0;
    let y = 0;
    for (const p of this.points) {
      x += p.x;
      y += p.y;
    }
    return { x: x / this.n, y: y / this.n };
  }

  area() {
    let a = 0;
    const pts = this.points;
    for (let i = 0; i < this.n; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % this.n];
      a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) * 0.5;
  }

  /** integrate one sub-step */
  step(dt, grab) {
    const pts = this.points;
    const n = this.n;

    for (const p of pts) {
      p.fx = 0;
      p.fy = state.gravity ? GRAVITY : 0;
    }

    // edge springs (Hooke + damping)
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let dist = Math.hypot(dx, dy) || 1e-4;
      const nx = dx / dist;
      const ny = dy / dist;
      const rvel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      const f = (dist - this.restLen) * this.ks + rvel * this.kd;
      const fx = nx * f;
      const fy = ny * f;
      a.fx += fx;
      a.fy += fy;
      b.fx -= fx;
      b.fy -= fy;
    }

    // internal pressure: push each edge outward by pressure / area
    const area = this.area() || 1;
    const pv = (this.pressure * this.restArea) / area;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1e-4;
      // outward normal (polygon is CW/CCW consistent -> use right normal)
      const nx = dy / len;
      const ny = -dx / len;
      const force = len * pv;
      a.fx += nx * force;
      a.fy += ny * force;
      b.fx += nx * force;
      b.fy += ny * force;
    }

    // radial shape-memory springs: pull each point toward the centroid at its
    // rest radius. This is what makes it feel like firm jelly (holds its shape
    // and springs back as one body instead of stretching into a thin noodle).
    let cx = 0;
    let cy = 0;
    let cvx = 0;
    let cvy = 0;
    for (const p of pts) {
      cx += p.x;
      cy += p.y;
      cvx += p.vx;
      cvy += p.vy;
    }
    cx /= n;
    cy /= n;
    cvx /= n;
    cvy /= n;
    for (const p of pts) {
      let dx = p.x - cx;
      let dy = p.y - cy;
      const dist = Math.hypot(dx, dy) || 1e-4;
      const nx = dx / dist;
      const ny = dy / dist;
      const rvel = (p.vx - cvx) * nx + (p.vy - cvy) * ny;
      const f = (dist - this.radius) * this.kRadial + rvel * this.kRadialDamp;
      p.fx -= nx * f;
      p.fy -= ny * f;
    }

    // bending / smoothing springs: pull each point toward the midpoint of its
    // two neighbours. This resists high-frequency waviness in the outline and
    // stops the ring from folding over itself (no self-intersecting outline /
    // no doubled-up filled regions when squashed).
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const a = pts[(i - 1 + n) % n];
      const b = pts[(i + 1) % n];
      const mx = (a.x + b.x) * 0.5;
      const my = (a.y + b.y) * 0.5;
      const mvx = (a.vx + b.vx) * 0.5;
      const mvy = (a.vy + b.vy) * 0.5;
      p.fx += (mx - p.x) * this.kBend + (mvx - p.vx) * this.kBendDamp;
      p.fy += (my - p.y) * this.kBend + (mvy - p.vy) * this.kBendDamp;
    }

    // grab: softly spring every point toward where it sat (relative to the
    // pointer) at grab time. The body follows the cursor and holds its place,
    // but because the pull is springy — not a rigid pin — it still wobbles like
    // held jelly instead of freezing solid.
    if (grab && grab.body === this && grab.offs) {
      const kG = 78; // follow stiffness (lower = more wobble, higher = firmer)
      const dG = 6.5; // follow damping
      const offs = grab.offs;
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        const tx = grab.x + offs[i].x;
        const ty = grab.y + offs[i].y;
        p.fx += (tx - p.x) * kG - p.vx * dG;
        p.fy += (ty - p.y) * kG - p.vy * dG;
      }
    }

    // integrate (semi-implicit Euler)
    const MAXV = 3600; // clamp to keep stiff springs stable (no spikes)
    for (const p of pts) {
      p.vx += p.fx * dt;
      p.vy += p.fy * dt;
      p.vx *= 0.999;
      p.vy *= 0.999;
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > MAXV) {
        p.vx *= MAXV / sp;
        p.vy *= MAXV / sp;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }

    // stretch limit: no point may sit farther than maxStretch * radius from the
    // body centre (and no closer than minStretch). This hard cap stops the jelly
    // from being pulled into a long thread — drag past the limit and the whole
    // body moves instead of stretching.
    let sx = 0;
    let sy = 0;
    for (const p of pts) {
      sx += p.x;
      sy += p.y;
    }
    sx /= n;
    sy /= n;
    const maxR = this.radius * 1.35;
    const minR = this.radius * 0.5;
    for (const p of pts) {
      let dx = p.x - sx;
      let dy = p.y - sy;
      const d = Math.hypot(dx, dy) || 1e-4;
      if (d > maxR) {
        const nx = dx / d;
        const ny = dy / d;
        p.x = sx + nx * maxR;
        p.y = sy + ny * maxR;
        const vn = p.vx * nx + p.vy * ny; // kill outward velocity so it doesn't fight the cap
        if (vn > 0) {
          p.vx -= vn * nx;
          p.vy -= vn * ny;
        }
      } else if (d < minR) {
        p.x = sx + (dx / d) * minR;
        p.y = sy + (dy / d) * minR;
      }
    }

    // collide with walls / floor
    for (const p of pts) {
      if (p.x < FLOOR_PAD) {
        p.x = FLOOR_PAD;
        p.vx = Math.abs(p.vx) * WALL_BOUNCE;
      } else if (p.x > W - FLOOR_PAD) {
        p.x = W - FLOOR_PAD;
        p.vx = -Math.abs(p.vx) * WALL_BOUNCE;
      }
      if (p.y < FLOOR_PAD) {
        p.y = FLOOR_PAD;
        p.vy = Math.abs(p.vy) * WALL_BOUNCE;
      } else if (p.y > GROUND) {
        p.y = GROUND;
        p.vy = -Math.abs(p.vy) * FLOOR_BOUNCE;
        p.vx *= 0.9; // friction on the ground
      }
    }
  }

  update(dt) {
    // face timers
    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0) {
      this.blink = 0.16;
      this.blinkTimer = 1.5 + Math.random() * 4;
    }
    if (this.blink > 0) this.blink -= dt;
    if (this.squishFlash > 0) this.squishFlash = Math.max(0, this.squishFlash - dt * 1.6);
  }

  /** how much the shape is squeezed vs its rest area (0 = normal) */
  squeeze() {
    return 1 - Math.min(1, this.area() / this.restArea);
  }

  draw(ctx) {
    const pts = this.points;
    const n = this.n;
    const c = this.center();
    const [c1, c2, shadow] = this.palette;

    // soft ground shadow
    const gy = GROUND + 8;
    const dist = Math.max(0, gy - c.y);
    const shScale = Math.max(0.25, 1 - dist / (H * 0.9));
    ctx.save();
    ctx.globalAlpha = 0.18 * shScale;
    ctx.fillStyle = "#5a4a66";
    ctx.beginPath();
    ctx.ellipse(c.x, gy, this.radius * 0.9 * shScale, this.radius * 0.28 * shScale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // body outline via smooth closed spline
    ctx.beginPath();
    this.tracePath(ctx);
    ctx.closePath();

    // fill gradient
    const grad = ctx.createLinearGradient(c.x, c.y - this.radius, c.x, c.y + this.radius);
    grad.addColorStop(0, c1);
    grad.addColorStop(1, c2);
    ctx.fillStyle = grad;
    ctx.shadowColor = "rgba(120, 80, 110, 0.28)";
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 10;
    ctx.fill();
    ctx.shadowColor = "transparent";

    // rim light
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.stroke();

    // glossy highlight
    ctx.save();
    ctx.clip();
    const hx = c.x - this.radius * 0.32;
    const hy = c.y - this.radius * 0.42;
    const hl = ctx.createRadialGradient(hx, hy, 2, hx, hy, this.radius * 0.9);
    hl.addColorStop(0, "rgba(255,255,255,0.75)");
    hl.addColorStop(0.4, "rgba(255,255,255,0.18)");
    hl.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = hl;
    ctx.fillRect(c.x - this.radius * 1.4, c.y - this.radius * 1.4, this.radius * 2.8, this.radius * 2.8);
    ctx.restore();

    this.drawFace(ctx, c, shadow);
  }

  tracePath(ctx) {
    const pts = this.points;
    const n = this.n;
    // Catmull-Rom -> bezier for a squishy smooth outline
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const start = mid(pts[n - 1], pts[0]);
    ctx.moveTo(start.x, start.y);
    for (let i = 0; i < n; i++) {
      const cur = pts[i];
      const next = pts[(i + 1) % n];
      const m = mid(cur, next);
      ctx.quadraticCurveTo(cur.x, cur.y, m.x, m.y);
    }
  }

  drawFace(ctx, c, shadow) {
    // orient face with the blob's squish so it feels alive
    const sq = this.squeeze();
    const happy = Math.max(this.squishFlash, sq * 1.4);
    const r = this.radius;
    const eyeDx = r * 0.28;
    const eyeDy = -r * 0.05;
    const eyeR = Math.max(3, r * 0.09);
    const blinking = this.blink > 0;

    ctx.save();
    ctx.translate(c.x, c.y);

    // cheeks
    ctx.fillStyle = "rgba(255, 133, 170, 0.45)";
    ctx.beginPath();
    ctx.ellipse(-eyeDx - r * 0.06, r * 0.16, r * 0.11, r * 0.08, 0, 0, Math.PI * 2);
    ctx.ellipse(eyeDx + r * 0.06, r * 0.16, r * 0.11, r * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();

    // eyes
    ctx.fillStyle = "#4a3340";
    ctx.strokeStyle = "#4a3340";
    ctx.lineWidth = Math.max(2, r * 0.05);
    ctx.lineCap = "round";
    for (const sgn of [-1, 1]) {
      const ex = sgn * eyeDx;
      const ey = eyeDy;
      if (blinking || happy > 0.5) {
        // happy/blink: upward arc ^_^
        ctx.beginPath();
        ctx.arc(ex, ey + eyeR * 0.5, eyeR, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.ellipse(ex, ey, eyeR * 0.8, eyeR, 0, 0, Math.PI * 2);
        ctx.fill();
        // sparkle
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(ex - eyeR * 0.3, ey - eyeR * 0.35, eyeR * 0.28, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#4a3340";
      }
    }

    // mouth: small when calm, open "o" when squished
    ctx.fillStyle = "#c0607f";
    ctx.strokeStyle = "#7a4257";
    ctx.lineWidth = Math.max(2, r * 0.045);
    const my = r * 0.24;
    if (happy > 0.35) {
      const open = Math.min(1, happy) * r * 0.16;
      ctx.beginPath();
      ctx.ellipse(0, my + open * 0.3, r * 0.12, r * 0.08 + open, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(0, my - r * 0.02, r * 0.1, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
    }

    ctx.restore();
  }
}

/* =========================================================================
 * Particles (little sparkles/hearts on a good squish)
 * =======================================================================*/
const particles = [];
function spawnBurst(x, y, color) {
  const count = 8 + Math.floor(Math.random() * 6);
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 120 + Math.random() * 220;
    particles.push({
      x,
      y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - 120,
      life: 0.7 + Math.random() * 0.5,
      max: 1.2,
      size: 4 + Math.random() * 6,
      color,
      heart: Math.random() < 0.4,
    });
  }
}
function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.vy += 900 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt;
    if (p.life <= 0) particles.splice(i, 1);
  }
}
function drawParticles(ctx) {
  for (const p of particles) {
    const a = Math.max(0, p.life / p.max);
    ctx.globalAlpha = a;
    ctx.fillStyle = p.color;
    if (p.heart) {
      drawHeart(ctx, p.x, p.y, p.size);
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * a, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}
function drawHeart(ctx, x, y, s) {
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.3);
  ctx.bezierCurveTo(x - s, y - s * 0.5, x - s * 0.5, y - s, x, y - s * 0.35);
  ctx.bezierCurveTo(x + s * 0.5, y - s, x + s, y - s * 0.5, x, y + s * 0.3);
  ctx.fill();
}

/* =========================================================================
 * Sound (WebAudio, generated on the fly — no assets needed)
 * =======================================================================*/
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
}
function squishSound(strength = 0.5) {
  if (!state.sound || !audioCtx) return;
  const t = audioCtx.currentTime;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = "sine";
  const base = 260 + strength * 320;
  o.frequency.setValueAtTime(base, t);
  o.frequency.exponentialRampToValueAtTime(base * 0.55, t + 0.14);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.18 + strength * 0.2, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  o.connect(g).connect(audioCtx.destination);
  o.start(t);
  o.stop(t + 0.24);
}
function boingSound() {
  if (!state.sound || !audioCtx) return;
  const t = audioCtx.currentTime;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = "triangle";
  o.frequency.setValueAtTime(180, t);
  o.frequency.exponentialRampToValueAtTime(520, t + 0.08);
  o.frequency.exponentialRampToValueAtTime(240, t + 0.2);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
  o.connect(g).connect(audioCtx.destination);
  o.start(t);
  o.stop(t + 0.28);
}

/* =========================================================================
 * World setup
 * =======================================================================*/
let bodies = [];
function randomPalette() {
  return PALETTES[Math.floor(Math.random() * PALETTES.length)];
}
function addMochi(x, y) {
  const r = 52 + Math.random() * 38;
  const cx = x ?? 80 + Math.random() * (W - 160);
  const cy = y ?? H * 0.35 + Math.random() * (H * 0.2);
  const body = new SoftBody(cx, cy, r, randomPalette());
  // little drop-in pop
  for (const p of body.points) p.vy -= 60;
  bodies.push(body);
  updateCounter();
  return body;
}
function seedWorld() {
  bodies = [];
  particles.length = 0;
  addMochi(W * 0.5, H * 0.4);
}

function updateCounter() {
  const el = document.getElementById("counter");
  el.textContent = "🍡 " + bodies.length;
}

/* =========================================================================
 * Pointer interaction — grab the nearest surface point and drag
 * =======================================================================*/
const grab = { active: false, body: null, index: -1, x: 0, y: 0, vx: 0, vy: 0, lastX: 0, lastY: 0, offs: null };

function pointerPos(e) {
  const t = e.touches ? e.touches[0] : e;
  return { x: t.clientX, y: t.clientY };
}

function findGrab(x, y) {
  let best = null;
  let bestD = 40 * 40; // grab radius^2 for a nearby surface point
  let inside = null;
  // check topmost bodies first
  for (let bi = bodies.length - 1; bi >= 0; bi--) {
    const body = bodies[bi];
    for (let i = 0; i < body.n; i++) {
      const p = body.points[i];
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { body, index: i };
      }
    }
    if (!inside && pointInBody(body, x, y)) {
      inside = { body, index: nearestIndex(body, x, y) };
    }
  }
  return best || inside;
}

function nearestIndex(body, x, y) {
  let idx = 0;
  let bd = Infinity;
  for (let i = 0; i < body.n; i++) {
    const p = body.points[i];
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < bd) {
      bd = d;
      idx = i;
    }
  }
  return idx;
}

function pointInBody(body, x, y) {
  let inside = false;
  const pts = body.points;
  for (let i = 0, j = body.n - 1; i < body.n; j = i++) {
    const pi = pts[i];
    const pj = pts[j];
    if (
      pi.y > y !== pj.y > y &&
      x < ((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y) + pi.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function onDown(e) {
  ensureAudio();
  const { x, y } = pointerPos(e);
  const g = findGrab(x, y);
  if (g) {
    grab.active = true;
    grab.body = g.body;
    grab.index = g.index;
    grab.x = grab.lastX = x;
    grab.y = grab.lastY = y;
    grab.vx = 0;
    grab.vy = 0;
    // record every point's position relative to the pointer, so the body can be
    // softly sprung along as you drag: no slide on grab, follows, still wobbles.
    grab.offs = g.body.points.map((p) => ({ x: p.x - x, y: p.y - y }));
    // bring grabbed body to front
    const idx = bodies.indexOf(g.body);
    if (idx !== -1) {
      bodies.splice(idx, 1);
      bodies.push(g.body);
    }
    squishSound(0.35);
  }
  e.preventDefault();
}

function onMove(e) {
  if (!grab.active) return;
  const { x, y } = pointerPos(e);
  grab.x = x;
  grab.y = y;
  e.preventDefault();
}

function onUp() {
  if (!grab.active) return;
  const body = grab.body;
  // throw the whole jelly with the pointer's velocity
  if (body) {
    for (const p of body.points) {
      p.vx = grab.vx;
      p.vy = grab.vy;
    }
    const speed = Math.hypot(grab.vx, grab.vy);
    if (speed > 260) {
      boingSound();
      const c = body.center();
      body.squishFlash = 1;
      spawnBurst(c.x, c.y, body.palette[2]);
    }
  }
  grab.active = false;
  grab.body = null;
  grab.index = -1;
  grab.offs = null;
}

canvas.addEventListener("mousedown", onDown);
window.addEventListener("mousemove", onMove);
window.addEventListener("mouseup", onUp);
canvas.addEventListener("touchstart", onDown, { passive: false });
window.addEventListener("touchmove", onMove, { passive: false });
window.addEventListener("touchend", onUp);
window.addEventListener("touchcancel", onUp);

/* quick tap without drag = a satisfying poke */
let downPos = null;
let downTime = 0;
canvas.addEventListener("mousedown", (e) => {
  downPos = pointerPos(e);
  downTime = performance.now();
});
canvas.addEventListener(
  "touchstart",
  (e) => {
    downPos = pointerPos(e);
    downTime = performance.now();
  },
  { passive: false }
);
window.addEventListener("mouseup", (e) => handleTap(pointerPos(e)));
window.addEventListener("touchend", (e) => {
  if (downPos) handleTap(downPos);
});
function handleTap(pos) {
  if (!downPos) return;
  const moved = Math.hypot(pos.x - downPos.x, pos.y - downPos.y);
  const dtms = performance.now() - downTime;
  downPos = null;
  if (moved < 12 && dtms < 300) poke(pos.x, pos.y);
}

function poke(x, y) {
  for (let bi = bodies.length - 1; bi >= 0; bi--) {
    const body = bodies[bi];
    if (!pointInBody(body, x, y)) continue;
    const pts = body.points;
    const n = body.n;
    // impulse that pushes nearby points away from the finger (a squish)…
    const ix = new Array(n);
    const iy = new Array(n);
    let mx = 0;
    let my = 0;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const dx = p.x - x;
      const dy = p.y - y;
      const d = Math.hypot(dx, dy) || 1;
      let fx = 0;
      let fy = 0;
      if (d < body.radius * 1.3) {
        const f = (1 - d / (body.radius * 1.3)) * 900;
        fx = (dx / d) * f;
        fy = (dy / d) * f;
      }
      ix[i] = fx;
      iy[i] = fy;
      mx += fx;
      my += fy;
    }
    // …minus the average, so the shape deforms in place without gaining any net
    // momentum. It squishes where you tap instead of flying off to the edge.
    mx /= n;
    my /= n;
    for (let i = 0; i < n; i++) {
      pts[i].vx += ix[i] - mx;
      pts[i].vy += iy[i] - my;
    }
    body.squishFlash = 1;
    const c = body.center();
    spawnBurst(c.x, c.y - body.radius * 0.4, body.palette[2]);
    squishSound(0.8);
    return;
  }
}

/* =========================================================================
 * UI buttons
 * =======================================================================*/
document.getElementById("addBtn").addEventListener("click", () => {
  ensureAudio();
  addMochi();
  boingSound();
});
document.getElementById("resetBtn").addEventListener("click", () => {
  seedWorld();
});
const gravityBtn = document.getElementById("gravityBtn");
gravityBtn.addEventListener("click", () => {
  state.gravity = !state.gravity;
  gravityBtn.textContent = "⬇ 重力: " + (state.gravity ? "ON" : "OFF");
  gravityBtn.setAttribute("aria-pressed", String(state.gravity));
  if (!state.gravity) {
    for (const b of bodies) for (const p of b.points) p.vy -= 120;
  }
});
const soundBtn = document.getElementById("soundBtn");
soundBtn.addEventListener("click", () => {
  ensureAudio();
  state.sound = !state.sound;
  soundBtn.textContent = "🔊 音: " + (state.sound ? "ON" : "OFF");
  soundBtn.setAttribute("aria-pressed", String(state.sound));
});

/* =========================================================================
 * Gentle body-vs-body separation (center based — cheap & stable)
 * =======================================================================*/
function separateBodies() {
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i];
      const b = bodies[j];
      const ca = a.center();
      const cb = b.center();
      let dx = cb.x - ca.x;
      let dy = cb.y - ca.y;
      let d = Math.hypot(dx, dy) || 1e-4;
      const min = (a.radius + b.radius) * 0.92;
      if (d < min) {
        const push = ((min - d) / min) * 26;
        const nx = dx / d;
        const ny = dy / d;
        for (const p of a.points) {
          p.vx -= nx * push;
          p.vy -= ny * push;
        }
        for (const p of b.points) {
          p.vx += nx * push;
          p.vy += ny * push;
        }
      }
    }
  }
}

/* =========================================================================
 * Ground line
 * =======================================================================*/
function drawGround(ctx) {
  const g = ctx.createLinearGradient(0, GROUND, 0, H);
  g.addColorStop(0, "rgba(255,255,255,0.0)");
  g.addColorStop(1, "rgba(255,220,235,0.55)");
  ctx.fillStyle = g;
  ctx.fillRect(0, GROUND, W, H - GROUND);
  ctx.strokeStyle = "rgba(255,180,210,0.6)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, GROUND + 1);
  ctx.lineTo(W, GROUND + 1);
  ctx.stroke();
}

/* =========================================================================
 * Main loop (fixed-step physics for stability, rAF render)
 * =======================================================================*/
const STEP = 1 / 60;
const SUBSTEPS = 10;
let acc = 0;
let last = performance.now();

function frame(now) {
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.05) dt = 0.05; // clamp after tab switches
  acc += dt;

  // track pointer velocity for throwing
  if (grab.active) {
    grab.vx = (grab.x - grab.lastX) / Math.max(STEP, dt);
    grab.vy = (grab.y - grab.lastY) / Math.max(STEP, dt);
    grab.lastX = grab.x;
    grab.lastY = grab.y;
  }

  while (acc >= STEP) {
    const sdt = STEP / SUBSTEPS;
    for (let s = 0; s < SUBSTEPS; s++) {
      for (const b of bodies) b.step(sdt, grab.active ? grab : null);
      separateBodies();
    }
    for (const b of bodies) b.update(STEP);
    updateParticles(STEP);
    acc -= STEP;
  }

  render();
  requestAnimationFrame(frame);
}

function render() {
  ctx.clearRect(0, 0, W, H);
  drawGround(ctx);
  for (const b of bodies) b.draw(ctx);
  drawParticles(ctx);
}

seedWorld();
requestAnimationFrame(frame);
