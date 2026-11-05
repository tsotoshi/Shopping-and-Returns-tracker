import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchItem, normalizeName } from '../src/lib/matching.js';

const items = [
  { id: 1, name: 'Anker 735 Charger (Nano II 65W), 3-Port Fast Compact Foldable USB C Charger', retailer_item_id: 'B09C5RG6KV' },
  { id: 2, name: 'Merino Wool Socks 3-Pack', retailer_item_id: null },
  { id: 3, name: 'Trail Running Shoes, Size 10', retailer_item_id: null },
];

test('normalizes punctuation and case', () => {
  assert.equal(normalizeName('  Trail-Running Shoes, Size 10…'), 'trail running shoes size 10');
});

test('matches by retailer item id first', () => {
  assert.equal(matchItem(items, { name: 'something else', retailerItemId: 'B09C5RG6KV' }).match.id, 1);
});

test('matches exact, truncated, and reworded names', () => {
  assert.equal(matchItem(items, { name: 'merino wool socks 3-pack' }).match.id, 2);
  assert.equal(matchItem(items, { name: 'Anker 735 Charger (Nano II 65W), 3-Port Fast…' }).match.id, 1);
  assert.equal(matchItem(items, { name: 'Running Shoes Trail Size 10' }).match.id, 3);
});

test('no match for unrelated items', () => {
  assert.equal(matchItem(items, { name: 'Coffee Grinder' }).match, null);
});

test('reports ambiguity instead of guessing', () => {
  const twins = [{ id: 1, name: 'Blue Cotton T-Shirt Medium' }, { id: 2, name: 'Blue Cotton T-Shirt Large' }];
  assert.ok(matchItem(twins, { name: 'Blue Cotton T-Shirt' }).ambiguous);
});

test('split rows with the same name are one product group, not ambiguous', () => {
  const split = [{ id: 1, name: 'Phone Case' }, { id: 2, name: 'Phone Case' }];
  const m = matchItem(split, { name: 'Phone Case' });
  assert.equal(m.group.length, 2);
});
