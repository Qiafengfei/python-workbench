// Presentation follows execution ranges; it never changes what will run.
export function layoutBlocks(text, execution, results = []) {
  const ranges = (execution.pending?.all ? [] : execution.blocks).map(block => ({...block, status: block.dirty ? 'modified' : 'executed'}));
  if (execution.failed && !execution.pending?.all) {
    const failed = {...execution.failed, status: text.slice(execution.failed.from, execution.failed.to) === execution.failed.source ? 'failed' : 'modified'};
    const index = ranges.findIndex(block => block.id === failed.id);
    if (index >= 0) ranges[index] = failed;
    else if (!ranges.some(block => failed.from < block.to && failed.to > block.from)) ranges.push(failed);
  }
  if (execution.pending) {
    const pending = {...execution.pending, status: 'running'};
    const index = ranges.findIndex(block => block.id === pending.id);
    if (index < 0) ranges.push(pending);
    else ranges[index] = pending;
  }
  for (const result of results) {
    if (result.selection || ranges.some(block => block.id === result.id || result.from < block.to && result.to > block.from)) continue;
    ranges.push({...result, status: (result.failed ?? result.error) ? 'failed' : result.status === 'idle' ? 'executed' : 'running'});
  }
  const blocks = ranges.flatMap(block => {
    const source = text.slice(block.from, block.to);
    if (!source.trim()) return [];
    const from = block.from + source.match(/^(?:[ \t]*\n)*/)[0].length;
    return [{id: block.id, from, to: Math.min(block.to, text.length), status: block.status}];
  }).sort((left, right) => left.from - right.from || left.to - right.to);
  const end = blocks.reduce((end, block) => Math.max(end, block.to), 0);
  const tail = text.slice(end);
  if (tail.trim()) blocks.push({id: 'draft', from: end + tail.match(/^(?:[ \t]*\n)*/)[0].length, to: text.trimEnd().length, status: 'draft'});
  return blocks.map((block, index) => ({...block, number: index + 1, tone: index % 4}));
}
