// What the town murals depict. Quinlans paint their history and their songs on
// warehouse and civic walls; these are invented scenes, not book events.

import { hash2 } from '../core/rng';

const SCENES: [string, string][] = [
  ['The Two Melodies', 'Two singers face each other across a river; their songs are painted as ribbons, one blue and one gold, braided but never touching.'],
  ['The Endless River', 'A river loops over the top of the wall and back under the bottom. Tiny barges follow it forever. Someone has added a grumpy fish at the seam.'],
  ['The Great Flood', 'Brown water to the rooftops, and a chain of Quinlans swimming tail to paw, towing a whole family burrow to higher ground.'],
  ['First Dive', 'A pier full of children, one mid-air, eyes wide on both sides of her head. The painter gave the water a hundred silver fish.'],
  ['The Watching Bird', 'A black bird on a rooftop, drawn very small in the corner. Look again and it is in every panel of the mural.'],
  ['The Light Spear', 'The sky-light painted as a golden spear laid along the heavens, with the river running beneath it like its shadow.'],
  ['Tavern Brawl, Resolved', 'Three panels: a shouting match, an upturned table, and then everyone singing with their arms around each other.'],
  ['Barge Crew at Dusk', 'Poles dipping in time, a lantern at the bow, and the crew’s work song written above them in flowing glyphs.'],
  ['The Mill Wheel', 'A great wheel turning in a side channel, each paddle carrying a different family’s mark.'],
  ['Journey Downriver', 'A raft of ancestors drifting past strange towns, each town painted a little smaller and a little stranger than the last.'],
  ['The Harvest Swim', 'Quinlans carrying baskets of reeds on their heads while swimming, tails churning, all of them laughing.'],
  ['The Mountains at the End', 'A wall of white peaks where the river vanishes into a dark arch. Nobody in the painting looks worried about it.'],
  ['Market Morning', 'Stalls of fish, fruit and dyed cloth; a stall keeper mid-shout, a customer mid-haggle, a thief mid-sprint.'],
  ['The Kindly Otter', 'A fat river otter sleeping on a sunny rock while Quinlan children tiptoe past with a bucket of fish.'],
  ['Night Chorus', 'A dark blue wall scattered with tiny painted windows, each one with a singer in it, all facing the same way.'],
  ['The Crew’s Pay', 'Grim-faced workers in plain sashes marching into a hillside door. Someone has painted flowers over the door.'],
];

export function describeMural(seed: number, town: string): { title: string; text: string } {
  const i = hash2(Math.floor(seed), 17, 311) % SCENES.length;
  const [title, text] = SCENES[i];
  return { title: `${title}`, text: `${text} (Painted on a wall in ${town}.)` };
}
