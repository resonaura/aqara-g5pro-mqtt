import test from 'node:test';
import assert from 'node:assert/strict';
import { slugifyStreamName, assignUniqueSlugs } from '../slug.js';

test('slugify: lowercase, spaces -> dashes, trailing -camera stripped', () => {
  assert.equal(slugifyStreamName('Living Room Camera'), 'living-room');
  assert.equal(slugifyStreamName('Front Door Cam'), 'front-door-cam');
  assert.equal(slugifyStreamName('G5 Pro'), 'g5-pro');
  assert.equal(slugifyStreamName('Bedroom 2'), 'bedroom-2');
  assert.equal(slugifyStreamName('  Spare  Space  '), 'spare-space');
});

test('assignUniqueSlugs de-duplicates collisions', () => {
  const map = assignUniqueSlugs([
    { did: 'a', name: 'Living Room' },
    { did: 'b', name: 'Living Room' },
    { did: 'c', name: 'Living Room Camera' },
  ]);
  assert.equal(map['a'], 'living-room');
  assert.equal(map['b'], 'living-room-2');
  // "Living Room Camera" -> "living-room", but that's taken -> living-room-3
  assert.equal(map['c'], 'living-room-3');
  const vals = Object.values(map);
  assert.equal(new Set(vals).size, vals.length);
});
