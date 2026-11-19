// Procedurally generated textures (no external image assets).

import * as THREE from 'three';

export function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat?: [number, number]): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  draw(g);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  t.anisotropy = 8;
  return t;
}

/** Grass base colour with fine noise; higher presets add blade streaks. Stripes come from the grass shader. */
export function grassTexture(stripes: number, quality: number): THREE.CanvasTexture {
  const w = quality >= 3 ? 4096 : quality > 1 ? 2048 : 1024, h = w / 2;
  return canvasTex(w, h, (g) => {
    // Mowing stripes are drawn by the grass shader (they change with the viewing angle).
    const sw = w / stripes;
    g.fillStyle = '#438e3c';
    g.fillRect(0, 0, w, h);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    if (quality > 1) {
      // Short blade strokes, lighter or darker than the stripe, leaning with the mowing direction.
      const blades = (w * h) / (quality >= 3 ? 120 : 80);
      const len = w / 1024;
      g.lineWidth = Math.max(1, len * 0.7);
      for (let i = 0; i < blades; i++) {
        const x = rnd() * w, y = rnd() * h;
        const dir = Math.floor(x / sw) % 2 ? 1 : -1;
        const l = len * (1.5 + rnd() * 2);
        g.strokeStyle = rnd() < 0.5 ? 'rgba(110,170,80,0.09)' : 'rgba(20,60,20,0.11)';
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + dir * l * 0.35, y - l);
        g.stroke();
      }
      // Soft wear patches so large areas are not perfectly uniform.
      for (let i = 0; i < 40; i++) {
        const x = rnd() * w, y = rnd() * h, r = (0.03 + rnd() * 0.08) * w;
        const grd = g.createRadialGradient(x, y, 0, x, y, r);
        grd.addColorStop(0, rnd() < 0.5 ? 'rgba(90,110,40,0.10)' : 'rgba(10,50,15,0.10)');
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grd;
        g.fillRect(x - r, y - r, 2 * r, 2 * r);
      }
    }
    const img = g.getImageData(0, 0, w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (rnd() - 0.5) * 18;
      img.data[i] += n * 0.6;
      img.data[i + 1] += n;
      img.data[i + 2] += n * 0.4;
    }
    g.putImageData(img, 0, 0);
  });
}

/** Seats with a sparse, abstract crowd (dots), tiled along a stand. */
export function crowdTexture(seat: string, fill: number, res = 1): THREE.CanvasTexture {
  return canvasTex(512 * res, 256 * res, (g) => {
    g.scale(res, res);
    g.fillStyle = seat;
    g.fillRect(0, 0, 512, 256);
    // Seat rows.
    g.fillStyle = 'rgba(0,0,0,0.25)';
    for (let y = 0; y < 256; y += 16) g.fillRect(0, y + 12, 512, 4);
    const palette = ['#e8e2d4', '#2b2b2b', '#c8102e', '#14306b', '#f5f6f8', '#6b4a2b', '#f2b705', '#3b6ea5', '#888888', '#d24d57'];
    let seed = 11;
    const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    for (let y = 2; y < 256; y += 16) {
      for (let x = 2; x < 512; x += 9) {
        if (rnd() > fill) continue;
        g.fillStyle = palette[Math.floor(rnd() * palette.length)];
        g.beginPath();
        g.arc(x + rnd() * 2, y + 4, 3.2, 0, Math.PI * 2);
        g.fill();
        g.fillRect(x - 3 + rnd() * 2, y + 6, 6, 6);
      }
    }
  }, [6, 1]);
}

/** Advertising boards for fictional brands. */
export function boardTexture(): THREE.CanvasTexture {
  const brands: [string, string, string][] = [
    ['NORTHWIND', '#0b2545', '#8ecae6'],
    ['Brightwell Energy', '#14213d', '#fca311'],
    ['KETTLE & CO.', '#2d6a4f', '#f1faee'],
    ['VOLTA MOBILE', '#3a0ca3', '#4cc9f0'],
    ['Harlow Bank', '#1d3557', '#f1faee'],
    ['FENWAY TYRES', '#111111', '#ffd60a'],
    ['ELEVENS', '#0d1117', '#3ee08f'],
    ['Saltmarsh Cider', '#7f1d1d', '#fde68a'],
  ];
  return canvasTex(2048, 64, (g) => {
    const w = 2048 / brands.length;
    brands.forEach(([name, bg, fg], i) => {
      g.fillStyle = bg;
      g.fillRect(i * w, 0, w, 64);
      g.fillStyle = fg;
      g.font = '800 34px system-ui, Segoe UI, Arial, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(name, i * w + w / 2, 34, w - 16);
    });
  }, [3, 1]);
}

export function numberTexture(n: number, colour: string): THREE.CanvasTexture {
  return canvasTex(128, 128, (g) => {
    g.clearRect(0, 0, 128, 128);
    g.fillStyle = colour;
    g.font = '900 92px system-ui, Segoe UI, Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(n), 64, 70);
  });
}

/** Original ball pattern: white with angular dark panels and a teal stripe. */
export function ballTexture(): THREE.CanvasTexture {
  return canvasTex(512, 256, (g) => {
    g.fillStyle = '#f7f7f2';
    g.fillRect(0, 0, 512, 256);
    g.fillStyle = '#1b1f2a';
    const tri = (x: number, y: number, s: number, r: number) => {
      g.beginPath();
      for (let i = 0; i < 3; i++) {
        const a = r + (i * Math.PI * 2) / 3;
        g.lineTo(x + Math.cos(a) * s, y + Math.sin(a) * s);
      }
      g.closePath();
      g.fill();
    };
    for (let i = 0; i < 8; i++) tri(32 + i * 64, 70 + (i % 2) * 110, 26, i * 0.7);
    g.fillStyle = '#20c997';
    g.fillRect(0, 122, 512, 12);
  });
}

export function netTexture(): THREE.CanvasTexture {
  return canvasTex(128, 128, (g) => {
    g.clearRect(0, 0, 128, 128);
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.lineWidth = 3;
    for (let i = 0; i <= 128; i += 16) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 128); g.stroke();
      g.beginPath(); g.moveTo(0, i); g.lineTo(128, i); g.stroke();
    }
  });
}
