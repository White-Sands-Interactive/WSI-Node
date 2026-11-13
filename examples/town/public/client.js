// Sandy Shores browser client: draws the town on a canvas and sends what the
// visitor does to the game server. It holds no game rules and no character
// logic; everything it shows comes from the server.

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const $ = (id) => document.getElementById(id);

let socket = null;
let me = null;
let world = null; // init payload
let hour = 8;
let focus = null;
let items = [];
const entities = new Map(); // name -> { x, y, tx, ty, f, m, s, t, k, l, step }
const bubbles = new Map(); // name -> { text, until }
const emotes = new Map(); // name -> { emote, until }
const people = new Map(); // name -> { affinity, label, note, status }
const camera = { x: 0, y: 26 };
let scale = 6;
let dpr = 1;

const VISITOR_LOOKS = [
  { skin: "#f0c8a0", shirt: "#3c8cdc", hair: "#6a4428" },
  { skin: "#c88c64", shirt: "#e0a020", hair: "#1e1e24" },
  { skin: "#f4d4b4", shirt: "#30a878", hair: "#c8502c" },
  { skin: "#8c5c40", shirt: "#e05070", hair: "#101014" },
  { skin: "#e8b890", shirt: "#7860d8", hair: "#e8d070" },
  { skin: "#d8a47c", shirt: "#20a0b0", hair: "#503020" },
];

// ---------------------------------------------------------------- canvas setup
function resize() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.floor(innerWidth * dpr);
  canvas.height = Math.floor(innerHeight * dpr);
  scale = Math.max(5.5, Math.min(11, Math.min(innerWidth, innerHeight) / 78));
}
addEventListener("resize", resize);
resize();

function makePattern(size, paint) {
  const tile = document.createElement("canvas");
  tile.width = tile.height = size;
  paint(tile.getContext("2d"), size);
  return ctx.createPattern(tile, "repeat");
}
// A fixed pseudo-random sequence, so textures look the same on every load.
function seeded(seed) {
  let value = seed;
  return () => {
    value = (value * 16807) % 2147483647;
    return value / 2147483647;
  };
}
const grassPattern = makePattern(96, (g, size) => {
  const random = seeded(7);
  g.fillStyle = "#7fbf6a";
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 260; i++) {
    g.fillStyle = ["#74b560", "#8bc975", "#6fae5c", "#95d07e"][Math.floor(random() * 4)];
    const x = random() * size;
    const y = random() * size;
    g.fillRect(x, y, 1.5, 3 + random() * 3);
  }
});
const sandPattern = makePattern(96, (g, size) => {
  const random = seeded(11);
  g.fillStyle = "#f0dcae";
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 300; i++) {
    g.fillStyle = ["#e8d2a0", "#f6e6c0", "#e2c992"][Math.floor(random() * 3)];
    g.fillRect(random() * size, random() * size, 1.5, 1.5);
  }
});
const cobblePattern = makePattern(64, (g, size) => {
  const random = seeded(3);
  g.fillStyle = "#d9c7a8";
  g.fillRect(0, 0, size, size);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      g.fillStyle = ["#e4d4b8", "#cfbb98", "#dccaa8", "#c8b490"][Math.floor(random() * 4)];
      const x = col * 16 + (row % 2) * 8;
      g.beginPath();
      g.roundRect(x + 1, row * 16 + 1, 14, 14, 4);
      g.fill();
    }
  }
});
const woodPattern = makePattern(48, (g, size) => {
  g.fillStyle = "#b98a5e";
  g.fillRect(0, 0, size, size);
  g.strokeStyle = "#a57a50";
  g.lineWidth = 1.5;
  for (let y = 0; y <= size; y += 12) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(size, y);
    g.stroke();
  }
});

// ---------------------------------------------------------------- drawing helpers
// World drawing happens in world units; text is drawn in screen pixels.
function toScreen(x, y) {
  return { x: (x - camera.x) * scale + innerWidth / 2, y: (y - camera.y) * scale + innerHeight / 2 };
}
function worldTransform() {
  ctx.setTransform(scale * dpr, 0, 0, scale * dpr, (innerWidth / 2 - camera.x * scale) * dpr, (innerHeight / 2 - camera.y * scale) * dpr);
}
function screenTransform() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function patternFill(pattern) {
  // Patterns are authored in pixels; keep them a constant size on screen.
  pattern.setTransform(new DOMMatrix().scale(1 / scale));
  ctx.fillStyle = pattern;
}
function rect(x, y, w, h, color, radius = 0) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - h / 2, w, h, radius);
  ctx.fill();
}
function circle(x, y, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}
function ellipse(x, y, rx, ry, color, rotation = 0) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rotation, 0, Math.PI * 2);
  ctx.fill();
}
function shadow(x, y, rx, ry) {
  ellipse(x, y, rx, ry, "rgba(30,40,30,0.22)");
}
function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const channel = (shift) => Math.max(0, Math.min(255, ((n >> shift) & 255) + amount));
  return `rgb(${channel(16)},${channel(8)},${channel(0)})`;
}

// ---------------------------------------------------------------- ground
function drawGround(time) {
  const b = world.bounds;
  // Sea, everywhere first.
  screenTransform();
  const sea = ctx.createLinearGradient(0, 0, 0, innerHeight);
  sea.addColorStop(0, "#3fb0d0");
  sea.addColorStop(1, "#2a86b8");
  ctx.fillStyle = sea;
  ctx.fillRect(0, 0, innerWidth, innerHeight);
  worldTransform();
  // Wave glints.
  ctx.strokeStyle = "rgba(255,255,255,0.28)";
  ctx.lineWidth = 0.35;
  for (let row = 0; row < 9; row++) {
    const y = 202 + row * 6;
    for (let x = b.minX - 40; x < b.maxX + 40; x += 22) {
      const offset = ((time * 3 + row * 9) % 22) + (row % 2) * 11;
      ctx.beginPath();
      ctx.moveTo(x + offset, y);
      ctx.quadraticCurveTo(x + offset + 3, y - 1.2, x + offset + 6, y);
      ctx.stroke();
    }
  }
  // Sand with a wet edge and moving foam.
  patternFill(sandPattern);
  ctx.fillRect(b.minX - 60, 60, b.maxX - b.minX + 120, 134);
  const wet = ctx.createLinearGradient(0, 176, 0, 196);
  wet.addColorStop(0, "rgba(200,170,110,0)");
  wet.addColorStop(1, "rgba(170,140,90,0.55)");
  ctx.fillStyle = wet;
  ctx.fillRect(b.minX - 60, 176, b.maxX - b.minX + 120, 20);
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.beginPath();
  ctx.moveTo(b.minX - 60, 200);
  for (let x = b.minX - 60; x <= b.maxX + 60; x += 6) {
    ctx.lineTo(x, 193 + Math.sin(x * 0.09 + time * 1.3) * 1.4 + Math.sin(time * 0.7) * 1.2);
  }
  ctx.lineTo(b.maxX + 60, 200);
  ctx.closePath();
  ctx.fill();
  // Grass, with a soft edge into the sand.
  patternFill(grassPattern);
  ctx.beginPath();
  ctx.moveTo(b.minX - 60, b.minY - 40);
  ctx.lineTo(b.maxX + 60, b.minY - 40);
  ctx.lineTo(b.maxX + 60, 68);
  for (let x = b.maxX + 60; x >= b.minX - 60; x -= 8) ctx.lineTo(x, 68 + Math.sin(x * 0.07) * 3);
  ctx.closePath();
  ctx.fill();
  // Paths and plaza.
  patternFill(cobblePattern);
  for (const [x, y, w, h] of [[0, -70, 10, 70], [0, 62, 10, 60], [0, -100, 264, 8], [40, 4, 40, 8], [-40, 4, 40, 8], [-88, -70, 8, 60], [-104, -44, 30, 6]]) {
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h / 2, w, h, 3);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.roundRect(-36, -36, 72, 72, 10);
  ctx.fill();
  ctx.strokeStyle = "rgba(120,100,70,0.35)";
  ctx.lineWidth = 0.6;
  ctx.stroke();
  // Flat props.
  for (const prop of world.props) {
    if (prop.type === "pier") drawPier(prop);
    else if (prop.type === "garden") drawGarden(prop);
    else if (prop.type === "towel") drawTowel(prop);
    else if (prop.type === "building" || prop.type === "cottage") drawFloor(prop);
  }
}

function drawPier(p) {
  ctx.fillStyle = "rgba(20,60,90,0.25)";
  ctx.fillRect(p.x - p.w / 2 + 1, p.y - p.h / 2 + 2, p.w, p.h);
  patternFill(woodPattern);
  ctx.fillRect(p.x - p.w / 2, p.y - p.h / 2, p.w, p.h);
  ctx.fillStyle = "#7a5638";
  for (let y = p.y - p.h / 2 + 4; y < p.y + p.h / 2; y += 14) {
    ctx.fillRect(p.x - p.w / 2 - 0.8, y, 1.6, 1.6);
    ctx.fillRect(p.x + p.w / 2 - 0.8, y, 1.6, 1.6);
  }
}
function drawGarden(p) {
  rect(p.x, p.y, p.w, p.h, "#7a5a40", 1.5);
  const colors = ["#ff6b8a", "#ffd24a", "#ff9a3c", "#c77dff", "#ff5c5c", "#ffffff"];
  for (let i = 0; i < 12; i++) {
    const x = p.x - p.w / 2 + 1.6 + (i % 6) * 2.2;
    const y = p.y - 1.6 + Math.floor(i / 6) * 3.2;
    circle(x, y + 0.5, 0.5, "#4f9a50");
    circle(x, y, 0.8, colors[i % colors.length]);
    circle(x, y, 0.3, "#fff6c8");
  }
}
function drawTowel(p) {
  rect(p.x, p.y, p.w, p.h, ["#ff7a7a", "#5cc8e8", "#ffd060"][Math.abs(p.x) % 3], 0.6);
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.fillRect(p.x - p.w / 2, p.y - 1, p.w, 0.7);
  ctx.fillRect(p.x - p.w / 2, p.y + 1, p.w, 0.7);
}
function drawFloor(p) {
  rect(p.x + 1.2, p.y + 1.6, p.w + 1, p.h + 1, "rgba(30,40,30,0.18)", 2);
  patternFill(woodPattern);
  ctx.beginPath();
  ctx.roundRect(p.x - p.w / 2, p.y - p.h / 2, p.w, p.h, 1);
  ctx.fill();
  // Side walls.
  ctx.fillStyle = shade(p.color, -28);
  ctx.fillRect(p.x - p.w / 2, p.y - p.h / 2, 1.6, p.h);
  ctx.fillRect(p.x + p.w / 2 - 1.6, p.y - p.h / 2, 1.6, p.h);
  // Doormat.
  rect(p.x, p.y + p.h / 2 + 1.2, 6, 2, "rgba(150,80,60,0.6)", 0.5);
}

// ---------------------------------------------------------------- standing props
const drawProp = {
  building(p, time) {
    drawBackWall(p, 9);
  },
  cottage(p) {
    drawBackWall(p, 7);
  },
  tree(p, time) {
    const sway = Math.sin(time * 0.8 + p.x) * 0.3;
    shadow(p.x + 1.5, p.y + 1, 5.5, 2.6);
    rect(p.x, p.y - 2.5, 1.6, 6, "#7a5234", 0.5);
    circle(p.x + sway, p.y - 8, 5.2, "#3f8a48");
    circle(p.x - 2.4 + sway, p.y - 6.2, 3.6, "#4a9a52");
    circle(p.x + 2.6 + sway, p.y - 6.6, 3.8, "#56a85c");
    circle(p.x - 1 + sway, p.y - 9.6, 2.6, "#6cc070");
  },
  palm(p, time) {
    const sway = Math.sin(time + p.x) * 0.25;
    shadow(p.x + 2, p.y + 0.8, 5, 2);
    ctx.strokeStyle = "#a07850";
    ctx.lineWidth = 1.3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.quadraticCurveTo(p.x + 1.5, p.y - 6, p.x + 0.6 + sway, p.y - 11);
    ctx.stroke();
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2 + sway * 0.3;
      ellipse(p.x + 0.6 + sway + Math.cos(angle) * 3.2, p.y - 11 + Math.sin(angle) * 1.8, 3.6, 1.1, i % 2 ? "#3fa060" : "#4db870", angle);
    }
    circle(p.x + 0.6 + sway, p.y - 10.6, 0.7, "#7a5234");
  },
  fountain(p, time) {
    shadow(p.x + 1, p.y + 1.5, 8.5, 5);
    ellipse(p.x, p.y, 7.6, 5.6, "#b0b4bc");
    ellipse(p.x, p.y - 0.4, 6.6, 4.7, "#62c4e8");
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 0.25;
    for (let i = 0; i < 3; i++) {
      const grow = ((time * 0.6 + i / 3) % 1) * 5.5;
      ctx.globalAlpha = 1 - grow / 5.5;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y - 0.4, grow, grow * 0.7, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    rect(p.x, p.y - 2.6, 1.6, 4.4, "#c4c8d0", 0.6);
    circle(p.x, p.y - 5, 1.1, "#d8dce4");
    for (let i = 0; i < 5; i++) {
      const phase = (time * 1.6 + i * 0.2) % 1;
      circle(p.x + Math.sin(i * 2.4) * phase * 2.4, p.y - 5.4 - Math.sin(phase * Math.PI) * 1.6 + phase * 2, 0.28, "rgba(255,255,255,0.9)");
    }
  },
  boombox(p, time) {
    shadow(p.x + 0.5, p.y + 0.8, 2.8, 1);
    const beat = Math.abs(Math.sin(time * 5)) * 0.15;
    rect(p.x, p.y - 1.2, 4.2, 2.4 + beat, "#e6466e", 0.5);
    circle(p.x - 1.1, p.y - 1.1, 0.75 + beat, "#2a2a34");
    circle(p.x + 1.1, p.y - 1.1, 0.75 + beat, "#2a2a34");
    rect(p.x, p.y - 2.7, 2.6, 0.4, "#2a2a34", 0.2);
    ctx.fillStyle = "#e6466e";
    ctx.font = "2.2px Fredoka, sans-serif";
    for (let i = 0; i < 2; i++) {
      const phase = (time * 0.5 + i * 0.5) % 1;
      ctx.globalAlpha = 1 - phase;
      ctx.fillText(i ? "♪" : "♫", p.x - 1 + i * 2.4 + Math.sin(phase * 6) * 0.6, p.y - 3.4 - phase * 4);
    }
    ctx.globalAlpha = 1;
  },
  bench(p) {
    shadow(p.x + 0.5, p.y + 0.8, 4.4, 1.2);
    rect(p.x, p.y - 1.4, p.w, 0.9, "#8a5c3c", 0.3);
    rect(p.x, p.y - 0.4, p.w, 1.3, "#a87850", 0.3);
    rect(p.x - 3.2, p.y + 0.5, 0.6, 1, "#5c3c28");
    rect(p.x + 3.2, p.y + 0.5, 0.6, 1, "#5c3c28");
  },
  counter(p) {
    rect(p.x, p.y - 0.6, p.w, 3.4, "#7a5234", 0.5);
    rect(p.x, p.y - 2, p.w + 0.6, 1.2, "#c49a6c", 0.4);
    for (let i = 0; i < 3; i++) circle(p.x - 6 + i * 2.2, p.y - 2.2, 0.55, ["#ffd9a0", "#f0a060", "#ffe8c0"][i]);
  },
  espresso(p, time) {
    rect(p.x, p.y - 3.6, 3, 2.6, "#c0392b", 0.5);
    rect(p.x, p.y - 4.9, 2, 0.6, "#e8e8ee", 0.2);
    circle(p.x - 0.6, p.y - 3.6, 0.35, "#f8f8ff");
    circle(p.x + 0.6, p.y - 3.6, 0.35, "#f8f8ff");
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 0.25;
    for (let i = 0; i < 2; i++) {
      const phase = (time * 0.4 + i * 0.5) % 1;
      ctx.globalAlpha = 1 - phase;
      ctx.beginPath();
      ctx.moveTo(p.x + i - 0.5, p.y - 5.2 - phase * 2);
      ctx.quadraticCurveTo(p.x + i, p.y - 5.8 - phase * 2, p.x + i - 0.5, p.y - 6.4 - phase * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  },
  table(p) {
    shadow(p.x + 0.6, p.y + 1, 3, 1.4);
    rect(p.x, p.y, 0.7, 2, "#9a9aa4");
    ellipse(p.x, p.y - 1.4, 2.8, 1.8, "#fbfbfd");
    ellipse(p.x, p.y - 1.4, 2.8, 1.8, "rgba(0,0,0,0.04)");
    circle(p.x - 0.8, p.y - 1.6, 0.5, "#f0785a");
    circle(p.x + 0.9, p.y - 1.2, 0.4, "#ffd24a");
  },
  shelves(p) {
    rect(p.x, p.y - 3, p.w, 7, "#6e4a30", 0.5);
    const colors = ["#f0785a", "#5cc8e8", "#ffd24a", "#8bd06a", "#c77dff"];
    for (let row = 0; row < 3; row++) {
      rect(p.x, p.y - 5.2 + row * 2.1, p.w - 1, 0.3, "#8a6040");
      for (let i = 0; i < 9; i++) rect(p.x - 8.4 + i * 2.1, p.y - 5.9 + row * 2.1, 1.2, 1.1, colors[(i + row) % colors.length], 0.25);
    }
  },
  flowerstand(p) {
    shadow(p.x + 0.5, p.y + 1, 4.2, 1.4);
    rect(p.x, p.y - 0.8, p.w, 3, "#ec96b4", 0.5);
    ctx.fillStyle = "#fff";
    for (let i = 0; i < 4; i++) ctx.fillRect(p.x - 3.5 + i * 2, p.y - 2.3, 1, 3);
    const colors = ["#ff5c7a", "#ffd24a", "#ff9a3c", "#c77dff", "#ffffff"];
    for (let i = 0; i < 7; i++) {
      circle(p.x - 3 + i, p.y - 2.9 - (i % 2) * 0.5, 0.75, colors[i % colors.length]);
      circle(p.x - 3 + i, p.y - 2.9 - (i % 2) * 0.5, 0.25, "#fff6c8");
    }
  },
  easel(p) {
    shadow(p.x + 0.5, p.y + 0.6, 2.4, 0.9);
    ctx.strokeStyle = "#6e4a30";
    ctx.lineWidth = 0.4;
    ctx.beginPath();
    ctx.moveTo(p.x - 1.6, p.y + 0.4);
    ctx.lineTo(p.x, p.y - 6);
    ctx.lineTo(p.x + 1.6, p.y + 0.4);
    ctx.stroke();
    rect(p.x, p.y - 3.4, 4, 3.4, "#fffdf6", 0.2);
    circle(p.x - 0.8, p.y - 3.8, 0.8, "#5cc8e8");
    circle(p.x + 0.7, p.y - 3, 0.7, "#ffd24a");
    rect(p.x, p.y - 2.2, 3.4, 0.6, "#8bd06a", 0.2);
  },
  picnic(p) {
    shadow(p.x + 0.6, p.y + 1, 4.6, 1.6);
    rect(p.x, p.y + 0.9, p.w, 0.8, "#8a5c3c", 0.3);
    rect(p.x, p.y - 2.6, p.w, 0.8, "#8a5c3c", 0.3);
    rect(p.x, p.y - 0.9, p.w, 2.2, "#b98a5e", 0.3);
    rect(p.x - 1, p.y - 1, 3, 1.6, "#e84a4a", 0.2);
    ctx.fillStyle = "#fff";
    ctx.fillRect(p.x - 1.5, p.y - 1.8, 1, 0.8);
    ctx.fillRect(p.x - 0.5, p.y - 1, 1, 0.8);
  },
  campfire(p, time) {
    for (let i = 0; i < 7; i++) {
      const angle = (i / 7) * Math.PI * 2;
      ellipse(p.x + Math.cos(angle) * 2.6, p.y + Math.sin(angle) * 1.7, 0.75, 0.6, "#8c8c94");
    }
    rect(p.x, p.y, 3, 0.7, "#5c3c28", 0.3);
    for (let i = 0; i < 3; i++) {
      const flicker = Math.sin(time * 9 + i * 2) * 0.3;
      ctx.fillStyle = ["#ff7a1a", "#ffb030", "#ffe070"][i];
      ctx.beginPath();
      ctx.moveTo(p.x - 1.2 + i * 0.4, p.y);
      ctx.quadraticCurveTo(p.x + flicker, p.y - 4.4 + i * 1.1 + flicker, p.x + 1.2 - i * 0.4, p.y);
      ctx.fill();
    }
  },
  surfboards(p) {
    shadow(p.x + 0.5, p.y + 0.6, 3.4, 0.9);
    ellipse(p.x - 1.4, p.y - 4, 1.1, 4.6, "#ffc846", 0.12);
    ellipse(p.x - 1.4, p.y - 4, 0.25, 4.2, "#ff7a3c", 0.12);
    ellipse(p.x + 1.4, p.y - 4, 1.1, 4.6, "#5cc0e0", -0.1);
    ellipse(p.x + 1.4, p.y - 4, 0.25, 4.2, "#ffffff", -0.1);
  },
  fishingspot(p, time) {
    rect(p.x - 2, p.y - 0.8, 1.8, 1.6, "#5a7896", 0.3);
    ctx.strokeStyle = "#6e4a30";
    ctx.lineWidth = 0.3;
    ctx.beginPath();
    ctx.moveTo(p.x + 1, p.y);
    ctx.lineTo(p.x + 3, p.y - 6);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 0.12;
    ctx.beginPath();
    ctx.moveTo(p.x + 3, p.y - 6);
    ctx.lineTo(p.x + 5, p.y + 3 + Math.sin(time * 2) * 0.3);
    ctx.stroke();
    circle(p.x + 5, p.y + 3 + Math.sin(time * 2) * 0.3, 0.4, "#ff5c5c");
  },
  bed(p) {
    rect(p.x, p.y, p.w, p.h, "#7a5234", 0.6);
    rect(p.x, p.y + 0.6, p.w - 0.8, p.h - 2, "#7896d2", 0.5);
    rect(p.x, p.y - p.h / 2 + 1.6, p.w - 1.4, 1.8, "#ffffff", 0.6);
  },
  fridge(p) {
    rect(p.x, p.y - 2, 3, 6, "#f2f4f8", 0.5);
    rect(p.x, p.y - 2.6, 2.6, 0.2, "#c8ccd4");
    rect(p.x + 0.9, p.y - 3.6, 0.3, 1.2, "#aab0bc", 0.1);
    rect(p.x + 0.9, p.y - 1.2, 0.3, 1.6, "#aab0bc", 0.1);
  },
};

function drawBackWall(p, height) {
  const top = p.y - p.h / 2;
  // Wall face.
  ctx.fillStyle = p.color;
  ctx.fillRect(p.x - p.w / 2, top - height, p.w, height + 1.6);
  ctx.fillStyle = shade(p.color, -18);
  ctx.fillRect(p.x - p.w / 2, top + 0.4, p.w, 1.2);
  // Windows glow at night.
  const night = darkness();
  for (const offset of [-p.w / 4, p.w / 4]) {
    rect(p.x + offset, top - height / 2, 4, 3.4, night > 0.2 ? "#ffe9a0" : "#bfe6f4", 0.4);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 0.3;
    ctx.strokeRect(p.x + offset - 2, top - height / 2 - 1.7, 4, 3.4);
  }
  // Roof with an awning edge.
  ctx.fillStyle = p.roof;
  ctx.beginPath();
  ctx.roundRect(p.x - p.w / 2 - 1.5, top - height - 3, p.w + 3, 4, 1);
  ctx.fill();
  ctx.fillStyle = shade(p.roof, 30);
  for (let x = p.x - p.w / 2 - 1.5; x < p.x + p.w / 2 + 1; x += 3) {
    ctx.beginPath();
    ctx.arc(x + 1.5, top - height + 1, 1.5, 0, Math.PI);
    ctx.fill();
  }
}

// ---------------------------------------------------------------- characters
function lookOf(entity) {
  if (entity.k) return world.looks[entity.n] ?? VISITOR_LOOKS[0];
  return VISITOR_LOOKS[(entity.l ?? 0) % VISITOR_LOOKS.length];
}

function drawCharacter(entity, time) {
  const look = lookOf(entity);
  const x = entity.x;
  const emote = emotes.get(entity.n);
  const dancing = entity.s === "dancing" || emote?.emote === "dance";
  const sleeping = entity.s === "sleeping";
  entity.step = (entity.step ?? 0) + (entity.m ? 0.22 : 0);
  const bob = entity.m ? Math.abs(Math.sin(entity.step)) * 0.5 : dancing ? Math.abs(Math.sin(time * 7)) * 0.7 : Math.sin(time * 2 + x) * 0.08;
  const y = entity.y - bob;
  const lean = dancing ? Math.sin(time * 7) * 0.18 : 0;
  const dirX = Math.cos(entity.f);
  const dirY = Math.sin(entity.f);

  shadow(x, entity.y + 0.3, 1.9, 0.8);
  if (entity.n === me) {
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 0.25;
    ctx.beginPath();
    ctx.ellipse(x, entity.y + 0.3, 2.5, 1.1, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(lean);
  if (sleeping) ctx.globalAlpha = 0.85;
  // Legs.
  const stride = entity.m ? Math.sin(entity.step) * 0.6 : 0;
  rect(-0.6, -0.5 + stride * 0.4, 0.8, 1.4, "#3a3c4c", 0.3);
  rect(0.6, -0.5 - stride * 0.4, 0.8, 1.4, "#3a3c4c", 0.3);
  // Body.
  rect(0, -2.4, 2.6, 2.8, look.shirt, 1);
  rect(0, -1.5, 2.6, 0.5, shade(look.shirt, -24), 0.2);
  // Arms. One goes up for a wave, cheer, or high five.
  const raised = emote && ["wave", "cheer", "high_five", "hug", "point"].includes(emote.emote);
  const swing = entity.m ? Math.sin(entity.step) * 0.5 : 0;
  circle(-1.6, -2.3 - swing * 0.5, 0.55, look.skin);
  circle(1.6, raised ? -4.2 + Math.sin(time * 12) * 0.3 : -2.3 + swing * 0.5, 0.55, look.skin);
  if (emote?.emote === "cheer" || emote?.emote === "hug" || dancing) circle(-1.6, -4 + Math.sin(time * 9) * 0.3, 0.55, look.skin);
  // Head.
  circle(0, -5, 1.55, look.skin);
  // Hair: a cap that covers more of the head when facing away.
  ctx.fillStyle = look.hair;
  ctx.beginPath();
  if (dirY < -0.3) {
    ctx.arc(0, -5, 1.6, 0, Math.PI * 2);
  } else {
    ctx.arc(0, -5.2, 1.62, Math.PI * 1.02 - dirX * 0.25, Math.PI * 1.98 - dirX * 0.25);
  }
  ctx.fill();
  // Face.
  if (dirY >= -0.3) {
    const look2 = dirX * 0.5;
    if (sleeping) {
      ctx.strokeStyle = "#2a2a34";
      ctx.lineWidth = 0.16;
      ctx.beginPath();
      ctx.moveTo(-0.8 + look2, -4.9);
      ctx.lineTo(-0.3 + look2, -4.9);
      ctx.moveTo(0.3 + look2, -4.9);
      ctx.lineTo(0.8 + look2, -4.9);
      ctx.stroke();
    } else {
      const blink = Math.sin(time * 0.9 + x * 3) > 0.985 ? 0.05 : 0.24;
      ellipse(-0.55 + look2, -4.95, 0.2, blink, "#2a2a34");
      ellipse(0.55 + look2, -4.95, 0.2, blink, "#2a2a34");
      ctx.strokeStyle = "#8c4a3a";
      ctx.lineWidth = 0.14;
      ctx.beginPath();
      ctx.arc(look2, -4.5, 0.45, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
    }
    circle(-1 + look2, -4.5, 0.25, "rgba(255,120,120,0.35)");
    circle(1 + look2, -4.5, 0.25, "rgba(255,120,120,0.35)");
  }
  ctx.restore();
  if (sleeping) {
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = "600 1.8px Fredoka, sans-serif";
    const phase = (time * 0.5) % 1;
    ctx.globalAlpha = 1 - phase;
    ctx.fillText("z", x + 1.6 + phase, y - 6.5 - phase * 2.5);
    ctx.globalAlpha = 1;
  }
}

function wrap(text, maxWidth) {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Bubbles drawn this frame, so a later one can move up instead of covering one.
let bubbleBoxes = [];

function drawLabels(entity, time) {
  const at = toScreen(entity.x, entity.y);
  const headY = at.y - 7.6 * scale;
  ctx.textAlign = "center";
  // Name tag.
  ctx.font = `600 ${Math.round(scale * 1.9)}px Fredoka, sans-serif`;
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = "rgba(30,35,50,0.75)";
  ctx.strokeText(entity.n, at.x, at.y + scale * 2.9);
  ctx.fillStyle = entity.k ? "#fff6dc" : "#dff0ff";
  ctx.fillText(entity.n, at.x, at.y + scale * 2.9);
  let top = headY;
  if (entity.s) {
    ctx.font = `500 ${Math.round(scale * 1.6)}px Fredoka, sans-serif`;
    ctx.strokeText(entity.s, at.x, top);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(entity.s, at.x, top);
    top -= scale * 2;
  }
  const bubble = bubbles.get(entity.n);
  const now = performance.now();
  if (bubble && bubble.until > now) {
    ctx.font = "500 14px Fredoka, sans-serif";
    const lines = wrap(bubble.text, 230);
    const width = Math.max(...lines.map((line) => ctx.measureText(line).width)) + 22;
    const height = lines.length * 18 + 14;
    const fade = Math.min(1, (bubble.until - now) / 400, (now - bubble.from) / 150);
    ctx.globalAlpha = Math.max(0, fade);
    const left = Math.max(8, Math.min(innerWidth - width - 8, at.x - width / 2));
    let bottom = top - 8;
    for (const box of bubbleBoxes) {
      if (left < box.right && left + width > box.left && bottom > box.top - 4 && bottom - height < box.bottom) bottom = box.top - 6;
    }
    bubbleBoxes.push({ left, right: left + width, top: bottom - height, bottom });
    ctx.fillStyle = "rgba(30,35,50,0.18)";
    ctx.beginPath();
    ctx.roundRect(left + 2, bottom - height + 3, width, height, 12);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.roundRect(left, bottom - height, width, height, 12);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(at.x - 7, bottom - 1);
    ctx.lineTo(at.x, bottom + 9);
    ctx.lineTo(at.x + 7, bottom - 1);
    ctx.fill();
    ctx.fillStyle = "#262a36";
    lines.forEach((line, index) => ctx.fillText(line, left + width / 2, bottom - height + 22 + index * 18));
    ctx.globalAlpha = 1;
  } else if (entity.t) {
    // Thinking dots.
    const width = 44;
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.beginPath();
    ctx.roundRect(at.x - width / 2, top - 30, width, 22, 11);
    ctx.fill();
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = `rgba(60,70,90,${0.35 + 0.65 * Math.abs(Math.sin(time * 4 - i * 0.7))})`;
      ctx.beginPath();
      ctx.arc(at.x - 10 + i * 10, top - 19, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.textAlign = "left";
}

// ---------------------------------------------------------------- light
function darkness() {
  if (hour >= 7 && hour < 17.5) return 0;
  if (hour >= 17.5 && hour < 21) return ((hour - 17.5) / 3.5) * 0.58;
  if (hour >= 5 && hour < 7) return (1 - (hour - 5) / 2) * 0.58;
  return 0.58;
}

function drawLight(time) {
  const dark = darkness();
  screenTransform();
  if (hour >= 16.5 && hour < 19.5) {
    // Golden hour.
    ctx.fillStyle = `rgba(255,150,60,${0.12 * Math.sin(((hour - 16.5) / 3) * Math.PI)})`;
    ctx.fillRect(0, 0, innerWidth, innerHeight);
  }
  if (dark <= 0) return;
  ctx.fillStyle = `rgba(18,26,66,${dark})`;
  ctx.fillRect(0, 0, innerWidth, innerHeight);
  ctx.globalCompositeOperation = "lighter";
  const glow = (x, y, radius, color, strength) => {
    const at = toScreen(x, y);
    const gradient = ctx.createRadialGradient(at.x, at.y, 0, at.x, at.y, radius * scale);
    gradient.addColorStop(0, color.replace("A", String(strength * dark * 1.6)));
    gradient.addColorStop(1, color.replace("A", "0"));
    ctx.fillStyle = gradient;
    ctx.fillRect(at.x - radius * scale, at.y - radius * scale, radius * scale * 2, radius * scale * 2);
  };
  for (const prop of world.props) {
    if (prop.type === "campfire") glow(prop.x, prop.y - 1, 26 + Math.sin(time * 8) * 1.5, "rgba(255,150,60,A)", 0.75);
    else if (prop.type === "building") glow(prop.x, prop.y + 2, 26, "rgba(255,215,140,A)", 0.5);
    else if (prop.type === "cottage") glow(prop.x, prop.y + 2, 15, "rgba(255,215,140,A)", 0.42);
    else if (prop.type === "boombox") glow(prop.x, prop.y, 10, "rgba(230,70,160,A)", 0.4);
    else if (prop.type === "fountain") glow(prop.x, prop.y, 14, "rgba(120,200,255,A)", 0.3);
  }
  ctx.globalCompositeOperation = "source-over";
}

// ---------------------------------------------------------------- frame
function frame(ms) {
  requestAnimationFrame(frame);
  if (!world) return;
  const time = ms / 1000;
  const mine = entities.get(me);
  for (const entity of entities.values()) {
    entity.x += (entity.tx - entity.x) * 0.3;
    entity.y += (entity.ty - entity.y) * 0.3;
  }
  if (mine) {
    camera.x += (mine.x - camera.x) * 0.08;
    camera.y += (mine.y - 4 - camera.y) * 0.08;
  }
  const halfW = innerWidth / 2 / scale;
  const halfH = innerHeight / 2 / scale;
  camera.x = Math.max(world.bounds.minX + halfW - 30, Math.min(world.bounds.maxX - halfW + 30, camera.x));
  camera.y = Math.max(world.bounds.minY + halfH - 20, Math.min(world.bounds.maxY - halfH + 10, camera.y));

  drawGround(time);
  const drawables = [];
  for (const prop of world.props) if (drawProp[prop.type]) drawables.push({ y: prop.y + (prop.type === "building" || prop.type === "cottage" ? -prop.h / 2 : 0), prop });
  for (const entity of entities.values()) drawables.push({ y: entity.y, entity });
  drawables.sort((a, b) => a.y - b.y);
  worldTransform();
  for (const item of drawables) {
    if (item.prop) drawProp[item.prop.type](item.prop, time);
    else drawCharacter(item.entity, time);
  }
  drawLight(time);
  screenTransform();
  // Signs over buildings.
  ctx.textAlign = "center";
  for (const prop of world.props) {
    if (!prop.label) continue;
    const at = toScreen(prop.x, prop.y - prop.h / 2 - (prop.type === "building" ? 10.2 : 8.2));
    ctx.font = `600 ${Math.round(scale * (prop.type === "building" ? 2.3 : 1.7))}px Fredoka, sans-serif`;
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(30,35,50,0.6)";
    ctx.strokeText(prop.label, at.x, at.y);
    ctx.fillStyle = "#fffdf4";
    ctx.fillText(prop.label, at.x, at.y);
  }
  ctx.textAlign = "left";
  bubbleBoxes = [];
  for (const entity of [...entities.values()].sort((a, b) => b.y - a.y)) drawLabels(entity, time);
  updateUseButton(mine);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------- UI
const LABELS = { wave: "Wave", hug: "Hug", high_five: "High five", compliment: "Compliment", coffee: "Coffee", dance: "Dance", fishing: "Fishing", bonfire: "Bonfire", picnic: "Picnic" };

function sendMessage(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function addLine(who, text, mine) {
  const line = document.createElement("div");
  const name = document.createElement("b");
  name.textContent = who;
  if (mine) name.className = "me";
  line.append(name, ` ${text}`);
  $("feed").append(line);
  while ($("feed").children.length > 8) $("feed").firstChild.remove();
}

function toast(text, kind) {
  const el = document.createElement("div");
  el.className = `toast ${kind ?? ""}`;
  el.textContent = text;
  $("toasts").append(el);
  setTimeout(() => el.remove(), 5000);
}

function renderPeople() {
  const rows = $("rows");
  rows.textContent = "";
  for (const [name, person] of people) {
    const row = document.createElement("div");
    row.className = "person";
    row.innerHTML = '<div class="top"><span class="name"></span><span class="level"></span></div><div class="track"><div class="fill"></div></div><div class="note"></div>';
    row.querySelector(".name").textContent = name;
    row.querySelector(".level").textContent = `${person.label} · ${person.affinity}`;
    const fill = row.querySelector(".fill");
    fill.style.width = `${Math.min(100, Math.abs(person.affinity))}%`;
    fill.style.background = person.affinity < 0 ? "var(--bad)" : "var(--good)";
    row.querySelector(".note").textContent = person.status ? `is ${person.status}` : person.note ? `“${person.note}”` : "";
    row.onclick = () => setFocus(name);
    rows.append(row);
  }
}

function renderItems() {
  $("bag").textContent = items.length ? `Carrying: ${items.join(", ")}` : "Carrying nothing. Try the flower garden, the cafe, or the pier.";
  const gives = $("gives");
  gives.textContent = "";
  if (items.length === 0) gives.textContent = "nothing to give yet";
  for (const item of items) {
    const button = document.createElement("button");
    button.className = "item";
    button.textContent = item;
    button.onclick = () => {
      sendMessage({ t: "give", to: focus, item });
      addLine(me, `(gives ${item})`, true);
    };
    gives.append(button);
  }
}

function setFocus(name) {
  focus = name;
  $("bar").classList.toggle("hidden", !name);
  document.body.classList.toggle("talking", Boolean(name));
  if (name) {
    $("bar-title").textContent = `Talking to ${name}`;
    $("say").focus();
  }
}

function fillButtons(container, keys, type, field) {
  container.textContent = "";
  for (const key of keys) {
    const button = document.createElement("button");
    button.textContent = LABELS[key] ?? key;
    button.onclick = () => {
      sendMessage({ t: type, to: focus, [field]: key });
      addLine(me, `(${(LABELS[key] ?? key).toLowerCase()})`, true);
    };
    container.append(button);
  }
}

let usable = null;
function updateUseButton(mine) {
  let best = null;
  if (mine) {
    for (const thing of world.things) {
      if (thing.verb && Math.hypot(thing.x - mine.x, thing.y - mine.y) < 9) best = thing;
    }
  }
  if (best?.id !== usable?.id) {
    usable = best;
    $("use").classList.toggle("hidden", !best || focus !== null);
    if (best) $("use").textContent = best.verb;
  } else {
    $("use").classList.toggle("hidden", !best || focus !== null);
  }
}
$("use").onclick = () => usable && sendMessage({ t: "use", thing: usable.id });

$("say-form").onsubmit = (event) => {
  event.preventDefault();
  const text = $("say").value.trim();
  if (!text) return;
  $("say").value = "";
  sendMessage({ t: "say", text, to: focus });
  addLine(me, text, true);
  bubbles.set(me, { text, from: performance.now(), until: performance.now() + 4500 });
};
$("bar-close").onclick = () => setFocus(null);
addEventListener("keydown", (event) => {
  if (event.key === "Escape") setFocus(null);
});

canvas.addEventListener("pointerdown", (event) => {
  if (!world || !me) return;
  const x = (event.clientX - innerWidth / 2) / scale + camera.x;
  const y = (event.clientY - innerHeight / 2) / scale + camera.y;
  const mine = entities.get(me);
  // Clicking a resident starts a conversation and walks up to them.
  let hit = null;
  let hitDistance = 4.5;
  for (const entity of entities.values()) {
    const gap = Math.hypot(entity.x - x, entity.y - 3 - y);
    if (entity.k && gap < hitDistance) {
      hit = entity;
      hitDistance = gap;
    }
  }
  if (hit) {
    const entity = hit;
    setFocus(entity.n);
    if (mine) {
      const gap = Math.hypot(mine.x - entity.x, mine.y - entity.y);
      if (gap > 9) sendMessage({ t: "move", x: entity.x + ((mine.x - entity.x) / gap) * 6, y: entity.y + ((mine.y - entity.y) / gap) * 6 });
    }
    return;
  }
  sendMessage({ t: "move", x, y });
});

// ---------------------------------------------------------------- network
function connect(name, code) {
  if (socket && socket.readyState <= 1) {
    sendMessage({ t: "join", name, code });
    return;
  }
  socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
  socket.onopen = () => sendMessage({ t: "join", name, code });
  socket.onclose = () => {
    if (me) toast("Connection lost. Reload to come back.", "bad");
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.t === "init") {
      world = message;
      me = message.you;
      $("join").classList.add("hidden");
      for (const id of ["people", "feed"]) $(id).classList.remove("hidden");
      fillButtons($("gestures"), message.gestures, "gesture", "gesture");
      fillButtons($("invites"), message.invites, "invite", "invite");
      renderItems();
      addLine("Tip", "Click to walk. Click a resident to talk to them.");
    } else if (message.t === "state") {
      hour = message.hour;
      const hours = Math.floor(hour);
      const part = hours < 6 ? "night" : hours < 12 ? "morning" : hours < 14 ? "midday" : hours < 18 ? "afternoon" : hours < 22 ? "evening" : "night";
      $("clock").textContent = `${String(hours).padStart(2, "0")}:${String(Math.floor((hour % 1) * 60)).padStart(2, "0")}, ${part}`;
      const seen = new Set();
      for (const row of message.entities) {
        seen.add(row.n);
        const entity = entities.get(row.n) ?? { x: row.x, y: row.y };
        Object.assign(entity, { n: row.n, k: row.k, tx: row.x, ty: row.y, f: row.f, m: row.m, s: row.s, t: row.t, l: row.l });
        entities.set(row.n, entity);
      }
      for (const name of entities.keys()) if (!seen.has(name)) entities.delete(name);
    } else if (message.t === "speech") {
      if (message.speaker === me) return;
      bubbles.set(message.speaker, { text: message.text, from: performance.now(), until: performance.now() + Math.min(9000, 3000 + message.text.length * 45) });
      const speaker = entities.get(message.speaker);
      const mine = entities.get(me);
      if (speaker && mine && Math.hypot(speaker.x - mine.x, speaker.y - mine.y) < 60) {
        addLine(message.to ? `${message.speaker} → ${message.to === me ? "you" : message.to}` : message.speaker, message.text, false);
      }
    } else if (message.t === "people") {
      for (const row of message.rows) people.set(row.name, row);
      renderPeople();
    } else if (message.t === "rel") {
      const person = people.get(message.name) ?? {};
      people.set(message.name, { ...person, affinity: message.affinity, label: message.label, note: message.because });
      renderPeople();
      const sign = message.change >= 0 ? "+" : "";
      toast(`${message.name} likes you ${message.change >= 0 ? "more" : "less"} (${sign}${message.change}): ${message.because}`, message.change >= 0 ? "good" : "bad");
    } else if (message.t === "items") {
      items = message.items;
      renderItems();
    } else if (message.t === "toast") {
      toast(message.text, message.good ? "good" : "");
    } else if (message.t === "emote") {
      emotes.set(message.name, { emote: message.emote, until: performance.now() + 2600 });
      setTimeout(() => {
        if ((emotes.get(message.name)?.until ?? 0) <= performance.now()) emotes.delete(message.name);
      }, 2700);
    } else if (message.t === "denied") {
      toast("That passcode is not right.", "bad");
      $("join-code").value = "";
      $("join-code").focus();
    } else if (message.t === "full") {
      toast("The town is full right now. Try again in a bit.", "bad");
    }
  };
}

$("join-form").onsubmit = (event) => {
  event.preventDefault();
  connect($("join-name").value.trim() || "Visitor", $("join-code").value.trim());
};

// The town may ask visitors for a passcode. A link ending in #code fills it in;
// the part after # is never sent to the server in the page request.
fetch("/health")
  .then((response) => response.json())
  .then((health) => {
    if (!health.passcode) return;
    $("join-code").classList.remove("hidden");
    $("join-code").required = true;
    const fromLink = decodeURIComponent(location.hash.slice(1));
    if (fromLink) $("join-code").value = fromLink;
  })
  .catch(() => {});
