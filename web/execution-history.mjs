// Execution boundaries follow successful runs, never the cursor.
export class ExecutionHistory {
  constructor() { this.reset(); }
  reset() { this.blocks = []; this.pending = null; this.failed = null; this.epoch = (this.epoch || 0) + 1; }
  deletionGuard(changes, text) {
    const removed = [];
    changes.iterChanges((from, to) => { if (to > from) removed.push({from, to}); });
    const blocks = [], executed = new Map((this.pending?.all ? [] : this.blocks).map(block => [block.id, block]));
    if (this.pending) executed.set(this.pending.id, this.pending);
    let boundary = false;
    for (const block of executed.values()) {
      if (!text.slice(block.from, block.to).trim()) continue;
      let position = block.from, remaining = '', touched = false;
      for (const {from, to} of removed) {
        if (from >= block.to || to <= block.from) continue;
        remaining += text.slice(position, Math.max(position, from));
        position = Math.min(block.to, to);
        touched = true;
      }
      remaining += text.slice(position, block.to);
      if (touched && !remaining.trim()) blocks.push(block);
      const newline = text.indexOf('\n', block.to);
      if (newline >= 0 && !text.slice(block.to, newline).trim() && removed.some(({from, to}) => from <= newline && to > newline)) boundary = true;
    }
    return {blocks, boundary};
  }
  plan(text) {
    const firstDirty = this.blocks.findIndex(block => block.dirty || text.slice(block.from, block.to) !== block.source);
    if (firstDirty >= 0) for (const block of this.blocks.slice(firstDirty)) block.dirty = true;
    const tasks = firstDirty < 0 ? [] : this.blocks.slice(firstDirty).map(block => ({...block, source: text.slice(block.from, block.to), existing: true}));
    const from = this.blocks.at(-1)?.to || 0;
    const to = text.replace(/[ \t\r\n]+$/, '').length;
    if (to > from && text.slice(from, to).trim()) tasks.push({id: crypto.randomUUID(), from, to, source: text.slice(from, to), existing: false});
    return tasks;
  }
  begin(task) {
    this.pending = {...task};
    if (task.all || this.failed && task.from <= this.failed.from && task.to >= this.failed.to) this.failed = null;
  }
  commit(text) {
    const block = this.pending;
    this.pending = null;
    if (!block) return;
    if (block.all) { this.blocks = []; this.epoch += 1; }
    const index = this.blocks.findIndex(item => item.id === block.id);
    if (!block.source.trim()) {
      if (index >= 0) this.blocks.splice(index, 1);
      return;
    }
    const next = {...block, dirty: text.slice(block.from, block.to) !== block.source};
    if (index >= 0) this.blocks[index] = next;
    else this.blocks.push(next);
  }
  fail() {
    if (this.pending) this.failed = {...this.pending};
    if (this.pending?.all) { this.blocks = []; this.epoch += 1; }
    const block = this.blocks.find(item => item.id === this.pending?.id);
    if (block) block.dirty = true;
    this.pending = null;
  }
  change(changes, text) {
    const map = block => {
      let endSide = -1;
      changes.iterChanges((from, to, _a, _b, inserted) => {
        if (from === to && from === block.to && !inserted.toString().startsWith('\n')) endSide = 1;
      });
      const from = changes.mapPos(block.from, -1);
      const to = Math.max(from, changes.mapPos(block.to, endSide));
      return {...block, from, to, dirty: block.dirty || text.slice(from, to) !== block.source};
    };
    const mapped = this.blocks.map(map);
    this.blocks = [];
    for (const block of mapped) {
      const previous = this.blocks.at(-1);
      const removedSeparator = previous && block.from === previous.to && block.from > 0 && text[block.from - 1] !== '\n' && text[block.from] !== '\n';
      if (previous && (block.from < previous.to || removedSeparator)) {
        previous.to = Math.max(previous.to, block.to);
        previous.dirty = true;
      } else this.blocks.push(block);
    }
    if (this.pending) this.pending = map(this.pending);
    if (this.failed) this.failed = map(this.failed);
  }
  snapshot() { return {blocks: this.blocks.map(block => ({...block})), pending: this.pending ? {...this.pending} : null, failed: this.failed ? {...this.failed} : null}; }
  restore(snapshot, text) {
    const valid = item => item && typeof item.id === 'string' && typeof item.source === 'string' && Number.isInteger(item.from) && Number.isInteger(item.to) && item.from >= 0 && item.to >= item.from && item.to <= text.length;
    this.blocks = Array.isArray(snapshot?.blocks) ? snapshot.blocks.filter(valid).map(block => ({...block, dirty: block.dirty || text.slice(block.from, block.to) !== block.source})) : [];
    this.pending = valid(snapshot?.pending) ? snapshot.pending : null;
    this.failed = valid(snapshot?.failed) ? {...snapshot.failed} : null;
  }
}
