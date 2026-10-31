"use strict";
const $ = id => document.getElementById(id);
const editor = new CodeEditor($("editor"));
const fragment = new URLSearchParams(location.hash.slice(1));
const tokenKey = `editor-token-${location.port}`;
const token = fragment.get("token") || sessionStorage.getItem(tokenKey) || "";
if (token) sessionStorage.setItem(tokenKey, token);
history.replaceState(null, "", location.pathname);
const draftKey = `editor-draft-${location.port}`;
let state = null, cursor = 0, busy = false, closing = false, disconnected = false;
let baseline = "", outputLength = 0, toastTimer, inputGeneration = null;
let documentReady = false;
let discoveredInterpreters = [], scanningInterpreters = false;
const OUTPUT_LIMIT = 500000;
const runWidgets = new Map();
const ignoredRuns = new Set();
const inlineBatch = new Map();
let pendingBlockWidget = null;
let restoredInlineCursor = 0, bottomRunId = null;
let executionQueue = [], pendingExecution = null, executionSnapshot = null, executionActive = false, knownGeneration = null;
let executionEpoch = 0;
const clientId = crypto.randomUUID();
let clientRevision = 0;

function reportPage(active) {
  return fetch("/api/client", {
    method: "POST", keepalive: true,
    headers: {"X-Editor-Token": token, "Content-Type": "application/json"},
    body: JSON.stringify({id: clientId, active, revision: ++clientRevision}),
  });
}

function toast(message, error = false) {
  $("toast").textContent = message;
  $("toast").classList.toggle("error", error);
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, error ? 7000 : 3000);
}

async function api(route, data) {
  const response = await fetch(route, {
    method: data === undefined ? "GET" : "POST",
    headers: {"X-Editor-Token": token, "Content-Type": "application/json"},
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "操作失败");
  return result;
}

function remember() {
  try { sessionStorage.setItem(draftKey, JSON.stringify({text: editor.value, baseline, path: state?.path || null, document_id: state?.document_id, ready: documentReady, results: editor.resultSnapshots(), runs: [...runWidgets], inlineCursor: cursor, pendingBlockWidget, execution: editor.execution.snapshot(), generation: knownGeneration, pendingExecution, executionQueue, executionSnapshot, executionActive})); }
  catch { /* Large drafts still remain in the editor; normal save continues working. */ }
}

function updateEditor() {
  const prefix = editor.value.slice(0, editor.selectionStart).split("\n");
  $("cursor-position").textContent = `行 ${prefix.length}，列 ${prefix.at(-1).length + 1}`;
  const dirty = editor.value !== baseline;
  $("dirty-dot").hidden = !dirty;
  document.title = `${dirty ? "● " : ""}${state?.path?.split(/[\\/]/).at(-1) || "未命名.py"} · 轻量`;
  if (state) renderControls();
}

function renderControls() {
  editor.refreshBlocks();
  const status = state.session.status;
  const active = ["running", "input", "starting"].includes(status);
  const runnable = ["idle", "more"].includes(status) && !busy && !disconnected && documentReady && !executionActive;
  $("run-code").disabled = !runnable;
  $("run-all").disabled = !runnable || status === "more";
  $("run-selection").hidden = editor.selectionStart === editor.selectionEnd;
  $("run-selection").disabled = !runnable;
  $("delete-block").hidden = !editor.currentExecutedBlock();
  $("delete-block").disabled = !documentReady || busy || disconnected || active || executionActive;
  $("cancel-buffer").hidden = status !== "more";
  $("cancel-buffer").disabled = busy;
  $("stop-code").disabled = !(active || executionActive) || busy || disconnected;
  $("reset-session").disabled = busy || disconnected;
  for (const id of ["select-folder", "new-file", "open-file", "rename-file", "save-file", "save-as", "add-interpreter", "dialog-add-interpreter", "interpreter", "close-app"])
    $(id).disabled = busy || disconnected;
  $("new-file").disabled ||= !state.folder;
  $("new-file").title = state.folder ? `在 ${state.folder} 中新建文件` : "请先选择工作文件夹";
  $("workspace-folder").textContent = state.folder ? state.folder.split(/[\\/]/).filter(Boolean).at(-1) : "未选择工作文件夹";
  $("workspace-folder").title = state.folder || "";
  $("select-folder").textContent = state.folder ? "更换文件夹" : "选择文件夹";
  editor.readOnly = !documentReady;
  for (const id of ["save-file", "save-as"]) $(id).disabled ||= !documentReady;
  $("rename-file").disabled ||= !documentReady || !state.path || active;
  for (const id of ["new-file", "open-file", "rename-file", "select-folder", "save-as", "interpreter", "add-interpreter", "dialog-add-interpreter"]) $(id).disabled ||= executionActive;
  $("input-form").hidden = status !== "input";
  $("program-input").disabled = busy;
  if (status === "input" && inputGeneration !== `${state.session.generation}:${cursor}`) {
    setOutputVisible(true);
    if (document.activeElement !== $("program-input")) $("program-input").focus();
    inputGeneration = `${state.session.generation}:${cursor}`;
  }
  const labels = {idle: "就绪", more: "等待后续代码", running: "运行中", input: "等待输入", exited: "解释器已退出", starting: "启动中"};
  $("status").dataset.state = disconnected ? "exited" : status;
  $("status").replaceChildren(Object.assign(document.createElement("i"), {}), document.createTextNode(disconnected ? "连接已断开" : labels[status] || status));
  $("session-note").textContent = status === "more" ? "代码块尚未完成 · 运行空行结束，或取消待续代码" : status === "exited" ? "点击“重置会话”重新启动解释器" : "手动执行 · 变量保留";
  if (documentReady && status === "idle" && !executionActive) {
    const tasks = editor.execution.plan(editor.value);
    $("session-note").textContent = tasks.length ? `待运行 ${tasks.length} 块 · 第 ${editor.value.slice(0, tasks[0].from).split("\n").length}–${editor.value.slice(0, tasks.at(-1).to).split("\n").length} 行` : "没有新增或修改的代码 · 变量保留";
  }
}

function applyState(result) {
  if (!result.session) return;
  state = result;
  if (knownGeneration !== null && knownGeneration !== state.session.generation) {
    cancelExecution(); editor.execution.reset(); clearInline();
  }
  knownGeneration = state.session.generation;
  $("filename").textContent = state.path?.split(/[\\/]/).at(-1) || "未命名.py";
  $("filename").title = state.path || "未命名文件";
  $("file-path").textContent = state.path || (state.folder ? `尚未保存 · 默认文件夹：${state.folder}` : "尚未打开文件");
  $("file-path").title = state.path || "";
  $("encoding").textContent = state.encoding.toUpperCase();
  const select = $("interpreter");
  select.replaceChildren();
  for (const item of state.interpreters) {
    const option = document.createElement("option");
    option.value = item.path;
    const parts = item.path.split(/[\\/]/);
    const environment = parts.at(-2) === "Scripts" ? parts.at(-3) : parts.at(-2);
    option.textContent = `${item.label}${environment ? ` (${environment})` : ""}`;
    option.title = item.path;
    select.append(option);
  }
  select.value = state.selected;
  select.title = state.selected;
  updateEditor();
  renderInterpreterList();
  renderDiscoveredInterpreters();
}

async function action(work) {
  if (busy || disconnected) return;
  busy = true;
  if (state) renderControls();
  try { return await work(); }
  catch (error) { toast(error.message, true); }
  finally { busy = false; if (state) renderControls(); }
}

async function save(saveAs = false) {
  if (!documentReady) throw new Error("请先打开或新建文件，再进行保存。当前页面与后台文档不一致。");
  const text = editor.value;
  const result = await api("/api/file/save", {text, save_as: saveAs, document_id: state.document_id});
  if (result.cancelled) return false;
  baseline = text;
  applyState(result);
  remember();
  toast("已保存到本地");
  return true;
}

async function protectChanges() {
  if (editor.value === baseline) return true;
  const dialog = $("confirm-dialog");
  const choice = await new Promise(resolve => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue || "cancel"), {once: true});
    dialog.returnValue = "cancel";
    dialog.showModal();
  });
  if (choice === "save") return save();
  return choice === "discard";
}

async function changeFile(kind) {
  if (kind === "new" && !state.folder) throw new Error("请先选择工作文件夹，再新建文件");
  if (!await protectChanges()) return;
  const result = kind === "new" ? await nameFile("new") : await api(`/api/file/${kind}`, {});
  if (!result || result.cancelled) return;
  editor.value = result.text;
  baseline = result.text;
  documentReady = true;
  clearInline(); clearBottom();
  applyState(result);
  remember();
  editor.focus();
}

function nameFile(kind) {
  const dialog = $("name-dialog"), input = $("file-name-input");
  const rename = kind === "rename";
  $("name-title").textContent = rename ? "修改文件名" : "新建 Python 文件";
  $("name-location").textContent = rename ? state.path : `创建位置：${state.folder}`;
  $("submit-name").textContent = rename ? "重命名" : "创建文件";
  $("name-error").hidden = true;
  input.value = rename ? state.path.split(/[\\/]/).at(-1) : "";
  return new Promise(resolve => {
    let submitting = false, completed = null;
    dialog.oncancel = event => { if (submitting) event.preventDefault(); };
    dialog.onclose = () => resolve(completed);
    $("cancel-name").onclick = () => dialog.close();
    $("name-form").onsubmit = async event => {
      event.preventDefault();
      if (submitting) return;
      submitting = true;
      $("submit-name").disabled = $("cancel-name").disabled = true;
      try {
        completed = await api(`/api/file/${kind}`, {name: input.value, document_id: state.document_id});
        dialog.close();
      } catch (error) {
        $("name-error").textContent = error.message;
        $("name-error").hidden = false;
      } finally {
        submitting = false;
        $("submit-name").disabled = $("cancel-name").disabled = false;
      }
    };
    dialog.showModal();
    input.focus();
    input.setSelectionRange(0, input.value.toLowerCase().endsWith(".py") ? input.value.length - 3 : input.value.length);
  });
}

function setOutputVisible(visible) {
  $("output-pane").hidden = $("divider").hidden = !visible;
  $("workspace").classList.toggle("output-hidden", !visible);
  $("show-output").hidden = visible;
}

function clearBottom() {
  $("output").replaceChildren(); delete $("output").dataset.label; outputLength = 0; $("output-empty").hidden = false;
}

function clearInline() {
  for (const run of runWidgets.keys()) ignoredRuns.add(run);
  while (ignoredRuns.size > 500) ignoredRuns.delete(ignoredRuns.values().next().value);
  editor.clearResults(); runWidgets.clear(); inlineBatch.clear(); pendingBlockWidget = null; restoredInlineCursor = 0;
}

function cancelExecution() {
  executionEpoch += 1;
  executionQueue = []; pendingExecution = null; executionSnapshot = null; executionActive = false;
}

async function execute(all = false, selection = false) {
  if (!state || !documentReady || executionActive || !["idle", "more"].includes(state.session.status)) return;
  const text = editor.value;
  if (selection && editor.selectionStart === editor.selectionEnd) return;
  executionSnapshot = text;
  if (all || selection) {
    const from = all ? 0 : editor.selectionStart;
    const to = all ? text.replace(/[ \t\r\n]+$/, "").length : editor.selectionEnd;
    executionQueue = [{id: crypto.randomUUID(), from, to, source: text.slice(from, to), all, selection}];
  } else executionQueue = editor.execution.plan(text);
  if (!executionQueue.length) { toast("没有新增或修改的代码"); return; }
  executionActive = true;
  if (all) { setOutputVisible(true); clearBottom(); clearInline(); }
  try { await startNextBlock(); }
  catch (error) { editor.execution.fail(); cancelExecution(); throw error; }
}

async function startNextBlock() {
  if (!executionQueue.length) { executionActive = false; remember(); renderControls(); return; }
  if (editor.value !== executionSnapshot) {
    cancelExecution(); toast("代码在运行期间发生修改，点击运行后将重新计算待运行范围"); return;
  }
  const task = executionQueue.shift();
  if (!task.selection) editor.execution.begin(task);
  if (!task.source.trim() && !task.all) {
    if (!task.selection) editor.execution.commit(editor.value);
    return startNextBlock();
  }
  const runId = crypto.randomUUID();
  const epoch = executionEpoch;
  const generation = state.session.generation;
  pendingExecution = {run_id: runId, task, generation: state.session.generation};
  if (!task.all) {
    runWidgets.set(runId, task.id);
    while (runWidgets.size > 200) runWidgets.delete(runWidgets.keys().next().value);
    const leading = task.source.match(/^(?:[ \t]*\n)*/)[0].length;
    const end = Math.max(task.from + leading, task.to > task.from && editor.value[task.to - 1] === "\n" ? task.to - 1 : task.to);
    editor.startResult(task.id, task.from + leading, end, Boolean(task.selection));
  } else bottomRunId = runId;
  remember();
  const startLine = executionSnapshot.slice(0, task.from).split("\n").length;
  try {
    const result = await api("/api/execute", {source: task.source, mode: task.all ? "all" : task.selection ? "selection" : "incremental", run_id: runId, start_line: startLine, expected_generation: generation});
    if (epoch !== executionEpoch) return;
    applyState(result);
  } catch (error) {
    if (epoch !== executionEpoch) return;
    if (!task.all) editor.updateResult(task.id, error.message, "exited", true);
    throw error;
  }
}

async function finishExecution(session) {
  if (!pendingExecution) return;
  const result = session.last_result;
  const exited = session.status === "exited" && session.run_id === pendingExecution.run_id;
  if ((!result || result.run_id !== pendingExecution.run_id) && !exited) return;
  const finished = pendingExecution;
  pendingExecution = null;
  const success = !exited && result.success;
  if (!finished.task.all) editor.finishResult(finished.task.id, success);
  if (!finished.task.selection) {
    if (success) editor.execution.commit(editor.value);
    else editor.execution.fail();
  }
  if (!success) {
    cancelExecution(); toast("本块执行失败，后续块已暂停；修正后会重跑本块", true);
  } else if (editor.value !== executionSnapshot) {
    cancelExecution(); toast("本次执行完成；运行期间的新修改留待下次运行");
  } else {
    try { await startNextBlock(); }
    catch (error) { editor.execution.fail(); cancelExecution(); toast(error.message, true); }
  }
  remember(); renderControls();
}

function appendEvent(event) {
  if (ignoredRuns.has(event.run_id)) return;
  if (event.mode !== "all" && runWidgets.has(event.run_id)) {
    if (event.id <= restoredInlineCursor) return;
    const widget = runWidgets.get(event.run_id);
    const pending = inlineBatch.get(widget) || {text: "", status: null, error: false};
    if (["stdout", "stderr", "stdin"].includes(event.type)) {
      pending.text = (pending.text + (event.text || "")).slice(-64000);
      pending.error ||= event.type === "stderr";
    }
    if (event.type === "state") {
      pending.status = event.status;
      if (event.status === "more") pendingBlockWidget = widget;
      else if (["idle", "exited"].includes(event.status) && pendingBlockWidget === widget) pendingBlockWidget = null;
    }
    inlineBatch.set(widget, pending);
    return;
  }
  if (event.mode === "all") {
    if (bottomRunId && event.run_id !== bottomRunId) return;
    bottomRunId = event.run_id;
  }
  if (event.type === "state" || !event.text) return;
  // Initial startup notices should not displace the empty-state instructions.
  if (cursor === 0 && event.type === "notice") return;
  const pre = $("output"), scroller = $("output-scroll");
  pre.dataset.label = event.mode === "all" ? "输出 1（运行全部）" : "会话消息";
  if (event.mode === 'all' && ['stdout', 'stderr', 'stdin'].includes(event.type)) {
    const empty = pre.querySelector('.event-empty');
    if (empty) { outputLength -= empty.textContent.length; empty.remove(); }
  }
  const stick = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 60;
  const last = pre.lastElementChild;
  if (last && last.className === `event-${event.type}` && last.textContent.length < 8192) {
    last.append(document.createTextNode(event.text));
  } else {
    const span = document.createElement("span");
    span.className = `event-${event.type}`;
    span.textContent = event.text;
    pre.append(span);
  }
  outputLength += event.text.length;
  while (pre.firstChild && (outputLength > OUTPUT_LIMIT || pre.childNodes.length > 2000)) {
    outputLength -= pre.firstChild.textContent.length;
    pre.firstChild.remove();
  }
  $("output-empty").hidden = pre.childNodes.length > 0;
  if (stick) scroller.scrollTop = scroller.scrollHeight;
}

function finishBottomOutput(session) {
  const result = session.last_result;
  if (!bottomRunId || result?.run_id !== bottomRunId || !['idle', 'exited'].includes(session.status)) return;
  if (!$('output').querySelector('.event-stdout, .event-stderr, .event-stdin, .event-empty')) {
    appendEvent({type: 'empty', mode: 'all', run_id: bottomRunId, text: result.success ? '本块没有输出\n' : '本次运行失败，未收到输出。\n'});
  }
}

async function poll() {
  if (closing) return;
  const requestedDocument = state?.document_id;
  try {
    const result = await api(`/api/events?after=${cursor}`);
    if (disconnected) { disconnected = false; applyState(await api("/api/state")); }
    if (result.truncated) appendEvent({type: "notice", text: "较早的输出已截断。\n"});
    for (const event of result.events) if (event.id > cursor && (!state || event.generation >= state.session.generation)) appendEvent(event);
    for (const [widget, result] of inlineBatch) editor.updateResult(widget, result.text, result.status, result.error);
    inlineBatch.clear();
    cursor = Math.max(cursor, result.cursor);
    if (documentReady && state && state.document_id === requestedDocument && result.document_id !== state.document_id) {
      documentReady = false;
      toast("文件已在另一个页面切换。为避免误保存，请重新打开目标文件。当前代码仍保留。", true);
    }
    if (state && state.document_id === requestedDocument) {
      if (knownGeneration !== result.state.generation) {
        cancelExecution(); editor.execution.reset(); clearInline(); knownGeneration = result.state.generation;
      }
      state.session = result.state; state.folder = result.folder;
      await finishExecution(result.state);
      finishBottomOutput(result.state);
      renderControls();
    }
    if (result.events.length) remember();
  } catch {
    if (!disconnected) toast("与本地后台的连接已断开。代码仍保留在页面中。", true);
    disconnected = true;
    if (state) renderControls();
  }
  if (!closing) setTimeout(poll, disconnected ? 1500 : 200);
}

async function selectInterpreter(path) {
  if (path === state.selected) return;
  if (!confirm("切换解释器会停止当前程序，并清除会话中的变量。代码会保留。继续切换？")) {
    $("interpreter").value = state.selected;
    return;
  }
  try { applyState(await api("/api/interpreters/select", {path})); }
  finally { $("interpreter").value = state.selected; }
}

async function addInterpreter(path = null) {
  const result = await api("/api/interpreters/add", path ? {path} : {});
  if (result.cancelled) return;
  applyState(result);
  toast("解释器已添加，可在运行环境中选择");
  if (path) await selectInterpreter(result.added);
}

function renderDiscoveredInterpreters() {
  const list = $("discovered-list");
  list.replaceChildren();
  for (const item of discoveredInterpreters) {
    const entry = document.createElement("div");
    entry.className = "interpreter-entry";
    const row = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = item.label;
    const source = document.createElement("span");
    source.className = "environment-source";
    source.textContent = item.source;
    title.append(source);
    row.append(title);
    const added = state.interpreters.some(known => known.path.toLowerCase() === item.path.toLowerCase());
    const button = document.createElement("button");
    button.textContent = added ? "已添加" : "添加并使用";
    button.className = added ? "quiet-button" : "secondary-button";
    button.disabled = added;
    button.onclick = () => action(() => addInterpreter(item.path));
    row.append(button);
    const location = document.createElement("small");
    location.textContent = item.path;
    entry.append(row, location);
    list.append(entry);
  }
}

async function scanInterpreters() {
  if (scanningInterpreters) return;
  scanningInterpreters = true;
  $("rescan-interpreters").disabled = true;
  $("scan-status").textContent = "正在检测本机 Python、Conda 和项目虚拟环境…";
  try {
    const result = await api("/api/interpreters/discover", {});
    discoveredInterpreters = result.interpreters;
    renderDiscoveredInterpreters();
    $("scan-status").textContent = discoveredInterpreters.length ? `找到 ${discoveredInterpreters.length} 个可用环境。请选择需要的 Python 解释器。` : "没有检测到其他可用环境，可以浏览文件手动添加。";
  } catch (error) {
    $("scan-status").textContent = `自动检测失败：${error.message}。你仍可以浏览文件手动添加。`;
  } finally {
    scanningInterpreters = false;
    $("rescan-interpreters").disabled = false;
  }
}

function openInterpreterPicker() {
  if (!state || busy || disconnected) return;
  renderInterpreterList();
  if (!$("interpreters-dialog").open) $("interpreters-dialog").showModal();
  scanInterpreters();
}

function renderInterpreterList() {
  const list = $("interpreter-list");
  list.replaceChildren();
  for (const item of state.interpreters) {
    const entry = document.createElement("div");
    entry.className = "interpreter-entry";
    const row = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = item.label;
    row.append(label);
    if (item.path === state.selected) {
      const active = document.createElement("span");
      active.className = "active-label";
      active.textContent = "当前使用";
      row.append(active);
    } else {
      const buttons = document.createElement("div");
      const use = document.createElement("button");
      use.textContent = "使用";
      use.onclick = () => action(() => selectInterpreter(item.path));
      const remove = document.createElement("button");
      remove.textContent = "移除";
      remove.onclick = () => action(async () => applyState(await api("/api/interpreters/remove", {path: item.path})));
      buttons.append(use, remove);
      row.append(buttons);
    }
    const path = document.createElement("small");
    path.textContent = item.path;
    entry.append(row, path);
    list.append(entry);
  }
}

$("new-file").onclick = () => action(() => changeFile("new"));
$("select-folder").onclick = () => action(async () => {
  const result = await api("/api/folder/select", {});
  if (!result.cancelled) { applyState(result); remember(); toast("工作文件夹已选定，可以新建文件"); }
});
$("open-file").onclick = () => action(() => changeFile("open"));
$("rename-file").onclick = () => action(async () => {
  const result = await nameFile("rename");
  if (result) { documentReady = true; applyState(result); remember(); toast("文件已重命名，未保存的修改仍保留在编辑区"); }
});
$("save-file").onclick = () => action(() => save());
$("save-as").onclick = () => action(() => save(true));
$("run-code").onclick = () => action(() => execute());
$("run-selection").onclick = () => action(() => execute(false, true));
$("run-all").onclick = () => action(() => execute(true));
$("delete-block").onclick = () => { if (!$("delete-block").disabled) editor.deleteExecutedBlock(); };
$("cancel-buffer").onclick = () => action(async () => applyState(await api("/api/cancel-buffer", {})));
$("close-output").onclick = () => { setOutputVisible(false); $("show-output").focus(); };
$("show-output").onclick = () => { setOutputVisible(true); $("output-scroll").focus(); };
$("clear-output").onclick = () => action(async () => {
  const result = await api("/api/clear", {});
  cursor = Math.max(cursor, result.cursor);
  clearBottom(); clearInline();
  remember();
});
$("reset-session").onclick = () => action(async () => {
  if (confirm("重置会话会停止当前程序并清除所有变量，代码会保留。继续？")) { cancelExecution(); applyState(await api("/api/reset", {})); }
});
$("stop-code").onclick = () => action(async () => { cancelExecution(); applyState(await api("/api/stop", {})); toast("程序已停止，会话变量已清除；下次从头运行"); });
$("input-form").onsubmit = event => {
  event.preventDefault();
  action(async () => {
    applyState(await api("/api/input", {text: $("program-input").value}));
    $("program-input").value = "";
  });
};
$("interpreter").onchange = event => action(() => selectInterpreter(event.target.value));
$("add-interpreter").onclick = openInterpreterPicker;
$("dialog-add-interpreter").onclick = () => action(() => addInterpreter());
$("manage-interpreters").onclick = openInterpreterPicker;
$("rescan-interpreters").onclick = scanInterpreters;
$("close-interpreters").onclick = () => $("interpreters-dialog").close();
$("close-app").onclick = () => action(async () => {
  if (!await protectChanges()) return;
  if (!confirm("关闭编辑器将结束当前会话并停止本地后台。继续？")) return;
  await api("/api/shutdown", {});
  closing = true;
  disconnected = true;
  sessionStorage.removeItem(draftKey);
  renderControls();
  $("status").textContent = "编辑器已关闭";
  toast("后台已关闭，可以关闭此标签页。");
});

editor.addEventListener("input", () => { updateEditor(); remember(); });
editor.addEventListener("protected-boundary", () => toast("已到达已运行块边界；如需删除整块，请使用“删除已运行块”。"));
for (const event of ["click", "keyup", "select"]) editor.addEventListener(event, updateEditor);
editor.addEventListener("run-request", () => { if (state && !$("run-code").disabled && !busy) action(() => execute()); });
editor.addEventListener("save-request", event => action(() => save(event.detail)));
document.addEventListener("keydown", event => {
  if (event.defaultPrevented || $("name-dialog").open) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault(); action(() => save(event.shiftKey));
  } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !$("confirm-dialog").open && !$("interpreters-dialog").open) {
    event.preventDefault(); if (!$("run-code").disabled) action(() => execute());
  }
});
window.addEventListener("beforeunload", event => {
  if (!closing && editor.value !== baseline) { event.preventDefault(); event.returnValue = ""; }
});
window.addEventListener("pagehide", () => { if (!closing) reportPage(false).catch(() => {}); });
window.addEventListener("pageshow", event => { if (event.persisted && !closing) reportPage(true).catch(() => {}); });

const divider = $("divider");
function resizeEditor(clientY) {
  const workspace = $("workspace").getBoundingClientRect();
  const height = Math.max(160, Math.min(clientY - workspace.top, workspace.height - 150));
  const percent = height / workspace.height * 100;
  document.documentElement.style.setProperty("--editor-height", `${percent}%`);
  localStorage.setItem("editor-height", percent);
}
divider.addEventListener("pointerdown", event => { divider.setPointerCapture(event.pointerId); document.body.style.userSelect = "none"; });
divider.addEventListener("pointermove", event => { if (divider.hasPointerCapture(event.pointerId)) resizeEditor(event.clientY); });
divider.addEventListener("pointerup", event => { divider.releasePointerCapture(event.pointerId); document.body.style.userSelect = ""; });
divider.addEventListener("keydown", event => {
  if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault(); resizeEditor(divider.getBoundingClientRect().top + (event.key === "ArrowUp" ? -20 : 20));
});

(async function start() {
  try {
    const registration = await reportPage(true);
    if (!registration.ok) throw new Error("无法登记编辑页面");
    const savedHeight = Number(localStorage.getItem("editor-height"));
    if (savedHeight >= 20 && savedHeight <= 80) document.documentElement.style.setProperty("--editor-height", `${savedHeight}%`);
    applyState(await api("/api/state"));
    const draft = JSON.parse(sessionStorage.getItem(draftKey) || "null");
    if (draft && draft.path === state.path && draft.document_id === state.document_id) {
      editor.value = draft.text; baseline = draft.baseline;
      documentReady = draft.ready !== false;
      if (Array.isArray(draft.runs)) for (const [run, widget] of draft.runs.slice(-200)) runWidgets.set(run, widget);
      editor.restoreResults(draft.results);
      restoredInlineCursor = Number(draft.inlineCursor) || 0;
      pendingBlockWidget = draft.pendingBlockWidget || null;
      if (draft.generation === knownGeneration) {
        editor.execution.restore(draft.execution, editor.value);
        pendingExecution = draft.pendingExecution || null;
        executionQueue = Array.isArray(draft.executionQueue) ? draft.executionQueue : [];
        executionSnapshot = draft.executionSnapshot ?? null;
        executionActive = Boolean(draft.executionActive && pendingExecution);
      }
    } else if (state.path) {
      // A second page must not silently overwrite the file owned by the first one.
      toast("此后台已有打开的文件，请回到原页面操作，或重新打开文件。", true);
    } else {
      documentReady = false;
      editor.value = "";
      baseline = editor.value;
    }
    updateEditor(); remember(); editor.focus(); poll();
  } catch (error) { disconnected = true; toast(`无法连接编辑器：${error.message}。请通过启动入口重新打开。`, true); }
})();
