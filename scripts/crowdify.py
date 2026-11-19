# Turns a small-group crowd reaction into a stadium-sized one (used for public/sfx ooh, ooh-2, gasp, boo, goal):
# timing offsets spread across the stereo field, a swell of real stadium noise shaped by the
# reaction, and a stadium reverb. Usage: crowdify.py out.wav seed voices sources... (path[@start:dur])
import sys, subprocess, numpy as np
SR = 44100
def load(spec, ch=1):
    path, _, rng = spec.partition('@')
    args = ['ffmpeg', '-v', 'error']
    if rng:
        st, du = rng.split(':'); args += ['-ss', st, '-t', du]
    args += ['-i', path, '-ac', str(ch), '-ar', str(SR), '-f', 'f32le', '-']
    a = np.frombuffer(subprocess.run(args, capture_output=True, check=True).stdout, dtype=np.float32)
    return a.reshape(-1, ch) if ch > 1 else a
def resample(x, rate):
    n = int(len(x) / rate)
    return np.interp(np.arange(n) * rate, np.arange(len(x)), x).astype(np.float32)
def lowpass(x, fc):
    a = np.exp(-2 * np.pi * fc / SR); y = np.empty_like(x); s = 0.0
    for i in range(len(x)): s = (1 - a) * x[i] + a * s; y[i] = s
    return y
def lowpass_fast(x, fc):  # 4 passes of a vectorised moving average approximate a gentle low-pass
    k = max(1, int(SR / fc / 2)); y = x
    for _ in range(2): y = np.convolve(y, np.ones(k) / k, mode='same')
    return y.astype(np.float32)
def env(x, win=0.12):
    k = int(SR * win); return np.sqrt(np.convolve(x * x, np.ones(k) / k, mode='same'))
def fftconv(a, b):
    n = len(a) + len(b) - 1; N = 1 << (n - 1).bit_length()
    return np.fft.irfft(np.fft.rfft(a, N) * np.fft.rfft(b, N), N)[:n]

out, seed, voices, bedspec, *srcs = sys.argv[1:]
rng = np.random.default_rng(int(seed)); voices = int(voices)
src = [load(s) for s in srcs]
L = int(max(len(s) for s in src) * 1.25 + SR * 0.4)
mix = np.zeros((L, 2), np.float32)
for v in range(voices):
    s = src[v % len(src)]
    x = resample(s, rng.uniform(0.86, 1.14))
    far = rng.random() < 0.5
    if far: x = lowpass_fast(x, rng.uniform(1800, 3200))
    d = int(SR * (rng.uniform(0, 0.12) if v < voices // 2 else rng.uniform(0.05, 0.32)))
    g = rng.uniform(0.55, 1.0) * (0.6 if far else 1.0)
    pan = rng.uniform(-0.95, 0.95)
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    n = min(len(x), L - d)
    mix[d:d + n, 0] += x[:n] * g * l; mix[d:d + n, 1] += x[:n] * g * r
mix /= np.sqrt(voices)
# Swell of real stadium noise, shaped by the reaction's loudness.
if bedspec != '-':
    bed = load(bedspec, 2)
    if len(bed) < L: bed = np.tile(bed, (L // len(bed) + 1, 1))
    bed = bed[:L]
    e = env(mix.mean(axis=1)); e /= e.max() + 1e-9
    bed = bed / (np.sqrt((bed ** 2).mean()) + 1e-9)
    mix += bed * e[:, None] * (np.sqrt((mix ** 2).mean()) * 0.9)
# Stadium reverb: decorrelated decaying noise, 2.3 s RT60, darkening tail, 35 ms pre-delay.
T = int(SR * 2.6); t = np.arange(T) / SR
ir = np.zeros((T + int(SR * 0.035), 2), np.float32)
for c in range(2):
    n = rng.standard_normal(T).astype(np.float32) * np.exp(-6.9 * t / 2.3)
    n = lowpass_fast(n, 3500)
    ir[int(SR * 0.035):, c] = n
ir /= np.sqrt((ir ** 2).sum(axis=0))
wet = np.stack([fftconv(mix[:, c], ir[:, c]) for c in range(2)], axis=1)[:L + T]
dry = np.zeros_like(wet); dry[:L] = mix
y = 0.72 * dry + 0.5 * wet * (np.sqrt((mix ** 2).mean()) / (np.sqrt((wet[:L] ** 2).mean()) + 1e-9))
# Trim the silent tail and fade out.
e = env(y.mean(axis=1), 0.05); last = np.nonzero(e > e.max() * 0.02)[0][-1]
y = y[:min(len(y), last + int(SR * 0.3))]
f = int(SR * 0.25); y[-f:] *= np.linspace(1, 0, f)[:, None]
y /= np.abs(y).max() + 1e-9
y.astype(np.float32).tofile(out + '.f32')
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', '2', '-i', out + '.f32', out], check=True)
