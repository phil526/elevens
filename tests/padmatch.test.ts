// Controller in matches on PC (19 Nov 2026): menus worked but matches ignored the pad. Clearing the input
// (kick-off, cut scenes, focus loss) used to silence the WHOLE pad until every button and both sticks read
// neutral, which a drifting stick, a button reported as held, or a trigger axis resting at -1 (pads without
// the standard mapping) never do. Now only what was held is ignored, and only until it is let go.
import { describe, expect, it } from 'vitest';
import { GamepadSource } from '../src/client/input/gamepad';

const makePad = (id = 'Xbox 360 Controller (XInput STANDARD GAMEPAD)', axes = [0, 0, 0, 0], mapping = 'standard') => ({
  connected: true,
  id,
  mapping,
  axes: axes.slice(),
  buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
});
const press = (p: ReturnType<typeof makePad>, i: number, on = true) => { p.buttons[i].pressed = on; p.buttons[i].value = on ? 1 : 0; };

describe('controller keeps working after input is cleared (matches on PC)', () => {
  it('a right stick resting just past its dead zone does not silence the pad', () => {
    const pad = makePad(undefined, [0, 0, 0.27, 0]);
    const g = new GamepadSource(() => [pad]);
    g.read();
    g.clear(); // kick-off / cut scene / focus loss
    g.read(); // the next frame
    pad.axes[0] = 1;
    expect(g.read().sx).toBeGreaterThan(0.9);
    press(pad, 0);
    expect(g.read().pass).toBe(true);
  });
  it('a left stick resting just past its dead zone does not silence the pad either', () => {
    const pad = makePad(undefined, [0.2, 0.05, 0, 0]);
    const g = new GamepadSource(() => [pad]);
    g.clear();
    g.read();
    press(pad, 2); // X shoots
    expect(g.read().shoot).toBe(true);
  });
  it('a trigger axis resting at -1 (no standard mapping) is not read as a stick and does not block play', () => {
    const pad = makePad('Generic USB Joystick (Vendor: 0079 Product: 0006)', [0, 0, -1, 0, 0, -1], '');
    const g = new GamepadSource(() => [pad]);
    g.clear();
    const r0 = g.read();
    expect(r0.rsx).toBe(0);
    pad.axes[0] = -1;
    press(pad, 0);
    const r = g.read();
    expect(r.sx).toBeLessThan(-0.9);
    expect(r.pass).toBe(true);
  });
  it('a button reported as held all the time only loses that button', () => {
    const pad = makePad();
    press(pad, 6); // e.g. a trigger that rests half pulled
    const g = new GamepadSource(() => [pad]);
    g.read();
    g.clear();
    g.read();
    pad.axes[1] = -1;
    press(pad, 0);
    const r = g.read();
    expect(r.sy).toBeGreaterThan(0.9);
    expect(r.pass).toBe(true);
  });
  it('the A press that started the match does not pass until it is let go and pressed again', () => {
    const pad = makePad();
    const g = new GamepadSource(() => [pad]);
    press(pad, 0); // Kick off in the menu
    g.read();
    g.clear(); // the match starts while A is still down
    expect(g.read().pass).toBe(false);
    pad.axes[0] = 1; // the stick still works meanwhile
    expect(g.read().sx).toBeGreaterThan(0.9);
    press(pad, 0, false);
    expect(g.read().pass).toBe(false);
    press(pad, 0);
    expect(g.read().pass).toBe(true);
  });
  it('a stick held hard when input is cleared waits until it comes back to the middle', () => {
    const pad = makePad(undefined, [1, 0, 0, 0]);
    const g = new GamepadSource(() => [pad]);
    g.read();
    g.clear();
    expect(g.read().sx).toBe(0);
    pad.axes[0] = 0;
    g.read();
    pad.axes[0] = 1;
    expect(g.read().sx).toBeGreaterThan(0.9);
  });
  it('follows the controller being used when the first one listed is a silent extra device', () => {
    const phantom = makePad('Virtual HID device', [0, 0, 0, 0], '');
    const pad = makePad();
    const g = new GamepadSource(() => [phantom, pad]);
    g.read(); // takes the first one listed
    expect(g.index).toBe(0);
    press(pad, 0);
    pad.axes[0] = 1;
    const r = g.read();
    expect(g.index).toBe(1);
    expect(r.pass).toBe(true);
    expect(r.sx).toBeGreaterThan(0.9);
    expect(g.style).toBe('xbox');
  });
});
