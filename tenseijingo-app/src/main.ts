import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save, open } from "@tauri-apps/plugin-dialog";

// ===== Types =====
interface FileEntry {
  id: string;
  title: string;
  body: string;
  updated_at: string;
  char_count: number;
  custom_title: boolean;
}
interface GridCell { col: number; row: number; }
interface ColCfg { indent: number; tail: number; }
interface Unit { type: 'char'|'tcy'|'newline'; text: string; rawStart: number; rawLen: number; }
interface FlowResult {
  grid: (number|null)[][];
  unitPos: { col: number; row: number }[];
  nextCol: number; nextRow: number;
  neededCols: number;
  newlineMarkers: GridCell[];
}
interface GitLogEntry {
  commit_hash: string;
  message: string;
  timestamp: string;
  char_count: number;
}

// ===== Settings & Config =====
interface AppSettings {
  previewSpaceWidth: 'half' | 'full';
  kinsokuHead: string;
  kinsokuTail: string;
  kinsokuColorHex: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  previewSpaceWidth: 'half',
  kinsokuHead: '、。，．,．！？!?）)」』】〉》〕｝}：；:;ー～…‥・',
  kinsokuTail: '（(「『【〈《〔｛{▼▽△▲',
  kinsokuColorHex: '#d24646'
};

let appSettings: AppSettings = { ...DEFAULT_SETTINGS };

let kinsokuHeadSet = new Set(appSettings.kinsokuHead);
let kinsokuTailSet = new Set(appSettings.kinsokuTail);

function applySettings(settings: AppSettings) {
  kinsokuHeadSet = new Set(settings.kinsokuHead);
  kinsokuTailSet = new Set(settings.kinsokuTail);
  // Apply CSS variable for color with 13% opacity
  let hex = settings.kinsokuColorHex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c+c).join('');
  const r = parseInt(hex.substring(0, 2), 16) || 210;
  const g = parseInt(hex.substring(2, 4), 16) || 70;
  const b = parseInt(hex.substring(4, 6), 16) || 70;
  document.documentElement.style.setProperty('--kinsoku-bg', `rgba(${r}, ${g}, ${b}, 0.13)`);
}

function loadSettings() {
  try {
    const saved = localStorage.getItem('user_settings');
    if (saved) {
      const parsed = JSON.parse(saved);
      appSettings = { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch(e) {}
  applySettings(appSettings);
}
loadSettings();

// ===== Constants =====
const BASE_COLS = 35;
const ROWS = 18;

// Pre-compute column configs
const COL_CFG_CACHE: ColCfg[] = [];
const USABLE_START_CACHE: number[] = [];
const USABLE_END_CACHE: number[] = [];
function colConfig(c: number): ColCfg {
  if (c < COL_CFG_CACHE.length) return COL_CFG_CACHE[c];
  if (c >= BASE_COLS) return { indent: 0, tail: 0 };
  if (c === 0) return { indent: 5, tail: 0 };
  if (c >= 1 && c <= 5) return { indent: 4, tail: 0 };
  if (c >= 32) return { indent: 0, tail: 1 };
  return { indent: 0, tail: 0 };
}
// Pre-fill cache for base columns
for (let c = 0; c < BASE_COLS + 20; c++) {
  const cfg = colConfig(c);
  COL_CFG_CACHE[c] = cfg;
  USABLE_START_CACHE[c] = cfg.indent;
  USABLE_END_CACHE[c] = ROWS - cfg.tail;
}

function usableStart(c: number) { return c < USABLE_START_CACHE.length ? USABLE_START_CACHE[c] : 0; }
function usableEnd(c: number) { return c < USABLE_END_CACHE.length ? USABLE_END_CACHE[c] : ROWS; }
function ensureColCache(maxCol: number) {
  for (let c = COL_CFG_CACHE.length; c <= maxCol; c++) {
    const cfg = colConfig(c);
    COL_CFG_CACHE[c] = cfg;
    USABLE_START_CACHE[c] = cfg.indent;
    USABLE_END_CACHE[c] = ROWS - cfg.tail;
  }
}

let BASE_MAX = 0;
for (let c = 0; c < BASE_COLS; c++) BASE_MAX += USABLE_END_CACHE[c] - USABLE_START_CACHE[c];

// ===== App state =====
let currentFileId: string | null = null;
let currentTitle = '';
let currentCustomTitle = false;
let isDirty = false;

// ===== DOM refs =====
let fileManagerEl: HTMLElement;
let editorScreenEl: HTMLElement;
let fmListEl: HTMLElement;
let gridEl: HTMLElement;
let textarea: HTMLTextAreaElement;
let statusText: HTMLElement;
let editorTitleEl: HTMLElement;
let saveStatusEl: HTMLElement;
let fmFileInput: HTMLInputElement;

// ===== Editor state =====
let totalCols = BASE_COLS;
let cells: HTMLElement[][] = [];
let isComposing = false;
let compStart = -1;
let compSuffixLen = 0;
let autoSaveTimer: number | null = null;
let mouseIsDown = false;
let gridCursor: GridCell = { col: 0, row: 5 };
let anchorPos = 0;
let activePos = 0;

// ===== Render cache (for diff-based updates) =====
interface CellState { text: string; type: 'char'|'tcy'|'newline'|'empty'|'nl-mark'; flags: number; }
const FLAG_CURSOR   = 1;
const FLAG_COMPOSING = 2;
const FLAG_SELECTED = 4;
const FLAG_KINSOKU  = 8;
let prevCellStates: CellState[][] = [];
let renderRAF = 0;

// ===== Cached computation =====
let cachedText = '';
let cachedUnits: Unit[] = [];
let cachedFlow: FlowResult | null = null;

function invalidateCache() { cachedFlow = null; }

function getUnitsAndFlow(): { units: Unit[]; flow: FlowResult } {
  const text = textarea.value;
  if (cachedFlow && cachedText === text) return { units: cachedUnits, flow: cachedFlow };
  cachedText = text;
  cachedUnits = textToUnits(text);
  cachedFlow = flowToGrid(cachedUnits);
  return { units: cachedUnits, flow: cachedFlow };
}

// ===== Custom Dialogs =====
function showModal(message: string, withInput: boolean, defaultValue = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.getElementById('modal-overlay')!;
    const msgEl = document.getElementById('modal-message')!;
    const inputEl = document.getElementById('modal-input') as HTMLInputElement;
    const okBtn = document.getElementById('modal-ok')!;
    const cancelBtn = document.getElementById('modal-cancel')!;
    msgEl.textContent = message;
    inputEl.style.display = withInput ? 'block' : 'none';
    inputEl.value = defaultValue;
    overlay.style.display = 'flex';
    if (withInput) setTimeout(() => { inputEl.focus(); inputEl.select(); }, 50);
    function cleanup() {
      overlay.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      inputEl.removeEventListener('keydown', onKey);
      overlay.removeEventListener('click', onBg);
    }
    function onOk() { cleanup(); resolve(withInput ? inputEl.value : ''); }
    function onCancel() { cleanup(); resolve(null); }
    function onKey(e: KeyboardEvent) { if (e.key === 'Enter') onOk(); if (e.key === 'Escape') onCancel(); }
    function onBg(e: MouseEvent) { if (e.target === overlay) onCancel(); }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    inputEl.addEventListener('keydown', onKey);
    overlay.addEventListener('click', onBg);
  });
}
async function customPrompt(message: string, defaultValue = ''): Promise<string | null> {
  return showModal(message, true, defaultValue);
}
async function customConfirm(message: string): Promise<boolean> {
  return (await showModal(message, false)) !== null;
}

// ===== Notification =====
function showNotification(msg: string) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);'
    + 'background:rgba(30,30,30,0.85);color:#fff;padding:10px 24px;border-radius:8px;'
    + 'font-size:13px;font-family:"游ゴシック","Yu Gothic","メイリオ",Meiryo,sans-serif;'
    + 'z-index:3000;pointer-events:none;transition:opacity 0.3s;';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; }, 1200);
  setTimeout(() => { document.body.removeChild(el); }, 1600);
}

// ===== Preview Side Panel =====
let previewPanel: HTMLElement;
let previewTitleEl: HTMLElement;
let previewTextEl: HTMLTextAreaElement;
let previewCopyBtn: HTMLElement;
let previewVisible = false;
let previewDirty = false;

function getFormattedPreviewText(): string {
  const { units, flow } = getUnitsAndFlow();
  const { grid, unitPos } = flow;
  
  if (units.length === 0) return "";

  // 最後のユニットの位置から、出力すべき最大行（列）数を計算
  let maxCol = 0;
  for (let i = unitPos.length - 1; i >= 0; i--) {
    if (unitPos[i]) {
      maxCol = unitPos[i].col;
      // 最後が明示的な改行なら次の行（列）まで出力する
      if (units[i].type === 'newline') {
        maxCol++;
      }
      break;
    }
  }

  let lines: string[] = [];
  for (let c = 0; c <= maxCol; c++) {
    let lineStr = "";
    const start = usableStart(c);
    const end = usableEnd(c);

    for (let r = start; r < end; r++) {
      const ui = grid[c][r];
      if (ui !== null) {
        const u = units[ui];
        if (u.type !== 'newline') {
          lineStr += u.text;
        }
      }
    }
    lines.push(lineStr);
  }

  const chkSpace = document.getElementById('chk-preview-space') as HTMLInputElement;
  if (chkSpace && chkSpace.checked) {
    const sp = appSettings.previewSpaceWidth === 'full' ? '　' : ' ';
    const sp4 = sp + sp + sp + sp;
    const sp5 = sp4 + sp;
    for (let i = 0; i < lines.length; i++) {
      if (i === 0) {
        lines[i] = sp5 + lines[i];
      } else if (i >= 1 && i <= 5) {
        lines[i] = sp4 + lines[i];
      }
      // 後ろの3行 (基準35行換算で33〜35行目)
      if (i >= 32 && i <= 34) {
        lines[i] = lines[i] + sp;
      }
    }
  }

  return lines.join('\n');
}

function togglePreview(title: string) {
  if (previewVisible) { hidePreview(); return; }
  previewTitleEl.textContent = title;
  previewTextEl.value = getFormattedPreviewText();
  previewPanel.style.display = 'flex';
  previewVisible = true;
  previewDirty = false;
  recalcSize();
}
function markPreviewDirty() { previewDirty = true; }
function flushPreview() {
  if (!previewVisible || !previewDirty) return;
  previewDirty = false;
  const title = currentCustomTitle ? currentTitle : deriveTitle(textarea.value);
  previewTitleEl.textContent = title;
  previewTextEl.value = getFormattedPreviewText();
}
function hidePreview() {
  previewPanel.style.display = 'none';
  previewVisible = false;
  recalcSize();
}

// ===== Title helper =====
function deriveTitle(body: string): string {
  const nl = body.indexOf('\n');
  const firstLine = (nl >= 0 ? body.slice(0, nl) : body).trim();
  return firstLine ? firstLine.slice(0, 20) : '無題';
}

function updateTitleDisplay() {
  if (currentCustomTitle) {
    editorTitleEl.textContent = currentTitle;
  } else {
    editorTitleEl.textContent = deriveTitle(textarea.value);
  }
}

// ============================================================
//  FILE MANAGER
// ============================================================
function showFileManager() {
  fileManagerEl.style.display = 'flex';
  editorScreenEl.style.display = 'none';
  refreshFileList();
}

async function refreshFileList() {
  const files: FileEntry[] = await invoke('list_files');
  fmListEl.innerHTML = '';
  if (files.length === 0) {
    fmListEl.innerHTML = '<div class="fm-empty">原稿がありません。<br>「＋ 新規作成」で始めましょう。</div>';
    return;
  }
  for (const f of files) {
    const item = document.createElement('div');
    item.className = 'fm-item';
    const preview = f.body.replace(/\n/g, ' ').slice(0, 80) || '（空）';
    const d = new Date(f.updated_at);
    const dateStr = d.getFullYear() + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + String(d.getDate()).padStart(2,'0')
      + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
    item.innerHTML = `
      <div class="fm-item-info">
        <div class="fm-item-title">${escHtml(f.title)}</div>
        <div class="fm-item-meta">${dateStr}　${f.char_count} / ${BASE_MAX} 文字</div>
        <div class="fm-item-preview">${escHtml(preview)}</div>
      </div>
      <div class="fm-item-actions">
        <button class="act-preview">表示</button>
        <button class="act-export">書出</button>
        <button class="act-delete danger">削除</button>
      </div>`;
    item.querySelector('.fm-item-info')!.addEventListener('click', () => openFile(f.id));
    item.querySelector('.act-preview')!.addEventListener('click', (e) => { e.stopPropagation(); openFileWithPreview(f.id); });
    item.querySelector('.act-export')!.addEventListener('click', (e) => { e.stopPropagation(); exportFileFromList(f); });
    item.querySelector('.act-delete')!.addEventListener('click', (e) => { e.stopPropagation(); deleteFile(f.id, f.title); });
    fmListEl.appendChild(item);
  }
}

function escHtml(s: string) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function createNewFile() {
  const id: string = await invoke('create_file');
  openFile(id);
}

async function openFileWithPreview(id: string) {
  await openFile(id);
  const title = currentCustomTitle ? currentTitle : deriveTitle(textarea.value);
  togglePreview(title);
}

async function openFile(id: string) {
  const f: FileEntry = await invoke('read_file', { id });
  currentFileId = f.id;
  currentTitle = f.title;
  currentCustomTitle = f.custom_title;
  textarea.value = f.body;
  isDirty = false;
  invalidateCache();
  resetCursor();
  showEditor();
}

async function deleteFile(id: string, title: string) {
  if (!(await customConfirm(`「${title}」を削除しますか？`))) return;
  await invoke('delete_file', { id });
  showNotification('削除しました');
  refreshFileList();
}

async function exportFileFromList(f: FileEntry) {
  const path = await save({
    defaultPath: `${f.title}.txt`,
    filters: [{ name: 'テキストファイル', extensions: ['txt'] }],
  });
  if (!path) return;
  await invoke('export_file_to', { id: f.id, dest: path });
  showNotification('書き出しました');
}

async function importFile(file: File) {
  const text = await file.text();
  const id: string = await invoke('create_file');
  await invoke('save_file', { id, body: text });
  showNotification('読み込みました');
  refreshFileList();
}

// ============================================================
//  EDITOR SCREEN
// ============================================================
function showEditor() {
  fileManagerEl.style.display = 'none';
  editorScreenEl.style.display = 'flex';
  updateTitleDisplay();
  updateSaveStatus();
  buildGrid();
  recalcSize();
  render();
  textarea.focus();
}

async function saveCurrentFile() {
  if (!currentFileId) return;
  const entry: FileEntry = await invoke('save_file', { id: currentFileId, body: textarea.value });
  currentTitle = entry.title;
  currentCustomTitle = entry.custom_title;
  isDirty = false;
  updateTitleDisplay();
  updateSaveStatus();
  showNotification('保存しました');
}

async function renameCurrentFile() {
  if (!currentFileId) return;
  const newTitle = await customPrompt('新しいタイトル:', currentTitle);
  if (newTitle === null || newTitle === currentTitle) return;
  await invoke('rename_file', { id: currentFileId, title: newTitle });
  currentTitle = newTitle;
  currentCustomTitle = true;
  updateTitleDisplay();
  showNotification('名前を変更しました');
}

async function exportCurrentFile() {
  if (!currentFileId) return;
  if (isDirty) {
    const entry: FileEntry = await invoke('save_file', { id: currentFileId, body: textarea.value });
    currentTitle = entry.title;
    isDirty = false;
  }
  const path = await save({
    defaultPath: `${currentTitle}.txt`,
    filters: [{ name: 'テキストファイル', extensions: ['txt'] }],
  });
  if (!path) return;
  await invoke('export_file_to', { id: currentFileId, dest: path });
  showNotification('書き出しました');
}

function updateSaveStatus() {
  saveStatusEl.textContent = isDirty ? '未保存' : '保存済';
  saveStatusEl.style.color = isDirty ? '#d48a4a' : '#aaa';
}

function scheduleAutoSave() {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = window.setTimeout(async () => {
    if (currentFileId && isDirty) {
      showSaveStatus('saving');
      const entry: FileEntry = await invoke('save_file', { id: currentFileId, body: textarea.value });
      currentTitle = entry.title;
      currentCustomTitle = entry.custom_title;
      isDirty = false;
      updateTitleDisplay();
      updateSaveStatus();
      showSaveStatus('saved');
    }
  }, 1000);
}

function showSaveStatus(state: 'saving' | 'saved' | 'idle') {
  if (!saveStatusEl) return;
  saveStatusEl.classList.remove('saving', 'saved');
  if (state === 'saving') {
    saveStatusEl.textContent = '保存中…';
    saveStatusEl.classList.add('saving');
  } else if (state === 'saved') {
    saveStatusEl.textContent = '保存済';
    saveStatusEl.classList.add('saved');
    setTimeout(() => {
      if (!isDirty) {
        saveStatusEl.classList.remove('saved');
      }
    }, 2000);
  }
}

function markDirty() {
  if (!isDirty) { isDirty = true; updateSaveStatus(); }
  scheduleAutoSave();
}

async function backToList() {
  if (currentFileId && isDirty) {
    await invoke('save_file', { id: currentFileId, body: textarea.value });
  }
  currentFileId = null;
  hidePreview();
  showFileManager();
}

// ===== Responsive sizing =====
function recalcSize() {
  const toolbar = document.getElementById('toolbar');
  const statusBar = document.getElementById('status-bar');
  if (!toolbar || !statusBar) return;
  const toolbarH = toolbar.offsetHeight;
  const statusH = statusBar.offsetHeight;
  const wrapPad = 20;
  const overflowGap = totalCols > BASE_COLS ? 8 : 0;
  const previewW = previewVisible ? previewPanel.offsetWidth + 1 : 0;
  const availW = window.innerWidth - wrapPad * 2 - previewW;
  const availH = window.innerHeight - toolbarH - statusH - wrapPad * 2;
  const cellFromW = (availW - totalCols - 1 - overflowGap) / totalCols;
  const cellFromH = (availH - ROWS - 1) / ROWS;
  const cellSize = Math.max(14, Math.min(52, Math.floor(Math.min(cellFromW, cellFromH))));
  const fontSize = Math.max(7, Math.round(cellSize * 0.55));
  const tcySize = Math.max(5, Math.round(fontSize * 0.63));
  document.documentElement.style.setProperty('--cell', cellSize + 'px');
  document.documentElement.style.setProperty('--fs', fontSize + 'px');
  document.documentElement.style.setProperty('--tcy', tcySize + 'px');
}

// ===== Grid DOM =====
function buildGrid() {
  gridEl.innerHTML = '';
  cells = [];
  prevCellStates = [];
  for (let c = 0; c < totalCols; c++) {
    const colDiv = document.createElement('div');
    colDiv.className = 'column';
    if (c === BASE_COLS) colDiv.classList.add('overflow-sep');
    const indent = usableStart(c);
    const tailStart = usableEnd(c);
    cells[c] = [];
    prevCellStates[c] = [];
    for (let r = 0; r < ROWS; r++) {
      const cellDiv = document.createElement('div');
      cellDiv.className = 'cell';
      if (r < indent) cellDiv.classList.add('indent');
      if (r >= tailStart) cellDiv.classList.add('tail-empty');
      cellDiv.dataset.col = String(c);
      cellDiv.dataset.row = String(r);
      cellDiv.addEventListener('mousedown', onCellMouseDown);
      colDiv.appendChild(cellDiv);
      cells[c][r] = cellDiv;
      prevCellStates[c][r] = { text: '', type: 'empty', flags: 0 };
    }
    gridEl.appendChild(colDiv);
  }
}

// ===== Text Processing =====
function textToUnits(text: string): Unit[] {
  const units: Unit[] = [];
  const len = text.length;
  let i = 0;
  while (i < len) {
    const ch = text.charCodeAt(i);
    if (ch === 10) { // '\n'
      units.push({ type: 'newline', text: '\n', rawStart: i, rawLen: 1 });
      i++;
    } else if (isDigitCode(ch)) {
      const start = i;
      while (i < len && isDigitCode(text.charCodeAt(i))) i++;
      const run = i - start;
      if (run === 2) {
        units.push({ type: 'tcy', text: halfDigit(text.charCodeAt(start)) + halfDigit(text.charCodeAt(start + 1)), rawStart: start, rawLen: 2 });
      } else {
        for (let k = start; k < i; k++)
          units.push({ type: 'char', text: halfDigit(text.charCodeAt(k)), rawStart: k, rawLen: 1 });
      }
    } else {
      units.push({ type: 'char', text: text[i], rawStart: i, rawLen: 1 });
      i++;
    }
  }
  return units;
}

function isDigitCode(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 0xFF10 && c <= 0xFF19);
}
function halfDigit(c: number): string {
  if (c >= 0xFF10 && c <= 0xFF19) return String(c - 0xFF10);
  if (c >= 48 && c <= 57) return String.fromCharCode(c);
  return String.fromCharCode(c);
}

function flowToGrid(units: Unit[]): FlowResult {
  const grid: (number|null)[][] = [];
  const unitPos: { col: number; row: number }[] = [];
  const newlineMarkers: GridCell[] = [];
  let col = 0, row = usableStart(0);
  function ensure(c: number) {
    while (grid.length <= c) grid.push(new Array(ROWS).fill(null));
    if (c >= USABLE_START_CACHE.length) ensureColCache(c);
  }
  for (let ui = 0; ui < units.length; ui++) {
    const u = units[ui];
    if (u.type === 'newline') {
      unitPos.push({ col, row: -1 });
      if (row < usableEnd(col)) newlineMarkers.push({ col, row });
      col++; row = usableStart(col);
      continue;
    }
    if (row >= usableEnd(col)) { col++; row = usableStart(col); }
    ensure(col);
    grid[col][row] = ui;
    unitPos.push({ col, row });
    row++;
  }
  while (grid.length < BASE_COLS) grid.push(new Array(ROWS).fill(null));
  return { grid, unitPos, nextCol: col, nextRow: row, neededCols: Math.max(BASE_COLS, grid.length), newlineMarkers };
}

// ===== Cursor Mapping =====
function rawToCell(rawPos: number, units: Unit[], flow: FlowResult): GridCell {
  const { unitPos, nextCol, nextRow, newlineMarkers } = flow;
  if (units.length === 0) return { col: 0, row: usableStart(0) };
  for (let ui = 0; ui < units.length; ui++) {
    const u = units[ui];
    if (rawPos >= u.rawStart && rawPos < u.rawStart + u.rawLen) {
      if (u.type === 'newline') {
        const nlCol = unitPos[ui].col;
        for (let mi = 0; mi < newlineMarkers.length; mi++) {
          if (newlineMarkers[mi].col === nlCol) return newlineMarkers[mi];
        }
        return { col: nlCol, row: usableStart(nlCol) };
      }
      return unitPos[ui];
    }
  }
  return { col: nextCol, row: nextRow };
}

// ===== Sync =====
function syncFromRaw() {
  const { units, flow } = getUnitsAndFlow();
  const ac = rawToCell(activePos, units, flow);
  if (ac) gridCursor = { col: ac.col, row: ac.row };
}

function updateSelection() {
  textarea.selectionStart = Math.min(anchorPos, activePos);
  textarea.selectionEnd = Math.max(anchorPos, activePos);
}

// ===== Movement =====
function moveUnit(delta: number, extend: boolean) {
  const { units } = getUnitsAndFlow();
  const text = textarea.value;
  const stops: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < units.length; i++) {
    if (!seen.has(units[i].rawStart)) { stops.push(units[i].rawStart); seen.add(units[i].rawStart); }
  }
  if (!seen.has(text.length)) stops.push(text.length);
  let curIdx = stops.length - 1;
  for (let i = 0; i < stops.length; i++) { if (stops[i] >= activePos) { curIdx = i; break; } }
  let newIdx = curIdx + delta;
  if (newIdx < 0) newIdx = 0;
  if (newIdx >= stops.length) newIdx = stops.length - 1;
  activePos = stops[newIdx];
  if (!extend) anchorPos = activePos;
  updateSelection(); syncFromRaw(); scheduleRender();
}

function moveColumn(colDelta: number, extend: boolean) {
  const { units, flow } = getUnitsAndFlow();
  const text = textarea.value;
  const { grid, unitPos, nextCol, nextRow } = flow;
  syncFromRaw();
  const curRow = gridCursor.row;
  const tc = gridCursor.col + colDelta;
  if (tc < 0 || tc >= flow.neededCols) return;
  if (tc < grid.length && grid[tc][curRow] !== null) {
    activePos = units[grid[tc][curRow]!].rawStart;
  } else {
    let found = false;
    for (let r = Math.min(curRow, usableEnd(tc) - 1); r >= usableStart(tc); r--) {
      if (tc < grid.length && grid[tc][r] !== null) { activePos = units[grid[tc][r]!].rawStart; found = true; break; }
    }
    if (!found && tc === nextCol && nextRow >= usableStart(tc)) { activePos = text.length; found = true; }
    if (!found) { for (let ui = 0; ui < units.length; ui++) { if (units[ui].type === 'newline' && unitPos[ui].col === tc) { activePos = units[ui].rawStart; found = true; break; } } }
    if (!found) { for (let r = curRow + 1; r < usableEnd(tc); r++) { if (tc < grid.length && grid[tc][r] !== null) { activePos = units[grid[tc][r]!].rawStart; found = true; break; } } }
    if (!found) return;
  }
  if (!extend) anchorPos = activePos;
  updateSelection(); syncFromRaw(); scheduleRender();
}

function cellToNearestRaw(col: number, row: number): number {
  const { units, flow } = getUnitsAndFlow();
  const text = textarea.value;
  const { grid, unitPos, nextCol, nextRow } = flow;
  if (col < grid.length && grid[col][row] !== null) return units[grid[col][row]!].rawStart;
  if (col === nextCol && row === nextRow) return text.length;
  for (let r = row - 1; r >= usableStart(col); r--) {
    if (col < grid.length && grid[col][r] !== null) { const u = units[grid[col][r]!]; return u.rawStart + u.rawLen; }
  }
  for (let ui = 0; ui < units.length; ui++) {
    if (units[ui].type === 'newline' && unitPos[ui].col === col) return units[ui].rawStart;
  }
  return text.length;
}

// ===== Render scheduling =====
function scheduleRender() {
  if (renderRAF) return;
  renderRAF = requestAnimationFrame(() => { renderRAF = 0; render(); });
}

// ===== Render =====
function render() {
  if (editorScreenEl.style.display === 'none') return;
  const { units, flow } = getUnitsAndFlow();
  const { grid, neededCols, newlineMarkers } = flow;

  if (neededCols !== totalCols) { totalCols = neededCols; buildGrid(); recalcSize(); }

  const text = textarea.value;
  const compEnd = isComposing && compStart >= 0 ? text.length - compSuffixLen : -1;
  const selMin = Math.min(anchorPos, activePos);
  const selMax = Math.max(anchorPos, activePos);
  const hasSelection = selMin !== selMax;

  // Count display chars without filter()
  let displayCount = 0;
  for (let ui = 0; ui < units.length; ui++) if (units[ui].type !== 'newline') displayCount++;

  // Build newline marker lookup
  const nlSet = new Set<number>();
  for (let i = 0; i < newlineMarkers.length; i++) {
    nlSet.add(newlineMarkers[i].col * ROWS + newlineMarkers[i].row);
  }

  for (let c = 0; c < totalCols; c++) {
    const colStart = usableStart(c);
    const colEnd = usableEnd(c);
    for (let r = 0; r < ROWS; r++) {
      const cell = cells[c][r];
      const prev = prevCellStates[c][r];
      const ui = (c < grid.length) ? grid[c][r] : null;

      let newText = '';
      let newType: CellState['type'] = 'empty';
      let flags = 0;

      if (ui !== null && units[ui]) {
        const u = units[ui];
        newType = u.type;
        newText = u.text;
        if (hasSelection && u.rawStart >= selMin && u.rawStart < selMax) flags |= FLAG_SELECTED;
        if (isComposing && compStart >= 0 && compEnd > compStart && u.rawStart >= compStart && u.rawStart + u.rawLen <= compEnd) flags |= FLAG_COMPOSING;
        if (r === colStart && u.type === 'char' && kinsokuHeadSet.has(u.text)) flags |= FLAG_KINSOKU;
        if (r === colEnd - 1 && u.type === 'char' && kinsokuTailSet.has(u.text)) flags |= FLAG_KINSOKU;
      }

      // Newline marker
      const isNl = nlSet.has(c * ROWS + r);
      if (isNl) { newType = 'nl-mark'; newText = '↵'; }

      // Cursor
      if (!isComposing && !hasSelection && c === gridCursor.col && r === gridCursor.row) flags |= FLAG_CURSOR;

      // Diff check
      if (prev.text === newText && prev.type === newType && prev.flags === flags) continue;

      // Apply changes
      prev.text = newText;
      prev.type = newType;
      prev.flags = flags;

      // Update DOM
      if (newType === 'empty') {
        if (cell.firstChild) cell.textContent = '';
      } else if (newType === 'tcy') {
        cell.textContent = '';
        const span = document.createElement('span');
        span.className = 'tcy'; span.textContent = newText;
        cell.appendChild(span);
      } else if (newType === 'nl-mark') {
        // May have char content + newline mark overlay
        if (ui !== null && units[ui]) {
          const u = units[ui];
          if (u.type === 'tcy') {
            cell.textContent = '';
            const span = document.createElement('span');
            span.className = 'tcy'; span.textContent = u.text;
            cell.appendChild(span);
          } else {
            cell.textContent = u.text;
          }
        } else {
          cell.textContent = '';
        }
        const mark = document.createElement('span');
        mark.className = 'newline-mark'; mark.textContent = '↵';
        cell.appendChild(mark);
      } else {
        cell.textContent = newText;
      }

      // Flags via classList
      cell.classList.toggle('cursor-cell', !!(flags & FLAG_CURSOR));
      cell.classList.toggle('composing', !!(flags & FLAG_COMPOSING));
      cell.classList.toggle('selected', !!(flags & FLAG_SELECTED));
      cell.classList.toggle('kinsoku', !!(flags & FLAG_KINSOKU));
    }
  }

  let s = displayCount + ' / ' + BASE_MAX + ' 文字';
  const charInCol = gridCursor.row - usableStart(gridCursor.col) + 1;
  s += '　第' + (gridCursor.col + 1) + '行 第' + charInCol + '字';
  if (displayCount > BASE_MAX) s += '　<span class="overflow-warn">超過 +' + (displayCount - BASE_MAX) + '</span>';
  statusText.innerHTML = s;

  if (cells[gridCursor.col]?.[gridCursor.row]) {
    const rect = cells[gridCursor.col][gridCursor.row].getBoundingClientRect();
    textarea.style.left = rect.left + 'px';
    textarea.style.top = rect.top + 'px';
    textarea.style.width = rect.width + 'px';
    textarea.style.height = rect.height + 'px';
  }
}

// ===== Event Handlers =====
function cellFromEvent(e: MouseEvent): GridCell | null {
  const el = (e.target as HTMLElement).closest('.cell') as HTMLElement | null;
  if (!el) return null;
  const col = parseInt(el.dataset.col!), row = parseInt(el.dataset.row!);
  if (row < usableStart(col) || row >= usableEnd(col)) return null;
  return { col, row };
}

function onCellMouseDown(e: MouseEvent) {
  const cr = cellFromEvent(e);
  if (!cr) { textarea.focus(); return; }
  e.preventDefault();
  activePos = cellToNearestRaw(cr.col, cr.row);
  if (!e.shiftKey) anchorPos = activePos;
  mouseIsDown = true;
  updateSelection(); syncFromRaw(); textarea.focus(); render();
}

function resetCursor() {
  anchorPos = activePos = 0;
  textarea.selectionStart = textarea.selectionEnd = 0;
  syncFromRaw();
}

// ============================================================
//  INIT
// ============================================================
window.addEventListener('DOMContentLoaded', async () => {
  fileManagerEl = document.getElementById('file-manager')!;
  editorScreenEl = document.getElementById('editor-screen')!;
  fmListEl = document.getElementById('fm-list')!;
  gridEl = document.getElementById('grid')!;
  textarea = document.getElementById('hidden-input') as HTMLTextAreaElement;
  statusText = document.getElementById('status-text')!;
  editorTitleEl = document.getElementById('editor-title')!;
  saveStatusEl = document.getElementById('save-status')!;
  fmFileInput = document.getElementById('fm-file-input') as HTMLInputElement;

  // Preview panel
  previewPanel = document.getElementById('preview-panel')!;
  previewTitleEl = document.getElementById('preview-title')!;
  previewTextEl = document.getElementById('preview-text') as HTMLTextAreaElement;
  previewCopyBtn = document.getElementById('btn-preview-copy')!;
  document.getElementById('btn-preview-close')!.addEventListener('click', hidePreview);
  document.getElementById('chk-preview-space')?.addEventListener('change', () => {
    markPreviewDirty();
    flushPreview();
  });
  previewCopyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(previewTextEl.value).then(() => {
      previewCopyBtn.textContent = 'コピー済';
      setTimeout(() => { previewCopyBtn.textContent = 'コピー'; }, 1200);
    });
  });

  // File manager
  document.getElementById('fm-new')!.addEventListener('click', createNewFile);
  document.getElementById('fm-import')!.addEventListener('click', () => fmFileInput.click());
  fmFileInput.addEventListener('change', () => {
    const file = fmFileInput.files?.[0];
    if (file) importFile(file);
    fmFileInput.value = '';
  });

  // Editor toolbar
  document.getElementById('btn-back')!.addEventListener('click', backToList);
  document.getElementById('btn-save')!.addEventListener('click', saveCurrentFile);
  document.getElementById('btn-rename')!.addEventListener('click', renameCurrentFile);
  document.getElementById('btn-export')!.addEventListener('click', exportCurrentFile);
  document.getElementById('btn-preview')!.addEventListener('click', () => {
    const title = currentCustomTitle ? currentTitle : deriveTitle(textarea.value);
    togglePreview(title);
  });
  document.getElementById('btn-history')!.addEventListener('click', openHistory);
  document.getElementById('chk-grid')!.addEventListener('change', (e) => {
    gridEl.classList.toggle('no-gridlines', !(e.target as HTMLInputElement).checked);
  });

  // IME composition
  textarea.addEventListener('compositionstart', () => {
    isComposing = true;
    compStart = textarea.selectionStart;
    compSuffixLen = textarea.value.length - textarea.selectionEnd;
  });
  textarea.addEventListener('input', () => {
    invalidateCache();
    if (!isComposing) {
      anchorPos = activePos = textarea.selectionStart;
      syncFromRaw();
      markDirty();
      updateTitleDisplay();
      markPreviewDirty();
    }
    render();
  });
  textarea.addEventListener('compositionend', () => {
    isComposing = false; compStart = -1; compSuffixLen = 0;
    invalidateCache();
    anchorPos = activePos = textarea.selectionStart;
    syncFromRaw();
    markDirty();
    updateTitleDisplay();
    markPreviewDirty();
    flushPreview();
    render();
  });

  // Keyboard
  textarea.addEventListener('keydown', (e) => {
    if (isComposing) return;
    const shift = e.shiftKey, ctrl = e.ctrlKey || e.metaKey;
    switch (e.key) {
    case 'ArrowUp':    e.preventDefault(); moveUnit(-1, shift); return;
    case 'ArrowDown':  e.preventDefault(); moveUnit(1, shift); return;
    case 'ArrowLeft':  e.preventDefault(); moveColumn(1, shift); return;
    case 'ArrowRight': e.preventDefault(); moveColumn(-1, shift); return;
    case 'Home':
      e.preventDefault();
      if (ctrl) { activePos = 0; }
      else {
        syncFromRaw();
        const c = gridCursor.col;
        const { units: hu, flow: hf } = getUnitsAndFlow();
        let found = false;
        for (let r = usableStart(c); r < usableEnd(c); r++) {
          if (c < hf.grid.length && hf.grid[c][r] !== null) { activePos = hu[hf.grid[c][r]!].rawStart; found = true; break; }
        }
        if (!found) activePos = cellToNearestRaw(c, usableStart(c));
      }
      if (!shift) anchorPos = activePos;
      updateSelection(); syncFromRaw(); scheduleRender(); return;
    case 'End':
      e.preventDefault();
      if (ctrl) { activePos = textarea.value.length; }
      else {
        syncFromRaw();
        const c = gridCursor.col;
        const { units: eu, flow: ef } = getUnitsAndFlow();
        let lastPos = activePos;
        for (let r = usableEnd(c) - 1; r >= usableStart(c); r--) {
          if (c < ef.grid.length && ef.grid[c][r] !== null) { const u = eu[ef.grid[c][r]!]; lastPos = u.rawStart + u.rawLen; break; }
        }
        activePos = lastPos;
      }
      if (!shift) anchorPos = activePos;
      updateSelection(); syncFromRaw(); scheduleRender(); return;
    case 'a':
      if (ctrl) { e.preventDefault(); anchorPos = 0; activePos = textarea.value.length; updateSelection(); syncFromRaw(); scheduleRender(); return; }
      break;
    case 's':
      if (ctrl) { e.preventDefault(); saveCurrentFile(); return; }
      break;
    }
  });

  // Mouse
  document.addEventListener('mousemove', (e) => {
    if (!mouseIsDown) return;
    const cr = cellFromEvent(e); if (!cr) return;
    activePos = cellToNearestRaw(cr.col, cr.row);
    updateSelection(); syncFromRaw(); render();
  });
  document.addEventListener('mouseup', () => { mouseIsDown = false; });
  document.addEventListener('mousedown', (e) => {
    if (editorScreenEl.style.display !== 'none' && !(e.target as HTMLElement).closest('#toolbar') && (e.target as HTMLElement).tagName !== 'INPUT' && !(e.target as HTMLElement).closest('#preview-panel'))
      setTimeout(() => textarea.focus(), 0);
  });

  window.addEventListener('resize', () => {
    if (editorScreenEl.style.display !== 'none') { recalcSize(); render(); }
  });

  // Periodic preview flush (debounced, not per-keystroke)
  setInterval(() => { if (previewDirty) flushPreview(); }, 300);

  // Focus/blur auto-save
  window.addEventListener('blur', async () => {
    if (currentFileId && isDirty) {
      showSaveStatus('saving');
      const entry: FileEntry = await invoke('save_file', { id: currentFileId, body: textarea.value });
      currentTitle = entry.title;
      currentCustomTitle = entry.custom_title;
      isDirty = false;
      updateTitleDisplay();
      updateSaveStatus();
      showSaveStatus('saved');
    }
  });

  // Periodic dirty check (every 30s)
  setInterval(async () => {
    if (currentFileId && isDirty) {
      showSaveStatus('saving');
      const entry: FileEntry = await invoke('save_file', { id: currentFileId, body: textarea.value });
      currentTitle = entry.title;
      currentCustomTitle = entry.custom_title;
      isDirty = false;
      updateTitleDisplay();
      updateSaveStatus();
      showSaveStatus('saved');
    }
  }, 30000);

  // ===== History Modal =====
  const historyOverlay = document.getElementById('history-overlay')!;
  const historyListEl = document.getElementById('history-list')!;
  const historyListWrapper = document.getElementById('history-list-wrapper')!;
  const historyPreviewWrapper = document.getElementById('history-preview-wrapper')!;
  const historyPreviewInfo = document.getElementById('history-preview-info')!;
  const historyPreviewText = document.getElementById('history-preview-text') as HTMLTextAreaElement;
  let historySelectedHash = '';

  document.getElementById('history-close')!.addEventListener('click', closeHistory);
  document.getElementById('history-preview-back')!.addEventListener('click', () => {
    historyListWrapper.style.display = 'block';
    historyPreviewWrapper.style.display = 'none';
  });
  document.getElementById('history-restore')!.addEventListener('click', async () => {
    if (!currentFileId || !historySelectedHash) return;
    if (!(await customConfirm('この版に復元しますか？'))) return;
    const entry: FileEntry = await invoke('git_restore', { id: currentFileId, commitHash: historySelectedHash });
    textarea.value = entry.body;
    currentTitle = entry.title;
    currentCustomTitle = entry.custom_title;
    isDirty = false;
    invalidateCache();
    resetCursor();
    updateTitleDisplay();
    updateSaveStatus();
    render();
    closeHistory();
    showNotification('復元しました');
  });
  historyOverlay.addEventListener('click', (e) => {
    if (e.target === historyOverlay) closeHistory();
  });

  function closeHistory() {
    historyOverlay.style.display = 'none';
    historyListWrapper.style.display = 'block';
    historyPreviewWrapper.style.display = 'none';
    textarea.focus();
  }

  async function openHistory() {
    if (!currentFileId) return;
    // Save before showing history
    if (isDirty) {
      await invoke('save_file', { id: currentFileId, body: textarea.value });
      isDirty = false;
      updateSaveStatus();
    }
    historyOverlay.style.display = 'flex';
    historyListWrapper.style.display = 'block';
    historyPreviewWrapper.style.display = 'none';
    historyListEl.innerHTML = '<div class="history-empty">読み込み中…</div>';
    try {
      const logs: GitLogEntry[] = await invoke('git_log', { id: currentFileId });
      historyListEl.innerHTML = '';
      if (logs.length === 0) {
        historyListEl.innerHTML = '<div class="history-empty">履歴がありません。</div>';
        return;
      }
      logs.forEach((log, idx) => {
        const item = document.createElement('div');
        item.className = 'history-item' + (idx === 0 ? ' current' : '');
        item.innerHTML = `
          <div class="history-item-info">
            <div class="history-item-time">${escHtml(log.timestamp)}</div>
            <div class="history-item-msg">${escHtml(log.message)}</div>
          </div>
          <div class="history-item-chars">${log.char_count} 文字</div>
        `;
        item.addEventListener('click', () => showHistoryPreview(log));
        historyListEl.appendChild(item);
      });
    } catch (err) {
      historyListEl.innerHTML = '<div class="history-empty">履歴の読み込みに失敗しました。</div>';
    }
  }

  async function showHistoryPreview(log: GitLogEntry) {
    if (!currentFileId) return;
    historySelectedHash = log.commit_hash;
    historyPreviewInfo.textContent = `${log.timestamp}　${log.char_count} 文字`;
    historyPreviewText.value = '読み込み中…';
    historyListWrapper.style.display = 'none';
    historyPreviewWrapper.style.display = 'flex';
    try {
      const body: string = await invoke('git_show', { id: currentFileId, commitHash: log.commit_hash });
      historyPreviewText.value = body;
    } catch {
      historyPreviewText.value = '内容の読み込みに失敗しました。';
    }
  }

  // ===== Settings Modal =====
  const settingsOverlay = document.getElementById('settings-overlay')!;
  const btnSettings = document.getElementById('btn-settings')!;
  const btnSettingsClose = document.getElementById('settings-close')!;
  const btnSettingsSave = document.getElementById('btn-settings-save')!;
  const inputSettingHead = document.getElementById('setting-kinsoku-head') as HTMLInputElement;
  const inputSettingTail = document.getElementById('setting-kinsoku-tail') as HTMLInputElement;
  const inputSettingColor = document.getElementById('setting-kinsoku-color') as HTMLInputElement;
  const radioSpaceHalf = document.querySelector('input[name="setting-space"][value="half"]') as HTMLInputElement;
  const radioSpaceFull = document.querySelector('input[name="setting-space"][value="full"]') as HTMLInputElement;

  btnSettings.addEventListener('click', openSettings);
  btnSettingsClose.addEventListener('click', closeSettings);
  settingsOverlay.addEventListener('click', (e) => {
    if (e.target === settingsOverlay) closeSettings();
  });
  btnSettingsSave.addEventListener('click', () => {
    appSettings.previewSpaceWidth = radioSpaceFull.checked ? 'full' : 'half';
    appSettings.kinsokuHead = inputSettingHead.value;
    appSettings.kinsokuTail = inputSettingTail.value;
    appSettings.kinsokuColorHex = inputSettingColor.value;

    localStorage.setItem('user_settings', JSON.stringify(appSettings));
    applySettings(appSettings);
    
    // Refresh the view
    invalidateCache();
    syncFromRaw();
    render();
    if (previewVisible) flushPreview();
    
    closeSettings();
    showNotification('設定を保存しました');
  });

  function openSettings() {
    if (appSettings.previewSpaceWidth === 'full') radioSpaceFull.checked = true;
    else radioSpaceHalf.checked = true;
    inputSettingHead.value = appSettings.kinsokuHead;
    inputSettingTail.value = appSettings.kinsokuTail;
    inputSettingColor.value = appSettings.kinsokuColorHex;
    settingsOverlay.style.display = 'flex';
  }

  function closeSettings() {
    settingsOverlay.style.display = 'none';
    textarea.focus();
  }

  // Native menu events
  listen<string>('menu-action', (event) => {
    const action = event.payload;
    const inEditor = editorScreenEl.style.display !== 'none';
    switch (action) {
      case 'new': createNewFile(); break;
      case 'save': if (inEditor) saveCurrentFile(); break;
      case 'export': if (inEditor) exportCurrentFile(); break;
      case 'rename': if (inEditor) renameCurrentFile(); break;
      case 'preview':
        if (inEditor) {
          const title = currentCustomTitle ? currentTitle : deriveTitle(textarea.value);
          togglePreview(title);
        }
        break;
      case 'history': if (inEditor) openHistory(); break;
      case 'back': if (inEditor) backToList(); break;
    }
  });

  // ===== Data Dir UI =====
  const fmDatadirPath = document.getElementById('fm-datadir-path')!;

  async function updateDataDirDisplay() {
    const dir: string = await invoke('get_data_dir');
    fmDatadirPath.textContent = dir;
  }

  async function chooseFolder(): Promise<string | null> {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === 'string') return selected;
    return null;
  }

  document.getElementById('fm-datadir-change')!.addEventListener('click', async () => {
    const dir = await chooseFolder();
    if (!dir) return;
    if (!(await customConfirm(`保存先を変更しますか？\n\n${dir}\n\n※ 既存の原稿は移動されません。`))) return;
    await invoke('set_data_dir', { path: dir });
    await updateDataDirDisplay();
    refreshFileList();
    showNotification('保存先を変更しました');
  });

  // ===== Setup Screen (first launch) =====
  const setupScreen = document.getElementById('setup-screen')!;
  const isFirst: boolean = await invoke('is_first_launch');

  if (isFirst) {
    const defaultDir: string = await invoke('get_default_data_dir');
    document.getElementById('setup-path-display')!.textContent = defaultDir;

    setupScreen.style.display = 'flex';

    document.getElementById('setup-default')!.addEventListener('click', async () => {
      await invoke('set_default_data_dir');
      setupScreen.style.display = 'none';
      await updateDataDirDisplay();
      showFileManager();
    });

    document.getElementById('setup-choose')!.addEventListener('click', async () => {
      const dir = await chooseFolder();
      if (!dir) return;
      await invoke('set_data_dir', { path: dir });
      setupScreen.style.display = 'none';
      await updateDataDirDisplay();
      showFileManager();
    });
  } else {
    await updateDataDirDisplay();
    showFileManager();
  }
});
