import assert from 'node:assert/strict';
import {layoutBlocks} from '../web/block-layout.mjs';
import {ExecutionHistory} from '../web/execution-history.mjs';

const text = 'a = 1\n\nb = 2\n\ndraft = 3';
const a = {id:'a',from:0,to:5,source:'a = 1',dirty:false};
const b = {id:'b',from:5,to:12,source:'\n\nb = 2',dirty:false};
const history = {blocks:[a,b],pending:null};
let blocks = layoutBlocks(text, history, []);
assert.deepEqual(blocks.map(({id,from,to,number,tone,status})=>({id,from,to,number,tone,status})),[
  {id:'a',from:0,to:5,number:1,tone:0,status:'executed'},
  {id:'b',from:7,to:12,number:2,tone:1,status:'executed'},
  {id:'draft',from:14,to:23,number:3,tone:2,status:'draft'},
]);
assert.deepEqual(layoutBlocks('',{blocks:[],pending:null},[]),[], 'empty editor keeps its placeholder');
assert.equal(layoutBlocks(text,{blocks:[],pending:null},[])[0].status,'draft','new source is one draft block');
assert.equal(layoutBlocks(text,{blocks:[{...a,dirty:true},b],pending:null},[])[0].status,'modified','edits preserve the code block');
blocks = layoutBlocks(text,{...history,pending:{...b}},[]);
assert.equal(blocks.length,3,'replaying a block does not duplicate its visual region');
assert.equal(blocks[1].status,'running');
blocks = layoutBlocks(text,{...history,pending:{id:'all',from:0,to:text.length,all:true}},[]);
assert.deepEqual(blocks.map(block=>block.id),['all'],'run all replaces overlapping visual regions');
blocks = layoutBlocks(text,{blocks:[a],pending:null},[{id:'failed',from:7,to:12,status:'idle',error:true}]);
assert.equal(blocks[1].status,'failed','failed new code still has a code/output pair');
assert.equal(blocks[2].status,'draft','new work after a failed block stays distinct');
blocks = layoutBlocks(text,history,[{id:'selection',from:7,to:12,selection:true,status:'idle'}]);
assert.equal(blocks.length,3,'temporary selection results do not split execution regions');
blocks = layoutBlocks(text,{blocks:[{...a,from:0,to:0},b],pending:null},[]);
assert(blocks.every(block=>text.slice(block.from,block.to).trim()),'deleted empty blocks do not create cards');
assert.equal(layoutBlocks(text,history,[])[1].tone,layoutBlocks(text,{blocks:[a,{...b,dirty:true}],pending:null},[])[1].tone,'replaying or editing a block retains its palette');
const failedHistory = new ExecutionHistory();
failedHistory.begin(a); failedHistory.commit(text);
failedHistory.begin(b); failedHistory.fail();
assert.deepEqual(layoutBlocks(text,failedHistory.snapshot(),[]).map(block=>block.status),['executed','failed','draft'],'failed code boundaries persist without any output entries');
const restoredFailure = new ExecutionHistory();
restoredFailure.restore(failedHistory.snapshot(),text);
assert.equal(layoutBlocks(text,restoredFailure.snapshot(),[])[1].status,'failed','refresh preserves failed block boundaries');
console.log('PASS: visual block ranges, numbering, palettes, draft, replay, run-all, failure, empty blocks and selection outputs');
