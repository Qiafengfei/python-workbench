// Optional browser acceptance test: Node 22+ and a local Chrome installation.
// Uses Chrome's built-in debugging protocol, without npm dependencies.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = path.join(root, 'tests', 'browser-profile');
const externalBrowserPort = Number(process.env.EDITOR_TEST_BROWSER_PORT) || 0;
await fs.mkdir(profile, {recursive: true});
if (!externalBrowserPort) await fs.rm(path.join(profile, 'DevToolsActivePort'), {force: true});
const {url} = JSON.parse(await fs.readFile(process.env.EDITOR_TEST_RUNNING || path.join(root, '.running.json'), 'utf8'));
const chrome = externalBrowserPort ? null : spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], {windowsHide:true, stdio:['ignore','ignore','pipe']});
let browserLog = '';
chrome?.stderr.on('data', data => {browserLog = (browserLog + data).slice(-6000);});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
let acceptDialog = true;
const dialogs = [];
const browserErrors = [];
try {
  let port = externalBrowserPort;
  for (let i=0; !port && i<100; i++) {
    try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch { await sleep(100); }
  }
  assert(port, `Chrome debugging endpoint did not start. ${browserLog}`);
  const target = externalBrowserPort
    ? (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(tab => tab.type === 'page' && tab.url.startsWith(new URL(url).origin + '/'))
    : await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {method:'PUT'})).json();
  assert(target, 'the launcher must already have opened the editor page');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject) => {socket.onopen=resolve; socket.onerror=reject;});
  let sequence=0;
  const pending = new Map();
  socket.onmessage = ({data}) => {
    const message=JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') browserErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (message.method === 'Page.javascriptDialogOpening') {
      dialogs.push(message.params.message);
      send('Page.handleJavaScriptDialog',{accept:acceptDialog}).catch(()=>{});
    }
    if (message.id && pending.has(message.id)) {
      const {resolve,reject}=pending.get(message.id); pending.delete(message.id);
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
    }
  };
  function send(method, params={}) {
    return new Promise((resolve,reject) => { const id=++sequence; pending.set(id,{resolve,reject}); socket.send(JSON.stringify({id,method,params})); });
  }
  async function evaluate(expression) {
    let result;
    try { result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true}); }
    catch (error) { throw new Error(`${error.message} while evaluating: ${expression.slice(0,180)}`); }
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function wait(expression, label, timeout=10000) {
    const deadline=Date.now()+timeout;
    while(Date.now()<deadline) {
      try { if(await evaluate(expression)) return; }
      catch (error) { if (!/Inspected target navigated or closed|Cannot find context|Execution context was destroyed/.test(error.message)) throw error; }
      await sleep(70);
    }
    throw new Error(`Timed out: ${label}. DOM: ${await evaluate('document.body.innerText.slice(-2500)')}`);
  }
  async function fill(source, select=false) {
    await evaluate(`(()=>{const e=editor;e.value=${JSON.stringify(source)};e.focus();e.setSelectionRange(0,${select ? source.length : 0});})()`);
  }
  async function click(id) {await evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);}
  async function finishNew() {
    await wait(`document.getElementById('name-dialog').open`,'file name dialog');
    await evaluate(`document.getElementById('file-name-input').value='browser-${Date.now()}';document.getElementById('name-form').requestSubmit()`);
  }
  async function key(key, code, virtualKey, modifiers=0) {
    await send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:virtualKey,modifiers});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:virtualKey,modifiers});
  }
  const ready = `document.getElementById('status').textContent.includes('就绪') && !document.getElementById('run-code').disabled`;
  const bottom = `document.getElementById('output').textContent`;
  const inline = `[...document.querySelectorAll('.inline-output-text')].map(e=>e.textContent).join('')`;
  const output = `(${bottom} + ${inline})`;
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});
  await wait(`document.getElementById('status') && !document.getElementById('select-folder').disabled`,'initial connection');
  if (process.env.EDITOR_LAUNCHER_CLIENT) {
    await evaluate(`api('/api/client', {id:${JSON.stringify(process.env.EDITOR_LAUNCHER_CLIENT)},active:false,revision:4})`);
  }
  assert(await evaluate("Boolean(document.getElementById('close-output'))"),'output dock can be closed');
  const splitHeight = await evaluate("document.querySelector('.editor-pane').getBoundingClientRect().height");
  await click('close-output');
  assert(await evaluate("document.querySelector('.output-pane').getBoundingClientRect().height === 0 && document.getElementById('divider').getBoundingClientRect().height === 0"),'closing removes the dock and divider from layout');
  assert(await evaluate(`document.querySelector('.editor-pane').getBoundingClientRect().height > ${splitHeight}`),'closing gives the editor more space');
  assert(await evaluate("document.activeElement.id === 'show-output'"),'closing leaves keyboard focus on the reopen control');
  await click('show-output');
  assert(await evaluate(`Math.abs(document.querySelector('.editor-pane').getBoundingClientRect().height - ${splitHeight}) < 1`),'reopening restores the split height');
  assert(await evaluate(`document.getElementById('new-file').disabled && editor.readOnly`),'folder must precede new file');
  await click('new-file');
  assert(await evaluate(`editor.readOnly`),'disabled new button must do nothing');
  await click('select-folder');
  await wait(`!document.getElementById('new-file').disabled && document.getElementById('workspace-folder').textContent.includes('browser-workspace')`,'choose workspace folder');
  assert(await evaluate(`editor.readOnly`),'selecting folder must not create a file');
  await click('new-file');
  await wait(`document.getElementById('name-dialog').open`,'name before new file');
  await evaluate(`document.getElementById('cancel-name').click()`);
  await wait(`!document.getElementById('name-dialog').open && !document.getElementById('new-file').disabled`,'cancel file naming');
  assert(await evaluate('editor.readOnly'),'cancel must not create a file');
  await click('new-file');
  await finishNew();
  await wait(ready,'new file in selected folder');
  const initialPath = await evaluate(`document.getElementById('file-path').textContent`);
  await fill('unsaved_name = 9');
  await evaluate(`globalThis.savedFetch=window.fetch;globalThis.holdNextPoll=true;window.fetch=async(...args)=>{const response=await savedFetch(...args);if(holdNextPoll&&String(args[0]).startsWith('/api/events')){holdNextPoll=false;await new Promise(resolve=>globalThis.releaseHeldPoll=resolve);}return response;}`);
  await wait(`typeof globalThis.releaseHeldPoll === 'function'`,'hold a pre-rename poll');
  await click('rename-file');
  await wait(`document.getElementById('name-dialog').open`,'rename dialog');
  const renamed = `renamed-${Date.now()}.py`;
  await evaluate(`document.getElementById('file-name-input').value=${JSON.stringify(renamed)};document.getElementById('name-form').requestSubmit()`);
  await wait(`document.getElementById('filename').textContent === ${JSON.stringify(renamed)} && !document.getElementById('name-dialog').open && !document.getElementById('save-file').disabled`,'rename complete');
  await evaluate(`releaseHeldPoll();window.fetch=savedFetch`);
  await sleep(80);
  assert(await evaluate(`!editor.readOnly && !document.getElementById('save-file').disabled && editor.value === 'unsaved_name = 9'`),'old poll must not disable renamed unsaved code');
  const renamedPath = await evaluate(`document.getElementById('file-path').textContent`);
  await assert.rejects(fs.stat(initialPath));
  assert.equal(await fs.readFile(renamedPath,'utf8'),'');
  await key('s','KeyS',83,2);
  await wait(`document.getElementById('dirty-dot').hidden`,'save renamed draft');
  assert.equal(await fs.readFile(renamedPath,'utf8'),'unsaved_name = 9');
  await fill('# 语法配色\nfrom statistics import mean\nvalues = [1, 2, 3]\nlabel = "Python"');
  await wait(`Boolean(document.querySelector('.tok-keyword') && document.querySelector('.tok-string') && document.querySelector('.tok-comment') && document.querySelector('.tok-number'))`,'Python syntax highlighting');
  assert(await evaluate(`getComputedStyle(document.querySelector('.tok-keyword')).color !== getComputedStyle(document.querySelector('.tok-string')).color`),'keywords and strings have different readable colors');
  assert(await evaluate(`getComputedStyle(document.querySelector('.cm-scroller')).fontFamily.includes('Cascadia')`),'editor uses the available code typeface');
  assert(await evaluate(`document.getElementById('editor-surface').getBoundingClientRect().top < 170`),'desktop chrome leaves space for code');
  assert(await evaluate(`!document.querySelector('.cm-tooltip-autocomplete')`),'syntax highlighting does not enable code completion');
  const newlineCases = [
    ['top-level statement', 'value = 1', ''],
    ['closed outer list', 'values = [\n    1,\n    2]', ''],
    ['closed nested lists', 'values = [\n    [1, 2],\n    [3, 4]]', ''],
    ['closed call and list', 'result = sum([\n    1,\n    2])', ''],
    ['closed dictionary', 'config = {\n    "name": "test"}', ''],
    ['inside outer list', 'values = [\n    [1, 2],', '    '],
    ['new block body', 'if True:', '    '],
    ['same block level', 'if True:\n    value = 1', '    '],
    ['same nested block level', 'if True:\n    if True:\n        value = 1', '        '],
    ['list closed inside block', 'if True:\n    values = [\n        1,\n        2]', '    '],
    ['comment colon is not a block', '# note:', ''],
  ];
  for (const [label, source, indent] of newlineCases) {
    await fill(source);
    await evaluate('editor.setSelectionRange(editor.value.length,editor.value.length)');
    await key('Enter','Enter',13);
    assert.equal(await evaluate('editor.value'),source + '\n' + indent,`Enter indentation: ${label}`);
    assert.equal(await evaluate('editor.selectionStart'),source.length + 1 + indent.length,`Enter caret: ${label}`);
  }
  console.log('PASS: Enter follows Python scope, returns to the top level after closing outer brackets, and retains nested indentation');
  const tensorSource = 'logits = torch.tensor([[0.0,0.0],\n                        [0.0,1.0],\n                        [1.0,0.0],\n                        [1.0,1.0],\n                        [0.5,0.5],\n                        [0.22,0.8]\n                      ],dtype = torch.float32)';
  const tensorRow = tensorSource.indexOf('[0.22,0.8]');
  const tensorEnd = tensorRow + '[0.22,0.8]'.length;
  await fill(tensorSource);
  await evaluate(`editor.setSelectionRange(${tensorEnd},${tensorEnd})`);
  await key('Enter','Enter',13);
  assert.equal(await evaluate('editor.value'),tensorSource.slice(0,tensorEnd) + '\n' + ' '.repeat(24) + tensorSource.slice(tensorEnd),'tensor continuation preserves the manually aligned row indentation');
  assert.equal(await evaluate('editor.view.state.doc.lineAt(editor.selectionStart).text'),' '.repeat(24),'caret aligns with the previous row opening bracket, not the first row or closing outer bracket');
  for (const [source, marker, width] of [
    ['matrix = [[1, 2],\n            [3, 4],\n          ]','[3, 4],',12],
    ['call(\n          first,\n          second\n    )','second',10],
    ['config = {\n          "one": 1,\n          "two": 2\n    }','"two": 2',10],
  ]) {
    const end = source.indexOf(marker) + marker.length;
    await fill(source);
    await evaluate(`editor.setSelectionRange(${end},${end})`);
    await key('Enter','Enter',13);
    assert.equal(await evaluate('editor.value'),source.slice(0,end) + '\n' + ' '.repeat(width) + source.slice(end),'nested continuations preserve the existing level for lists, calls and dictionaries');
  }
  await fill(tensorSource);
  await evaluate(`editor.focus();editor.setSelectionRange(${tensorEnd},${tensorEnd})`);
  await wait('Boolean(document.querySelector(".cm-matchingBracket") && document.querySelector(".cm-cursor-primary"))','tensor row with matching brackets and caret');
  assert(await evaluate('getComputedStyle(document.querySelector(".cm-cursor-primary")).borderLeftWidth === "2px"'),'bracket position has a distinct two-pixel caret');
  assert(await evaluate('getComputedStyle(document.querySelector(".cm-matchingBracket")).outlineStyle === "none"'),'bracket hint does not draw a box over the caret');
  assert(await evaluate('getComputedStyle(document.querySelector(".cm-matchingBracket")).textDecorationLine.includes("underline")'),'matching brackets use an underline');
  await sleep(50);
  const caretPreview = await send('Page.captureScreenshot',{format:'png'});
  await fs.writeFile(path.join(root,'docs','cursor-bracket-preview.png'),Buffer.from(caretPreview.data,'base64'));
  await evaluate(`editor.setSelectionRange(${tensorRow},${tensorEnd})`);
  await wait('Boolean(document.querySelector(".cm-cursor-primary"))','selected tensor row retains a caret');
  assert(await evaluate('getComputedStyle(document.querySelector(".cm-cursor-primary")).borderLeftWidth === "2px"'),'selected text also retains the two-pixel caret');
  console.log('PASS: user tensor example, preserved continuation alignment, selection caret and unobtrusive bracket hints');
  const originalInterpreter = await evaluate(`document.getElementById('interpreter').value`);
  await click('add-interpreter');
  await wait(`document.getElementById('interpreters-dialog').open && document.getElementById('scan-status').textContent.includes('找到') && document.querySelectorAll('#discovered-list .interpreter-entry').length > 0`,'automatic interpreter discovery');
  const detectedCount = await evaluate(`document.querySelectorAll('#discovered-list .interpreter-entry').length`);
  console.log(`Auto discovery: ${detectedCount} Python environments`);
  const discoveryImage = await send('Page.captureScreenshot',{format:'png'});
  await fs.writeFile(path.join(root,'docs','interpreter-discovery.png'),Buffer.from(discoveryImage.data,'base64'));
  if (await evaluate(`Boolean(document.querySelector('#discovered-list button:not(:disabled)'))`)) {
    await evaluate(`document.querySelector('#discovered-list button:not(:disabled)').click()`);
    await wait(`${ready} && document.getElementById('interpreter').value !== ${JSON.stringify(originalInterpreter)}`,'choose discovered interpreter');
    const testedInterpreter = await evaluate(`document.getElementById('interpreter').value`);
    await evaluate(`(()=>{const s=document.getElementById('interpreter');s.value=${JSON.stringify(originalInterpreter)};s.dispatchEvent(new Event('change'));})()`);
    await wait(`${ready} && document.getElementById('interpreter').value === ${JSON.stringify(originalInterpreter)}`,'restore initial interpreter');
    await evaluate(`(()=>{const row=[...document.querySelectorAll('#interpreter-list .interpreter-entry')].find(e=>e.querySelector('small').textContent===${JSON.stringify(testedInterpreter)});[...row.querySelectorAll('button')].find(b=>b.textContent==='移除').click();})()`);
    await wait(`${ready} && ![...document.getElementById('interpreter').options].some(o=>o.value===${JSON.stringify(testedInterpreter)})`,'remove test-only setting');
  }
  await click('close-interpreters');
  await click('clear-output');
  await wait(`${ready} && ${output} === ''`,'clear previous output');
  async function append(source) {
    await evaluate(`editor.focus();editor.setSelectionRange(editor.value.length,editor.value.length);editor.insertText(${JSON.stringify(source)})`);
  }
  async function replaceCode(before, after) {
    await evaluate(`(()=>{const p=editor.value.indexOf(${JSON.stringify(before)});if(p<0)throw new Error('missing edit target');editor.setSelectionRange(p,p+${before.length});editor.insertText(${JSON.stringify(after)});})()`);
  }
  async function run() { await key('Enter','Enter',13,2); await wait(ready,'execution finished'); }
  async function visualPair(id, number) {
    const header = `.code-block-header[data-code-block-id="${id}"]`;
    const result = `.inline-output[data-run-id="${id}"]`;
    await wait(`Boolean(document.querySelector('${header}') && document.querySelector('${result}'))`,'paired code and output cards');
    assert(await evaluate(`document.querySelector('${header}').dataset.blockNumber === '${number}' && document.querySelector('${result}').dataset.blockNumber === '${number}'`),'code and output share the same visible number');
    assert(await evaluate(`getComputedStyle(document.querySelector('${header}')).getPropertyValue('--block-color') === getComputedStyle(document.querySelector('${result}')).getPropertyValue('--block-color')`),'code and output share a palette');
    assert(await evaluate(`Boolean(document.querySelector('.cm-code-block[data-code-block-id="${id}"]'))`),'the code itself has a colored region');
  }
  const clickFailures = [];
  for (const [count, phase] of [[0,'normal'],[1,'normal'],[3,'normal'],[3,'clear'],[3,'reload'],[3,'mobile']]) {
    await fill('');
    for (let index=0; index<count; index++) {
      const printed = index % 2 ? `click-output-${index}\nsecond line\nthird line` : `click-output-${index}`;
      await append(`${index ? '\n' : ''}print(${JSON.stringify(printed)})`);
      await run();
    }
    const draftLines = Array.from({length:8},(_,index)=>`click_draft_${index + 1} = ${index + 1}`);
    await append((count ? '\n' : '') + draftLines.join('\n'));
    if (phase === 'clear') { await click('clear-output'); await wait(ready,'clear before mouse clicks'); }
    if (phase === 'reload') {
      const origin = await evaluate('performance.timeOrigin');
      await send('Page.reload',{ignoreCache:true});
      await wait(`performance.timeOrigin !== ${origin} && ${ready}`,'reload before mouse clicks');
    }
    if (phase === 'mobile') await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await wait(`editor.resultSnapshots().length === ${phase === 'clear' ? 0 : count}`,'prepare click-coordinate regression');
    for (const index of [0,3,7]) {
      const marker = draftLines[index];
      await evaluate(`editor.setSelectionRange(editor.value.indexOf(${JSON.stringify(marker)})+1,editor.value.indexOf(${JSON.stringify(marker)})+1)`);
      await sleep(100);
      await evaluate(`(()=>{const line=[...document.querySelectorAll('.cm-line')].find(line=>line.textContent===${JSON.stringify(marker)});line.scrollIntoView({block:'center',inline:'nearest'});})()`);
      await sleep(80);
      const target = await evaluate(`(()=>{
        const marker=${JSON.stringify(marker)}, pos=editor.value.indexOf(marker)+6;
        const line=[...document.querySelectorAll('.cm-line')].find(line=>line.textContent===marker);
        if(!line)throw new Error('click target line is not rendered');
        const walker=document.createTreeWalker(line,NodeFilter.SHOW_TEXT);
        let node, offset=6;
        while(node=walker.nextNode()){if(offset<=node.length)break;offset-=node.length;}
        const range=document.createRange();range.setStart(node,offset);range.setEnd(node,offset);
        const rect=range.getBoundingClientRect();
        const block=editor.view.lineBlockAt(pos);
        const viewport=editor.view.scrollDOM.getBoundingClientRect();
        if(rect.top<viewport.top||rect.bottom>viewport.bottom)throw new Error('mouse target is outside the visible editor');
        return {x:rect.left,y:(rect.top+rect.bottom)/2,pos,line:editor.view.state.doc.lineAt(pos).number,domTop:line.getBoundingClientRect().top,documentTop:editor.view.documentTop,modelTop:block.top,modelHeight:block.height};
      })()`);
      await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:target.x,y:target.y});
      await send('Input.dispatchMouseEvent',{type:'mousePressed',x:target.x,y:target.y,button:'left',clickCount:1});
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:target.x,y:target.y,button:'left',clickCount:1});
      const actual = await evaluate('({pos:editor.view.state.selection.main.head,line:editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number})');
      if(actual.pos!==target.pos)clickFailures.push({outputs:count,phase,targetLine:target.line,actualLine:actual.line,expected:target.pos,actual:actual.pos,domTop:target.domTop,modelTop:target.modelTop+target.documentTop,height:target.modelHeight});
      if (count === 3 && index === 3) {
        const before = await evaluate('editor.value');
        await send('Input.insertText',{text:'typed_'});
        assert.equal(await evaluate('editor.value'),before.slice(0,target.pos)+'typed_'+before.slice(target.pos),'typing occurs exactly where the mouse clicked');
        await key('z','KeyZ',90,2);
        assert.equal(await evaluate('editor.value'),before,'undo restores the clicked draft line');
      }
    }
    if (phase === 'mobile') await send('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});
  }
  assert.deepEqual(clickFailures,[],'clicking visible draft text maps to the actual source position regardless of output cards');
  console.log('PASS: actual mouse clicks and typing hit exact draft positions with 0/1/3 outputs, multiline output, scrolling, clear, reload and mobile');
  await fill('import math\ncounter = 1\nx = math.sqrt(4)\nprint("A", x)');
  await evaluate('editor.setSelectionRange(0,0)');
  await run();
  await wait(`${inline}.includes('A 2.0')`,'first execution includes imports regardless of cursor');
  assert.equal(await evaluate('editor.execution.blocks.length'),1);
  const firstId=await evaluate('editor.execution.blocks[0].id');
  await visualPair(firstId,1);
  await run();
  assert.equal(await evaluate('editor.execution.blocks.length'),1,'unchanged source must not rerun');
  await append('\ncounter += 1\nprint("B", counter, x)');
  await evaluate('editor.setSelectionRange(0,0)');
  await run();
  await wait(`${inline}.includes('B 2 2.0')`,'only appended code executes');
  assert(await evaluate(`${inline}.includes('A 2.0')`),'appending a new block must preserve earlier output');
  const secondId=await evaluate('editor.execution.blocks[1].id');
  await visualPair(secondId,2);
  const firstPalette = await evaluate(`getComputedStyle(document.querySelector('.code-block-header[data-code-block-id="${firstId}"]')).getPropertyValue('--block-color')`);
  assert(await evaluate(`getComputedStyle(document.querySelector('.code-block-header[data-code-block-id="${secondId}"]')).getPropertyValue('--block-color') !== ${JSON.stringify(firstPalette)}`),'adjacent execution blocks have different colors');
  await replaceCode('counter += 1','counter += 2');
  await wait(`document.querySelector('.code-block-header[data-code-block-id="${secondId}"]').textContent.includes('需重跑')`,'modified code stays in its existing card');
  await run();
  await wait(`${inline}.includes('B 4 2.0')`,'last block edits retain variables and rerun only last block');
  assert.equal(await evaluate('editor.execution.blocks[0].id'),firstId);
  await visualPair(secondId,2);
  await replaceCode('sqrt(4)','sqrt(9)');
  await run();
  await wait(`${inline}.includes('A 3.0') && ${inline}.includes('B 3 3.0')`,'earlier edits rerun downstream blocks');
  assert.deepEqual(await evaluate('editor.execution.blocks.map(b=>b.id)'),[firstId,secondId]);
  assert(await evaluate(`(()=>{const a=document.querySelector('[data-run-id="${firstId}"]');const b=document.querySelector('[data-run-id="${secondId}"]');return a.getBoundingClientRect().top < b.getBoundingClientRect().top;})()`),'outputs keep original block positions');
  await append('\ncalls = globals().get("calls", 0) + 1\nprint("C", calls, x)');
  await run();
  await wait(`${inline}.includes('C 1 3.0')`,'third execution block');
  await replaceCode('counter += 2','counter += missing_value');
  await run();
  await wait(`${inline}.includes('NameError')`,'failed earlier block');
  assert(await evaluate(`${inline}.includes('C 1 3.0') && !${inline}.includes('C 2 3.0')`),'failure pauses downstream blocks');
  await replaceCode('counter += missing_value','counter += 2');
  await run();
  await wait(`${inline}.includes('C 2 3.0')`,'retry resumes dirty block chain without losing variables');
  await append('\nprint("before-error")\n1 / 0');
  await run();
  assert.equal(await evaluate('editor.execution.blocks.length'),3,'failed new block must not advance boundary');
  await replaceCode('1 / 0','print("after-fix")');
  await run();
  await wait(`${inline}.includes('after-fix')`,'failed appended code is retried');
  assert.equal(await evaluate('editor.execution.blocks.length'),4);
  await click('close-output');
  await append('\nprint("INPUT", input("姓名："))');
  await key('Enter','Enter',13,2);
  await wait(`!document.getElementById('input-form').hidden`,'incremental input request');
  assert(await evaluate("document.querySelector('.output-pane').getBoundingClientRect().height > 0 && document.activeElement.id === 'program-input'"),'input automatically reopens the dock and focuses the input');
  const oldOrigin=await evaluate('performance.timeOrigin');
  await send('Page.reload',{ignoreCache:true});
  await wait(`performance.timeOrigin !== ${oldOrigin} && document.querySelector('.cm-editor')`,'reload during input');
  await wait(`!document.getElementById('input-form').hidden`,'input survives reload');
  await evaluate(`document.getElementById('program-input').value='小明';document.getElementById('input-form').requestSubmit()`);
  await wait(`${ready} && ${inline}.includes('INPUT 小明')`,'pending block commits after reload');
  assert.equal(await evaluate('editor.execution.blocks.length'),5);
  await evaluate('editor.setSelectionRange(0,0)');
  await visualPair(firstId,1);
  await run();
  assert(await evaluate(`document.getElementById('input-form').hidden`),'refresh must preserve execution boundary');
  await append('\nprint("after-refresh")'); await run();
  await wait(`${inline}.includes('after-refresh')`,'append after refresh');
  await click('run-all');
  await wait(`!document.getElementById('input-form').hidden`,'run all repeats whole script including input');
  await evaluate(`document.getElementById('program-input').value='all';document.getElementById('input-form').requestSubmit()`);
  await wait(`${ready} && ${bottom}.includes('INPUT all') && ${bottom}.includes('after-refresh')`,'run all uses lower output');
  assert.equal(await evaluate(`document.querySelectorAll('.inline-output').length`),0,'run all clears inline outputs');
  assert.equal(await evaluate('editor.execution.blocks.length'),1,'run all records a single completed block');
  await wait(`document.querySelectorAll('.code-block-header').length === 1`,'run all becomes a single code card');
  assert(await evaluate(`document.getElementById('output').dataset.label.startsWith('输出 1')`),'run-all output has its own corresponding card label');
  await append('\nimport time\nprint("streaming", flush=True)\ntime.sleep(30)');
  await key('Enter','Enter',13,2);
  await wait(`!document.getElementById('stop-code').disabled && ${inline}.includes('streaming')`,'incremental streaming');
  await click('stop-code'); await wait(ready,'stop and reset');
  assert.equal(await evaluate('editor.execution.blocks.length'),0,'reset invalidates all execution boundaries');

  // Exercise deletion through the actual editor, including undo's unfiltered transactions.
  await fill('guard_a = 1\nprint("guard A")'); await run();
  await append('\nguard_b = 2\nprint("guard B")'); await run();
  await append('\ndraft_only = 3');
  const guardedSource = await evaluate('editor.value');
  const guardedEnd = await evaluate('editor.execution.blocks[1].to');
  let dialogCount = dialogs.length;
  await evaluate(`editor.focus();editor.setSelectionRange(${guardedEnd + 1},${guardedEnd + 1})`);
  await key('Backspace','Backspace',8);
  assert.equal(await evaluate('editor.value'),guardedSource,'backspace stops at the executed boundary');
  await evaluate(`editor.setSelectionRange(${guardedEnd},${guardedEnd})`);
  await key('Delete','Delete',46);
  assert.equal(await evaluate('editor.value'),guardedSource,'forward delete cannot join the executed block and draft');
  assert.equal(dialogs.length,dialogCount,'boundary stops without repeated modal dialogs');
  await replaceCode('guard_a = 1','guard_a = 4');
  // This replacement covers only part of the first block, and needs no confirmation.
  assert.equal(dialogs.length,dialogCount);
  const editedGuardedSource = await evaluate('editor.value');
  const guardedState = await evaluate('JSON.stringify({history:editor.execution.snapshot(),results:editor.resultSnapshots()})');
  acceptDialog = false;
  await evaluate('editor.focus();editor.setSelectionRange(0,editor.execution.blocks[0].to)');
  await key('Backspace','Backspace',8);
  assert.equal(await evaluate('editor.value'),editedGuardedSource,'cancelled full-block deletion preserves source');
  assert.equal(await evaluate('JSON.stringify({history:editor.execution.snapshot(),results:editor.resultSnapshots()})'),guardedState,'cancellation preserves execution state and output');
  assert.match(dialogs.at(-1),/1 个已运行代码块/);
  await key('x','KeyX',88,2);
  assert.equal(await evaluate('editor.value'),editedGuardedSource,'cancelled cut preserves source');
  assert.equal(dialogs.length,dialogCount + 2,'cut also asks before deletion');
  await evaluate(`editor.setSelectionRange(0,${guardedEnd})`);
  dialogCount = dialogs.length;
  await key('v','KeyV',86,2);
  assert.equal(await evaluate('editor.value'),editedGuardedSource,'cancelled clipboard paste preserves both blocks');
  assert.equal(dialogs.length,dialogCount + 1,'clipboard paste uses the same protection');
  assert.match(dialogs.at(-1),/2 个已运行代码块/);
  await send('Input.insertText',{text:'replacement = 9'});
  assert.equal(await evaluate('editor.value'),editedGuardedSource,'cancelled paste/typing replacement preserves both blocks');
  assert.equal(await evaluate(`[...document.querySelectorAll('.cm-line')].map(line=>line.textContent).join('\\n')`),editedGuardedSource,'cancelled native input also restores visible editor content');
  assert.match(dialogs.at(-1),/2 个已运行代码块/);
  await evaluate('editor.setSelectionRange(2,2)');
  await wait(`!document.getElementById('delete-block').hidden && !document.getElementById('delete-block').disabled`,'explicit block deletion entry');
  await click('delete-block');
  assert.equal(await evaluate('editor.value'),editedGuardedSource,'cancelled explicit deletion preserves source');
  acceptDialog = true;
  await click('delete-block');
  assert(await evaluate(`!editor.value.includes('guard_a') && editor.value.includes('guard_b') && editor.value.includes('draft_only')`),'explicit deletion removes only the current block');
  await evaluate('editor.focus()'); await key('z','KeyZ',90,2);
  assert.equal(await evaluate('editor.value'),editedGuardedSource,'confirmed deletion can be undone');
  acceptDialog = false;
  dialogCount = dialogs.length;
  await key('y','KeyY',89,2);
  assert.equal(await evaluate('editor.value'),editedGuardedSource,'redo cannot bypass deletion confirmation');
  assert.equal(dialogs.length,dialogCount + 1);
  await fill(''); await append('undo_guard = 1'); await run();
  dialogCount = dialogs.length;
  await key('z','KeyZ',90,2);
  assert.equal(await evaluate('editor.value'),'undo_guard = 1','undo cannot erase freshly executed code without confirmation');
  assert.equal(dialogs.length,dialogCount + 1);
  acceptDialog = true;
  await key('z','KeyZ',90,2);
  assert.equal(await evaluate('editor.value'),'','confirmed undo removes the executed code');
  await key('y','KeyY',89,2);
  assert.equal(await evaluate('editor.value'),'undo_guard = 1');
  await append('\ndraft = 2');
  await evaluate('editor.setSelectionRange(editor.value.indexOf("draft"),editor.value.length)');
  dialogCount = dialogs.length;
  await key('Backspace','Backspace',8);
  assert.equal(dialogs.length,dialogCount,'unexecuted draft deletion stays free');
  const beforeProtectionReload = await evaluate('performance.timeOrigin');
  await send('Page.reload',{ignoreCache:true});
  await wait(`performance.timeOrigin !== ${beforeProtectionReload} && ${ready}`,'reload protected draft');
  acceptDialog = false;
  await evaluate('editor.focus();editor.setSelectionRange(0,editor.value.length)');
  dialogCount = dialogs.length;
  await key('Backspace','Backspace',8);
  assert.equal(dialogs.length,dialogCount + 1,'refresh preserves deletion protection');
  acceptDialog = true;
  await click('clear-output'); await wait(ready,'clear output with protection');
  await wait(`document.querySelectorAll('.inline-output').length === 0 && document.querySelectorAll('.code-block-header').length === 1`,'clearing output keeps the code card');
  acceptDialog = false;
  await evaluate('editor.focus();editor.setSelectionRange(0,editor.value.length)');
  dialogCount = dialogs.length;
  await key('Backspace','Backspace',8);
  assert.equal(dialogs.length,dialogCount + 1,'clearing output does not remove protection');
  acceptDialog = true;
  await click('reset-session'); await wait(ready,'reset protection');
  await evaluate('editor.focus();editor.setSelectionRange(0,editor.value.length)');
  dialogCount = dialogs.length;
  await key('Backspace','Backspace',8);
  assert.equal(await evaluate('editor.value'),'');
  assert.equal(dialogs.length,dialogCount,'reset session removes block protection');
  await fill('partial_guard = 1');
  await replaceCode('= 1','= 2'); await run();
  await evaluate('editor.focus()'); await key('z','KeyZ',90,2);
  assert.equal(await evaluate('editor.value'),'partial_guard = 1');
  assert.equal(await evaluate('editor.execution.blocks.length'),1,'undo of a pre-execution edit must retain the executed block');
  assert.equal(await evaluate('editor.execution.plan(editor.value).length'),1,'undo after execution marks the changed code for replay');
  await fill('replacement_guard = 1'); await run();
  await evaluate('editor.setSelectionRange(0,editor.value.length);editor.insertText("replacement_guard = 2")');
  await run();
  await evaluate('editor.focus()'); await key('z','KeyZ',90,2);
  assert.equal(await evaluate('editor.value'),'replacement_guard = 1');
  assert.equal(await evaluate('editor.execution.plan(editor.value).length'),1,'undo of an executed replacement must compare against the latest executed source');
  await fill('removed_guard = 1'); await run();
  await append('\nreplay_guard = 1'); await run();
  await evaluate('editor.setSelectionRange(1,1)'); await click('delete-block');
  await replaceCode('replay_guard = 1','replay_guard = 2');
  await click('run-all'); await wait(ready,'run all supersedes old execution boundaries');
  await evaluate('editor.focus()'); await key('z','KeyZ',90,2); await key('z','KeyZ',90,2);
  assert(await evaluate('editor.value.includes("removed_guard = 1") && editor.value.includes("replay_guard = 1")'));
  assert.equal(await evaluate('editor.execution.blocks.length'),1,'undo after run all keeps the latest whole-script execution record');
  assert.equal(await evaluate('editor.execution.plan(editor.value).length'),1,'restoring deleted code cannot forget newer execution after run all');
  await fill('old_guard = 1'); await run();
  await append('\nnext_guard = 2'); await run();
  await append('\nnewer_guard = 3');
  await evaluate('editor.setSelectionRange(1,1)'); await click('delete-block');
  await run();
  await evaluate('editor.focus()'); await key('z','KeyZ',90,2);
  assert(await evaluate('editor.execution.blocks.some(block=>block.source.includes("newer_guard = 3"))'),'undo deletion retains blocks first executed after the deletion');
  const visualReviewFailures = [];
  await fill('visual_base = 1'); await run();
  await append('\n1 / 0'); await run();
  await append('\nvisual_draft = 2');
  await wait(`document.querySelectorAll('.code-block-header').length === 3`,'failed block and later draft are separate cards');
  await click('clear-output'); await wait(ready,'clear failed output');
  await sleep(100);
  if (await evaluate('document.querySelectorAll(".code-block-header").length') !== 3) visualReviewFailures.push('clearing output must preserve failed code boundaries and later draft');
  await fill('import sys\nprint("a warning", file=sys.stderr)'); await run();
  await wait(`${inline}.includes('a warning')`,'successful stderr output');
  if (!await evaluate('document.querySelector(".inline-output .result-status").textContent.includes("已完成")')) visualReviewFailures.push('successful stderr output must not be labelled as a failed execution');
  await fill('silent_total = 1'); await click('run-all'); await wait(ready,'silent run all completed');
  if (!await evaluate('document.getElementById("output").textContent.includes("本块没有输出") && document.getElementById("output-empty").hidden')) visualReviewFailures.push('silent run all must display a completed output card');
  assert.deepEqual(visualReviewFailures,[],'visual grouping review regressions');
  const silentReloadTime = await evaluate('performance.timeOrigin');
  await send('Page.reload',{ignoreCache:true});
  await wait(`performance.timeOrigin !== ${silentReloadTime} && ${ready} && ${bottom}.includes('本块没有输出')`,'silent run-all card survives refresh');
  assert.equal(await evaluate('document.querySelectorAll("#output .event-empty").length'),1,'silent output placeholder is not duplicated by polling');
  console.log('PASS: executed block boundary, partial edits, cancel/confirm, cut, replacement, explicit deletion, undo/redo, refresh, clear and reset');

  await fill('temporary = 8');
  await click('new-file');
  await wait(`document.getElementById('confirm-dialog').open`,'unsaved dialog');
  await evaluate(`document.querySelector('#confirm-dialog button[value="cancel"]').click()`);
  await wait(`!document.getElementById('confirm-dialog').open && !document.getElementById('new-file').disabled && editor.value === 'temporary = 8'`,'cancel preserves code');
  await click('new-file');
  await wait(`document.getElementById('confirm-dialog').open`,'discard dialog');
  await evaluate(`document.querySelector('#confirm-dialog button[value="discard"]').click()`);
  await finishNew();
  await wait(`${ready} && editor.value === ''`,'new file');
  await key('Tab','Tab',9);
  assert.equal(await evaluate('editor.value'),'    ');
  await key('z','KeyZ',90,2);
  assert.equal(await evaluate('editor.value'),'');
  await fill('x = 1'); await run();
  await wait(`${inline}.includes('本块没有输出')`,'silent assignment still has an output card');
  await append('\nx + 1'); await run();
  await wait(`${inline}.includes('2')`,'preview expression');
  await append('\nprint("你好，Python！")'); await run();
  await wait(`${inline}.includes('你好，Python！')`,'preview print');
  await wait(`document.getElementById('toast').hidden`,'toast finished');
  const sourceOnly=await evaluate('editor.value');
  await key('s','KeyS',83,2);
  await wait(`document.getElementById('dirty-dot').hidden`,'save source without results');
  const savedPath=await evaluate(`document.getElementById('file-path').textContent`);
  assert.equal(await fs.readFile(savedPath,'utf8'),sourceOnly);
  await wait(`document.getElementById('toast').hidden`,'save toast finished');
  await fs.mkdir(path.join(root,'docs'),{recursive:true});
  const image = await send('Page.captureScreenshot',{format:'png'});
  await fs.writeFile(path.join(root,'docs','editor-preview.png'),Buffer.from(image.data,'base64'));
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await sleep(200);
  await evaluate('editor.setSelectionRange(0,2)');
  assert(await evaluate(`!document.getElementById('delete-block').hidden && !document.getElementById('run-selection').hidden`),'narrow layout includes both block deletion and selection execution');
  assert(await evaluate(`document.querySelector('.run-actions').getBoundingClientRect().right <= innerWidth`),'mobile actions stay within the screen');
  await evaluate('editor.setSelectionRange(editor.value.length,editor.value.length)');
  await evaluate(`document.getElementById('output-scroll').scrollTop=document.getElementById('output-scroll').scrollHeight`);
  assert(await evaluate(`document.documentElement.scrollWidth <= innerWidth`),'mobile horizontal overflow');
  const mobile = await send('Page.captureScreenshot',{format:'png'});
  await fs.writeFile(path.join(root,'docs','editor-mobile.png'),Buffer.from(mobile.data,'base64'));
  await evaluate(`editor.setSelectionRange(0,0);editor.insertText(${JSON.stringify('\n')})`);
  assert.equal(await evaluate(`document.querySelectorAll('.inline-output').length`),3,'unrelated insertion must keep results, including silent blocks, attached');
  await evaluate(`(()=>{const end=editor.value.indexOf('x + 1')+5;editor.setSelectionRange(end,end);editor.insertText(' + 1');})()`);
  assert.equal(await evaluate(`document.querySelectorAll('.inline-output').length`),2,'editing executed code must remove only its stale result');
  await fill('race_value = 0\nprint("race-A")'); await run();
  await append('\nrace_value += 1\nprint("race-B")'); await run();
  await replaceCode('race_value = 0','race_value = 10');
  await evaluate(`globalThis.savedStopFetch=window.fetch;globalThis.raceRequests=0;window.fetch=async(...args)=>{if(String(args[0])==='/api/execute'&&++raceRequests===2)await new Promise(resolve=>globalThis.releaseNextExecute=resolve);return savedStopFetch(...args);}`);
  await key('Enter','Enter',13,2);
  await wait(`typeof globalThis.releaseNextExecute === 'function' && !document.getElementById('stop-code').disabled`,'hold automatically queued block request');
  await click('stop-code'); await wait(ready,'reset while queued request is in flight');
  const stoppedGeneration=await evaluate('state.session.generation');
  await evaluate(`releaseNextExecute();window.fetch=savedStopFetch`);
  await sleep(400);
  assert(await evaluate(`state.session.generation===${stoppedGeneration} && state.session.status==='idle' && editor.execution.blocks.length===0`),'late execute must not restart code after stop');
  assert(await evaluate(`api('/api/events?after=0').then(result=>!result.events.some(event=>event.type==='code'&&event.generation===${stoppedGeneration}))`),'stopped generation must contain no late queued execution');

  // Real executed Python for the visual review; no placeholder output.
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});
  await fill('from statistics import mean\nscores = [86, 92, 78, 95, 88]\nround(mean(scores), 1)');
  await run();
  await wait(`${inline}.includes('87.8')`,'real summary result');
  await append('\npassed = [score for score in scores if score >= 85]\nprint(f"达标 {len(passed)} / {len(scores)}")');
  await run();
  await wait(`${inline}.includes('达标 4 / 5')`,'real comprehension result');
  await evaluate('save(true)');
  await append('\nhighest = max(scores)\nhighest');
  await wait(`document.querySelectorAll('.code-block-header').length === 3 && [...document.querySelectorAll('.code-block-header')].at(-1).textContent.includes('待运行')`,'unexecuted source has a separate draft card');
  await evaluate('editor.setSelectionRange(editor.value.indexOf("passed ="),editor.value.indexOf("passed ="));editor.view.scrollDOM.scrollTop=0;document.getElementById("toast").hidden=true');
  await sleep(150);
  const designDesktop = await send('Page.captureScreenshot',{format:'png'});
  await fs.writeFile(path.join(root,'docs','editor-preview.png'),Buffer.from(designDesktop.data,'base64'));
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await sleep(150);
  await evaluate('editor.view.scrollDOM.scrollTop=0');
  const designMobile = await send('Page.captureScreenshot',{format:'png'});
  await fs.writeFile(path.join(root,'docs','editor-mobile.png'),Buffer.from(designMobile.data,'base64'));
  for (const size of [{width:320,height:720},{width:1440,height:600},{width:760,height:700},{width:320,height:400}]) {
    await send('Emulation.setDeviceMetricsOverride',{...size,deviceScaleFactor:1,mobile:size.width<761});
    await sleep(100);
    assert(await evaluate('document.documentElement.scrollWidth <= innerWidth'),'responsive workbench has no horizontal page overflow');
    assert(await evaluate('(()=>{const w=document.getElementById("workspace");return w.scrollHeight<=w.clientHeight+1||["auto","scroll"].includes(getComputedStyle(w).overflowY)})()'),'short viewport overflow stays reachable by scrolling');
    assert(await evaluate('document.getElementById("editor-surface").getBoundingClientRect().height >= 60'),'short window still shows editable code');
    await evaluate('document.querySelector(".output-toolbar").scrollIntoView({block:"end"})');
    assert(await evaluate('document.querySelector(".output-toolbar").getBoundingClientRect().bottom <= innerHeight'),'output controls stay visible');
    for (const id of ['run-code','save-file','select-folder','interpreter','close-app']) {
      assert(await evaluate(`(()=>{const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.height>0})()`),`responsive control visible: ${id} at ${size.width}`);
    }
  }
  await fill('answer = input("请输入：")\nprint(answer)');
  await key('Enter','Enter',13,2);
  await wait('!document.getElementById("input-form").hidden','input in a short mobile window');
  assert(await evaluate('(()=>{const w=document.getElementById("workspace");return w.scrollHeight<=w.clientHeight+1||["auto","scroll"].includes(getComputedStyle(w).overflowY)})()'),'short mobile input can be reached by scrolling');
  await evaluate('document.getElementById("input-form").scrollIntoView({block:"end"})');
  assert(await evaluate('(()=>{const r=document.getElementById("program-input").getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()'),'program input remains visible in a 320x400 window');
  await evaluate('document.getElementById("program-input").value="OK";document.getElementById("input-form").requestSubmit()');
  await wait(`${ready} && ${inline}.includes('OK')`,'submit short-window input');
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:1,mobile:false});
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await evaluate('document.getElementById("select-folder").focus()');
  await key('Tab','Tab',9);
  assert(await evaluate('getComputedStyle(document.activeElement).outlineStyle === "solid"'),'keyboard navigation has visible focus');
  await send('Network.enable');
  await send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
  await evaluate('editor.focus();editor.setSelectionRange(editor.value.length,editor.value.length);editor.insertText("\\n# offline edit")');
  assert(await evaluate('editor.value.endsWith("# offline edit") && Boolean(document.querySelector(".tok-comment"))'),'loaded editor can edit and highlight without a network');
  await send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
  assert(await evaluate('performance.getEntriesByType("resource").every(entry=>entry.name.startsWith(location.origin))'),'all workbench resources come from the local server');
  assert.deepEqual(browserErrors,[],'no uncaught browser exceptions during edits or visual block refresh');
  if (process.env.EDITOR_TEST_RUNNING) {
    // Page.close runs the real unload sequence; killing Chrome can skip pagehide.
    await evaluate('baseline = editor.value');
    await send('Page.close');
    const endpoint = new URL('/api/state', url);
    const token = new URLSearchParams(new URL(url).hash.slice(1)).get('token');
    let stopped = false;
    for (let i = 0; i < 100; i++) {
      try { await fetch(endpoint, {headers:{'X-Editor-Token':token}}); }
      catch { stopped = true; break; }
      await sleep(100);
    }
    assert(stopped, 'closing the last browser page releases the editor backend');
    console.log('PASS: closing the actual last browser page automatically stops the backend');
  }
  console.log('PASS: paired colored code/output cards, silent results, modified state, refresh, run-all, clear and draft');
  console.log('PASS: Python colors, compact desktop, actual result previews, 320/390px and short windows, keyboard focus, reduced motion, offline assets');
  console.log('PASS: Chrome incremental boundaries, dirty block replay, variable retention, error stop/retry, refresh/input recovery, run-all, reset, named files, pure-source save and layout');
} finally {
  if(socket) socket.close();
  chrome?.kill();
}
