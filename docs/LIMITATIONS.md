# Limitations and what is still unchecked

Rewritten on 21 November 2026; the change history is in NOTES.md and the project tracker. Earlier
versions of this file listed many features as missing (substitutions, extra time, keeper control,
movable walls, replays, commentary, music, more clubs, weather); all of those are now in the game.

## Not checked by a person or on real hardware

- Frame rate has only been measured in software rendering here (no GPU). Philip plays on a Windows
  PC, an iPad and a Samsung Android phone, and reports from those are the only real-hardware checks.
- Phone and tablet layouts are checked in emulated Chromium (`node scripts/e2e-screens.mjs`
  audits about 32 screens on phone, phone landscape, iPad and PC). Phones need landscape for matches.
- Controller rumble on iPad Safari is unverified.
- Only Chromium is tested automatically. Safari (iPad) and Chrome (Windows, Android) are used by
  Philip; Firefox is untested.
- How hard each difficulty feels to a human is judged only by Philip's play and a scripted bot
  (`scripts/bench-human.ts`).
- The sound mix (ducking, loudness levelling) was set from measured levels, not by ear on speakers.

## Gameplay

- The simulation is rule-based: headers, volleys, chest control and collisions are steered by
  rules rather than full body physics.
- Offside is judged from positions at the pass on the ground plane, with no "active play" nuance
  beyond touching the ball.
- Online matches keep draws (no extra time or penalties online), and online has no unilateral pause.

## Presentation

- Realistic players come from three Higgsfield bodies with captured clips for walk, jog, sprint,
  kick, slide, keeper leap/catch, header jump, cheers, limp and backwards walk. Everything else
  (tackles, skills, most keeper saves, throw-ins, celebrations) is procedural posing on the
  skeleton. Low quality on some devices may still fall back to Classic players.
- One-time tips and settings descriptions are English only.
- The client bundle includes three.js whole; it is not code-split.

## Online

- One server process (Render free tier) holds all rooms in memory; a restart or the free tier
  sleeping ends matches and friends leagues are rebuilt from what members bring back.
- Tested on one machine with simulated latency; real mobile networks are untested.
- Reconnect relies on a token in the tab's session storage, so closing the tab gives up the seat.

## Hosting

- The game is a static site (GitHub Pages and the shared Claude link). Installing it to a home
  screen as an app is not possible from the Claude link; it needs its own hosting.
