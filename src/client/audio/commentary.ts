// Recorded commentator (20 Nov 2026): about 60 short lines made with Higgsfield text-to-speech
// (Philip chose the voice), kept in public/sfx/cm/<kind>-<n>.mp3. The text here is also the script
// scripts/split-commentary.mjs cuts the recordings by. Lines load in the background once a match
// starts with commentary on; until they arrive (or if they fail) the three older Pixabay calls play.

export const COMMENTARY = {
  kickoff: ["And we're under way.", 'Here we go. The referee gets us started.', "Kick-off, and the crowd are right behind them."],
  goal: ["And it's in! What a finish!", 'Goal! The keeper had no chance!', "He's scored! Right into the corner!", "It's in the back of the net!", "What a strike! That's a goal of real quality!", 'Goal! Cool as you like.', "Oh, that's a beauty! Top corner!", "He's done it! Listen to this crowd!"],
  equaliser: ["And they're level! Game on!", "The equaliser! We're all square!"],
  header: ["A brilliant header, and it's in!", "Up he goes, and he's headed it home!"],
  pengoal: ['He sends the keeper the wrong way!', 'Penalty scored. No mistake.'],
  save: ['What a save!', 'Brilliant stop from the keeper!', "Fingertips! He's kept that out!", "The keeper's equal to it!", 'Saved! Great reactions!'],
  pensave: ["Saved! The keeper's guessed right!", "He's saved the penalty!"],
  woodwork: ['Off the post!', 'Off the bar! So close!', "It's hit the woodwork!", 'The frame of the goal comes to the rescue!'],
  miss: ['Just wide!', 'Over the bar.', 'He should have done better there.', 'Inches away!'],
  tackle: ['Great tackle!', "Superb challenge. He's won it clean.", 'Well defended.'],
  foul: ["That's a foul.", 'The referee blows. Free kick.'],
  yellow: ["That's a yellow card.", "He's in the book.", 'The referee reaches for his pocket. Yellow.'],
  red: ["Red card! He's off!", "Straight red! They're down to ten!"],
  penalty: ['Penalty! The referee points to the spot!', "It's a penalty!"],
  corner: ['Corner kick.', "They'll have a corner here."],
  freekick: ['Free kick, in a dangerous position.', 'This is well within range.'],
  offside: ["The flag's up. Offside.", 'Offside. He went too early.'],
  halftime: ["That's half-time.", 'The referee blows for the break.'],
  fulltime: ["And that's full time!", "It's all over!", 'The final whistle goes!'],
  late: ['Into the final minutes now.'],
} as const;

export type CommentKind = keyof typeof COMMENTARY;

/** File (under the sfx folder) for line i of a kind. */
export const commentFile = (k: CommentKind, i: number) => `cm/${k}-${i + 1}.mp3`;

export const COMMENT_KINDS = Object.keys(COMMENTARY) as CommentKind[];

/** Big moments may cut in sooner after another line; the rest wait their turn. */
export const COMMENT_PRIORITY: Record<CommentKind, number> = {
  goal: 3, equaliser: 3, header: 3, pengoal: 3, red: 3, pensave: 3, penalty: 3, fulltime: 3,
  save: 2, woodwork: 2, halftime: 2, kickoff: 2, yellow: 2,
  miss: 1, tackle: 1, foul: 1, corner: 1, freekick: 1, offside: 1, late: 1,
};
