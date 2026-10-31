import {EditorState, EditorSelection, StateField, StateEffect, Compartment} from "@codemirror/state";
import {EditorView, Decoration, WidgetType, keymap, lineNumbers, placeholder, drawSelection, highlightActiveLine, highlightActiveLineGutter} from "@codemirror/view";
import {history, historyKeymap, defaultKeymap, invertedEffects, insertNewlineAndIndent} from "@codemirror/commands";
import {pythonLanguage} from "@codemirror/lang-python";
import {syntaxHighlighting, bracketMatching, indentUnit, indentService, ensureSyntaxTree} from "@codemirror/language";
import {classHighlighter} from "@lezer/highlight";
import {ExecutionHistory} from "./execution-history.mjs";
import {layoutBlocks} from "./block-layout.mjs";

const outputEffect = StateEffect.define();
const clearEffect = StateEffect.define();
const executionEffect = StateEffect.define();
const blockEffect = StateEffect.define();
const statusLabels = {running: "运行中", more: "等待后续代码", input: "等待输入", exited: "执行已结束", idle: "已完成"};
const blockLabels = {executed: "已运行", modified: "需重跑", running: "运行中", draft: "待运行", failed: "运行出错"};

class BlockHeader extends WidgetType {
  constructor(block) { super(); this.block = block; }
  eq(other) { return this.block.id === other.block.id && this.block.number === other.block.number && this.block.tone === other.block.tone && this.block.status === other.block.status; }
  toDOM() {
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block-header-wrap';
    const header = document.createElement('div');
    header.className = `code-block-header block-tone-${this.block.tone}${this.block.status === 'draft' ? ' block-draft' : ''}`;
    header.dataset.codeBlockId = this.block.id;
    header.dataset.blockNumber = this.block.number;
    const title = document.createElement('span'), status = document.createElement('span');
    title.textContent = `代码块 ${this.block.number}`;
    status.className = 'code-block-status';
    status.textContent = blockLabels[this.block.status];
    header.append(title, status);
    wrapper.append(header);
    return wrapper;
  }
  ignoreEvent() { return true; }
}

class ResultWidget extends WidgetType {
  constructor(entry) { super(); this.entry = entry; }
  eq(other) { return this.entry.id === other.entry.id && this.entry.text === other.entry.text && this.entry.status === other.entry.status && this.entry.error === other.entry.error && this.entry.failed === other.entry.failed && this.entry.number === other.entry.number && this.entry.tone === other.entry.tone && this.entry.selection === other.entry.selection; }
  toDOM() {
    const wrapper = document.createElement('div');
    wrapper.className = 'inline-output-wrap';
    const box = document.createElement("div");
    box.className = `inline-output block-tone-${this.entry.tone}${this.entry.error ? " inline-error" : ""}`;
    box.dataset.runId = this.entry.id;
    if (this.entry.number) box.dataset.blockNumber = this.entry.number;
    const label = document.createElement("div");
    label.className = "inline-output-label";
    const title = document.createElement('span'), status = document.createElement('span');
    title.textContent = this.entry.selection ? '选区输出' : `输出${this.entry.number ? ` ${this.entry.number}` : ''}`;
    status.className = 'result-status';
    status.textContent = this.entry.failed ? '运行出错' : statusLabels[this.entry.status] || '结果';
    label.append(title, status);
    const output = document.createElement("pre");
    output.className = "inline-output-text";
    output.textContent = this.entry.text || (this.entry.failed ? '本块运行未完成' : this.entry.status === 'idle' ? '本块没有输出' : '等待输出…');
    if (!this.entry.text) output.classList.add('output-placeholder');
    box.append(label, output);
    wrapper.append(box);
    return wrapper;
  }
  ignoreEvent() { return true; }
}

const results = StateField.define({
  create: () => [],
  update(entries, transaction) {
    if (transaction.docChanged) {
      entries = entries.flatMap(entry => {
        let changed = false;
        transaction.changes.iterChanges((from, to, _fromNew, _toNew, inserted) => {
          const boundaryNewline = from === to && (from === entry.to && inserted.toString().startsWith("\n") || from === entry.from && /^\n+$/.test(inserted.toString()));
          if (!boundaryNewline && (from < entry.to && to > entry.from || from === to && from >= entry.from && from <= entry.to)) changed = true;
        });
        return changed ? [] : [{...entry, from: transaction.changes.mapPos(entry.from, 1), to: transaction.changes.mapPos(entry.to, -1), at: transaction.changes.mapPos(entry.at, -1)}];
      });
    }
    for (const effect of transaction.effects) {
      if (effect.is(clearEffect)) entries = [];
      if (effect.is(outputEffect)) {
        const value = effect.value;
        entries = entries.filter(entry => entry.id !== value.id && (!value.replace || entry.to <= value.from || entry.from >= value.to));
        entries = [...entries, value].slice(-100);
      }
    }
    return entries;
  },
});

const visualBlocks = StateField.define({
  create: () => [],
  update(blocks, transaction) {
    if (transaction.docChanged) blocks = blocks.map(block => ({...block, from: transaction.changes.mapPos(block.from, -1), to: transaction.changes.mapPos(block.to, 1)}));
    for (const effect of transaction.effects) if (effect.is(blockEffect)) blocks = effect.value;
    return blocks;
  },
  provide: field => EditorView.decorations.compute([field, results], state => {
    const blocks = state.field(field), decorations = [], usedLines = new Set();
    for (const block of blocks) {
      if (block.to <= block.from) continue;
      const first = state.doc.lineAt(block.from), last = state.doc.lineAt(block.to);
      decorations.push(Decoration.widget({widget: new BlockHeader(block), block: true, side: -1}).range(first.from));
      for (let number = first.number; number <= last.number; number++) {
        const line = state.doc.line(number);
        if (usedLines.has(number)) continue;
        usedLines.add(number);
        const classes = `cm-code-block block-tone-${block.tone}${number === last.number ? ' code-block-end' : ''}${block.status === 'draft' ? ' block-draft' : ''}`;
        decorations.push(Decoration.line({attributes: {class: classes, 'data-code-block-id': block.id, 'data-block-number': String(block.number)}}).range(line.from));
      }
    }
    for (const entry of state.field(results)) {
      const block = blocks.find(block => block.id === entry.id) || blocks.find(block => entry.from >= block.from && entry.to <= block.to);
      decorations.push(Decoration.widget({widget: new ResultWidget({...entry, number: block?.number, tone: block?.tone ?? 0}), block: true, side: 1}).range(entry.at));
    }
    return Decoration.set(decorations, true);
  }),
});

class CodeEditor {
  constructor(parent) {
    this.execution = new ExecutionHistory();
    this.dom = parent;
    this.editable = new Compartment();
    const insert = text => { this.insertText(text); return true; };
    this.extensions = [
      this.editable.of([EditorState.readOnly.of(true), EditorView.editable.of(false)]),
      results, visualBlocks, lineNumbers(), drawSelection(), history(),
      pythonLanguage, syntaxHighlighting(classHighlighter), bracketMatching(), highlightActiveLine(), highlightActiveLineGutter(),
      invertedEffects.of(transaction => {
        if (!transaction.docChanged) return [];
        const guard = this.execution.deletionGuard(transaction.changes, transaction.startState.doc.toString());
        if (!guard.blocks.length && !guard.boundary && !transaction.effects.some(effect => effect.is(executionEffect))) return [];
        return [executionEffect.of({snapshot: this.execution.snapshot(), epoch: this.execution.epoch})];
      }),
      EditorView.contentAttributes.of({"aria-label": "Python 代码", spellcheck: "false"}),
      EditorView.cspNonce.of(document.querySelector('meta[name="editor-style-nonce"]').content),
      placeholder("选择工作文件夹后新建文件，或打开已有 .py 文件。\n\nCtrl + Enter 运行新增或修改的代码。"),
      EditorState.tabSize.of(4),
      indentUnit.of("    "),
      indentService.of((context, position) => {
        if (context.simulatedBreak !== position) return undefined;
        const line = context.state.doc.lineAt(position);
        const pairs = {"[": "]", "(": ")", "{": "}"};
        for (let node = ensureSyntaxTree(context.state, position, 50)?.resolveInner(position, -1); node; node = node.parent) {
          const open = node.firstChild, closing = pairs[open?.name];
          if (!closing || open.to > position) continue;
          if (node.lastChild.name === closing && node.lastChild.to <= position) continue;
          // Existing continuation rows keep their own alignment, even when manually spaced.
          if (open.from >= line.from || context.textAfterPos(position).trimStart().startsWith(closing)) return undefined;
          return context.lineIndent(position, -1);
        }
        return undefined;
      }),
      keymap.of([
        {key: "Mod-Enter", run: () => { this.dom.dispatchEvent(new Event("run-request")); return true; }},
        {key: "Mod-s", run: () => { this.dom.dispatchEvent(new CustomEvent("save-request", {detail: false})); return true; }},
        {key: "Mod-Shift-s", run: () => { this.dom.dispatchEvent(new CustomEvent("save-request", {detail: true})); return true; }},
        {key: "Tab", run: () => !this.readOnly && insert("    ")},
        {key: "Enter", run: insertNewlineAndIndent},
        ...historyKeymap, ...defaultKeymap,
      ]),
      EditorView.updateListener.of(update => {
        const executed = new Map(this.execution.blocks.map(block => [block.id, block]));
        if (update.docChanged) this.execution.change(update.changes, update.state.doc.toString());
        for (const transaction of update.transactions) for (const effect of transaction.effects) {
          if (effect.is(executionEffect) && effect.value.epoch === this.execution.epoch) {
            // Restore boundaries, while retaining the latest actual execution and pending run.
            const blocks = effect.value.snapshot.blocks.map(block => ({...block, source: executed.get(block.id)?.source ?? block.source, dirty: block.dirty || executed.get(block.id)?.dirty}));
            const restoredIds = new Set(blocks.map(block => block.id));
            blocks.push(...this.execution.blocks.filter(block => !restoredIds.has(block.id)));
            blocks.sort((left, right) => left.from - right.from || left.to - right.to);
            this.execution.restore({blocks, pending: this.execution.pending, failed: this.execution.failed}, update.state.doc.toString());
          }
        }
        if (update.docChanged) this.dom.dispatchEvent(new Event("input"));
        if (update.selectionSet) this.dom.dispatchEvent(new Event("select"));
      }),
      EditorView.theme({
        "&": {height: "100%", backgroundColor: "var(--editor)", color: "var(--text)"},
        ".cm-scroller": {fontFamily: "var(--code-font)", fontSize: "14px", lineHeight: "25px", overflow: "auto"},
        ".cm-content": {padding: "22px 0", caretColor: "var(--cursor)"},
        ".cm-line": {padding: "0 28px 0 20px"},
        ".cm-gutters": {background: "var(--editor)", border: "none", color: "var(--gutter)", paddingLeft: "16px", paddingRight: "10px"},
        ".cm-cursor": {borderLeft: "2px solid var(--cursor)", marginLeft: "-1px"},
        "&.cm-focused": {outline: "none"},
        "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {backgroundColor: "var(--selection)"},
        ".cm-activeLine": {backgroundColor: "var(--active-line)"},
        ".cm-activeLineGutter": {backgroundColor: "transparent", color: "var(--text)"},
        "&.cm-focused .cm-matchingBracket": {backgroundColor: "transparent", outline: "none", color: "inherit", textDecoration: "underline", textDecorationColor: "var(--accent)", textDecorationThickness: "1px", textUnderlineOffset: "3px"},
        ".cm-placeholder": {color: "var(--muted)"},
      }, {dark: true}),
    ];
    this.view = new EditorView({parent, state: EditorState.create({extensions: this.extensions}), dispatchTransactions: transactions => {
      // Undo/redo use filter:false, so protect all document changes at dispatch.
      const start = transactions[0].startState;
      let changes = start.changes();
      for (const transaction of transactions) changes = changes.compose(transaction.changes);
      if (!changes.empty) {
        const guard = this.execution.deletionGuard(changes, start.doc.toString());
        const deletingAtCursor = start.selection.ranges.every(range => range.empty) && transactions.some(transaction => transaction.isUserEvent('delete.backward') || transaction.isUserEvent('delete.forward'));
        if (guard.boundary && deletingAtCursor) {
          this.dom.dispatchEvent(new CustomEvent('protected-boundary'));
          return;
        }
        if (guard.blocks.length && !window.confirm(`将删除或覆盖 ${guard.blocks.length} 个已运行代码块。\n删除代码不会撤销已生成的变量；需要清除变量时请重置会话。\n是否继续？`)) return;
      }
      this.view.update(transactions);
    }});
  }
  get value() { return this.view.state.doc.toString(); }
  set value(text) {
    this.execution.reset();
    this.blockSignature = null;
    // A different document gets a fresh undo history and no previous results.
    this.view.setState(EditorState.create({doc: text, extensions: this.extensions}));
    this.dom.dispatchEvent(new Event("input"));
  }
  get selectionStart() { return this.view.state.selection.main.from; }
  get selectionEnd() { return this.view.state.selection.main.to; }
  get readOnly() { return this.view.state.readOnly; }
  set readOnly(value) {
    if (this.readOnly !== value) this.view.dispatch({effects: this.editable.reconfigure([EditorState.readOnly.of(value), EditorView.editable.of(!value)])});
  }
  get scrollTop() { return this.view.scrollDOM.scrollTop; }
  focus() { this.view.focus(); }
  setSelectionRange(from, to) { this.view.dispatch({selection: EditorSelection.single(from, to), effects: EditorView.scrollIntoView(to, {y: "nearest"})}); }
  insertText(text) { this.view.dispatch({...this.view.state.replaceSelection(text), userEvent: "input.type"}); }
  refreshBlocks() {
    if (this.blockFrame) return;
    this.blockFrame = requestAnimationFrame(() => {
      this.blockFrame = null;
      const blocks = layoutBlocks(this.value, this.execution.snapshot(), this.view.state.field(results));
      const signature = JSON.stringify(blocks);
      if (signature !== this.blockSignature) {
        this.blockSignature = signature;
        this.view.dispatch({effects: blockEffect.of(blocks)});
      }
    });
  }
  currentExecutedBlock() {
    const position = this.view.state.selection.main.head;
    return this.execution.blocks.find(block => position >= block.from && position <= block.to && this.value.slice(block.from, block.to).trim()) || null;
  }
  deleteExecutedBlock() {
    const block = this.currentExecutedBlock();
    if (!block || this.readOnly) return;
    this.view.dispatch({changes: {from: block.from, to: block.to, insert: ''}, selection: {anchor: block.from}, userEvent: 'delete.block'});
    this.focus();
  }
  addEventListener(type, listener) { (type === "scroll" ? this.view.scrollDOM : this.dom).addEventListener(type, listener); }
  startResult(id, from, to, selection = false) {
    const previous = this.view.state.field(results).find(entry => entry.id === id);
    from = previous ? Math.min(previous.from, from) : from;
    to = previous ? Math.max(previous.to, to) : to;
    const at = this.view.state.doc.lineAt(to).to;
    this.view.dispatch({effects: outputEffect.of({id, from, to, at, text: "", status: "running", error: false, failed: false, replace: true, selection})});
    this.refreshBlocks();
  }
  updateResult(id, text, status, error) {
    const entry = this.view.state.field(results).find(item => item.id === id);
    if (!entry) return;
    this.view.dispatch({effects: outputEffect.of({...entry, text: (entry.text + text).slice(-64000), status: status ?? entry.status, error: entry.error || error, replace: false})});
  }
  finishResult(id, success) {
    const entry = this.view.state.field(results).find(item => item.id === id);
    if (entry) this.view.dispatch({effects: outputEffect.of({...entry, failed: !success, error: entry.error || !success, replace: false})});
    this.refreshBlocks();
  }
  clearResults() { this.view.dispatch({effects: clearEffect.of(null)}); }
  resultSnapshots() {
    let remaining = 256000;
    return [...this.view.state.field(results)].reverse().flatMap(entry => {
      if (remaining <= 0) return [];
      const text = entry.text.slice(-Math.min(64000, remaining));
      remaining -= text.length;
      return [{...entry, text}];
    }).reverse();
  }
  restoreResults(entries) {
    if (!Array.isArray(entries)) return;
    const valid = entries.slice(-100).filter(entry => typeof entry.id === "string" && typeof entry.text === "string" && Number.isInteger(entry.from) && Number.isInteger(entry.to) && entry.from >= 0 && entry.to >= entry.from && entry.to <= this.value.length);
    this.view.dispatch({effects: valid.map(entry => outputEffect.of({...entry, text: entry.text.slice(-64000), at: this.view.state.doc.lineAt(entry.to).to, replace: false}))});
  }
}

globalThis.CodeEditor = CodeEditor;
