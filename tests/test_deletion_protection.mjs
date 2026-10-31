import assert from 'node:assert/strict';
import {ChangeSet} from '@codemirror/state';
import {ExecutionHistory} from '../web/execution-history.mjs';

const text = 'a = 1\n\nb = 2\n\ndraft = 3';
const history = new ExecutionHistory();
history.begin({id: 'a', from: 0, to: 5, source: 'a = 1'}); history.commit(text);
history.begin({id: 'b', from: 5, to: 12, source: '\n\nb = 2'}); history.commit(text);
const guard = edits => history.deletionGuard(ChangeSet.of(edits, text.length), text);
const ids = edits => guard(edits).blocks.map(block => block.id);

assert.deepEqual(ids({from: 4, to: 5, insert: '9'}), [], 'editing a character stays free');
assert.deepEqual(ids({from: 0, insert: '# '}), [], 'insertion stays free');
assert.deepEqual(ids({from: 14, to: text.length}), [], 'unexecuted code stays free');
assert.deepEqual(ids({from: 0, to: 5}), ['a'], 'whole block deletion needs confirmation');
assert.deepEqual(ids({from: 7, to: 12, insert: 'b = 9'}), ['b'], 'replacement is protected even without leading newlines');
assert.deepEqual(ids({from: 0, to: text.length}), ['a', 'b'], 'all affected blocks are counted once');
assert.deepEqual(ids([{from: 0, to: 1}, {from: 2, to: 3}, {from: 4, to: 5}]), ['a'], 'multi-range removal cannot bypass protection by leaving whitespace');
assert.equal(guard({from: 5, to: 6}).boundary, true, 'first separator newline is protected');
assert.equal(guard({from: 6, to: 7}).boundary, false, 'extra blank lines may be removed');
assert.equal(guard({from: 12, to: 13}).boundary, true, 'last executed block protects the draft boundary');
assert.equal(guard({from: 4, to: 5}).boundary, false, 'normal character deletion inside a block stays free');

const restored = new ExecutionHistory();
restored.restore(history.snapshot(), text);
assert.equal(restored.deletionGuard(ChangeSet.of({from: 0, to: 5}, text.length), text).blocks.length, 1, 'restored blocks stay protected');
history.begin({...history.blocks[0]});
assert.deepEqual(ids({from: 0, to: 5}), ['a'], 'a running replay is counted only once');
history.begin({id: 'pending', from: 14, to: text.length, source: 'draft = 3'});
assert.deepEqual(ids({from: 14, to: text.length}), ['pending'], 'currently executing code is protected too');
history.begin({id: 'all', from: 0, to: text.length, source: text, all: true});
assert.deepEqual(ids({from: 0, to: text.length}), ['all'], 'run-all pending range replaces overlapping previous block counts');
const beforeAll = history.epoch;
history.commit(text);
assert(history.epoch > beforeAll, 'run all invalidates snapshots of superseded execution boundaries');
const beforeFailedAll = history.epoch;
history.begin({id: 'failed-all', from: 0, to: text.length, source: text, all: true}); history.fail();
assert(history.epoch > beforeFailedAll, 'failed run all also invalidates old boundary snapshots');

const trailing = new ExecutionHistory();
const spaced = 'x = 1  \nnew';
trailing.begin({id: 'x', from: 0, to: 5, source: 'x = 1'}); trailing.commit(spaced);
assert.equal(trailing.deletionGuard(ChangeSet.of({from: 7, to: 8}, spaced.length), spaced).boundary, true, 'trailing spaces do not hide the separator');
history.reset();
assert.deepEqual(ids({from: 0, to: text.length}), [], 'session reset removes protection');
console.log('PASS: deletion protection for partial edits, full replacement, multiple blocks/ranges, boundaries, pending runs, refresh and reset');
