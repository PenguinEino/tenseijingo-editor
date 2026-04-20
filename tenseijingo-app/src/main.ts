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
  bold_ranges?: number[][];
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
  newlineMarkerSet: Set<number>;
  displayCount: number;
  maxOutputCol: number;
}
interface GitLogEntry {
  commit_hash: string;
  message: string;
  timestamp: string;
  char_count: number;
}
interface DataDirInspection {
  file_count: number;
  overlapping_count: number;
}
type HistoryStatus = 'committed' | 'recovered' | 'pending';
interface FileSaveResult {
  entry: FileEntry;
  history_status: HistoryStatus;
}
interface CreateFileResult {
  id: string;
  history_status: HistoryStatus;
}
interface HistoryActionResult {
  history_status: HistoryStatus;
}
interface HistoryRecoveryResult {
  recovered: boolean;
}
type DataDirSwitchAction = 'migrate' | 'switch-only';
type RuntimePlatform = 'windows' | 'macos' | 'linux' | 'unknown';

declare global {
  interface Window {
    __TEST_PLATFORM__?: string;
  }
}

// ===== Settings & Config =====
interface AppSettings {
  kinsokuHead: string;
  kinsokuTail: string;
  kinsokuColorHex: string;
  viewZoom: number;
  fontScale: number;
  baseFontWeight: number;
  gridStyle: 'solid' | 'dashed';
  tcyScale: number;
  cursorPosition: 'top' | 'bottom' | 'left' | 'right';
}

const DEFAULT_SETTINGS: AppSettings = {
  kinsokuHead: '、。，．,.！？!?）)」』】〉》〕｝}：；:;ー～…‥・',
  kinsokuTail: '（(「『【〈《〔｛{▼▽△▲',
  kinsokuColorHex: '#d24646',
  viewZoom: 1,
  fontScale: 0.6,
  baseFontWeight: 500,
  gridStyle: 'solid',
  tcyScale: 1.04,
  cursorPosition: 'top'
};

let appSettings: AppSettings = { ...DEFAULT_SETTINGS };
const VIEW_ZOOM_STEPS = [0.85, 0.93, 1, 1.08, 1.16, 1.25, 1.35];
const FONT_SCALE_STEPS = [0.52, 0.58, 0.64, 0.72, 0.82];
const FONT_WEIGHT_STEPS = [400, 500, 600, 700, 800, 900];

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
  document.documentElement.style.setProperty('--kinsoku-bg', `rgba(${r}, ${g}, ${b}, 0.35)`);
  document.documentElement.style.setProperty('--base-weight', String(settings.baseFontWeight));
  const strokeMap: Record<number, string> = {
    400: '0px',
    500: '0px',
    600: '0.12px',
    700: '0.18px',
    800: '0.24px',
    900: '0.3px',
  };
  const shadowMap: Record<number, string> = {
    400: 'none',
    500: 'none',
    600: '0.25px 0 currentColor, -0.25px 0 currentColor',
    700: '0.35px 0 currentColor, -0.35px 0 currentColor, 0 0.2px currentColor',
    800: '0.45px 0 currentColor, -0.45px 0 currentColor, 0 0.3px currentColor, 0 -0.3px currentColor',
    900: '0.55px 0 currentColor, -0.55px 0 currentColor, 0 0.4px currentColor, 0 -0.4px currentColor, 0.35px 0.35px currentColor, -0.35px -0.35px currentColor',
  };
  document.documentElement.style.setProperty('--weight-stroke', strokeMap[settings.baseFontWeight] ?? '0px');
  document.documentElement.style.setProperty('--weight-shadow', shadowMap[settings.baseFontWeight] ?? 'none');
  document.documentElement.style.setProperty('--grid-style', settings.gridStyle);
  document.documentElement.dataset.cursorPosition = settings.cursorPosition;
}

function loadSettings() {
  try {
    const saved = localStorage.getItem('user_settings');
    if (saved) {
      const parsed = JSON.parse(saved);
      appSettings = { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch(e) {}
  if (!VIEW_ZOOM_STEPS.includes(appSettings.viewZoom)) appSettings.viewZoom = DEFAULT_SETTINGS.viewZoom;
  if (!FONT_SCALE_STEPS.includes(appSettings.fontScale)) appSettings.fontScale = DEFAULT_SETTINGS.fontScale;
  if (!FONT_WEIGHT_STEPS.includes(appSettings.baseFontWeight)) appSettings.baseFontWeight = DEFAULT_SETTINGS.baseFontWeight;
  if (appSettings.gridStyle !== 'solid' && appSettings.gridStyle !== 'dashed') appSettings.gridStyle = DEFAULT_SETTINGS.gridStyle;
  if (typeof appSettings.tcyScale !== 'number' || Number.isNaN(appSettings.tcyScale)) appSettings.tcyScale = DEFAULT_SETTINGS.tcyScale;
  if (!['top', 'bottom', 'left', 'right'].includes(appSettings.cursorPosition)) appSettings.cursorPosition = DEFAULT_SETTINGS.cursorPosition;
  applySettings(appSettings);
}
loadSettings();

function detectRuntimePlatform(): RuntimePlatform {
  const override = window.__TEST_PLATFORM__?.toLowerCase();
  if (override?.includes('win')) return 'windows';
  if (override?.includes('mac')) return 'macos';
  if (override?.includes('linux')) return 'linux';

  const navigatorWithHints = navigator as Navigator & { userAgentData?: { platform?: string } };
  const hints = [
    navigatorWithHints.userAgentData?.platform?.toLowerCase(),
    navigator.platform?.toLowerCase(),
    navigator.userAgent?.toLowerCase(),
  ].filter((value): value is string => !!value);

  if (hints.some((value) => value.includes('win'))) return 'windows';
  if (hints.some((value) => value.includes('mac'))) return 'macos';
  if (hints.some((value) => value.includes('linux'))) return 'linux';
  return 'unknown';
}

const runtimePlatform = detectRuntimePlatform();
const isWindows = runtimePlatform === 'windows';
document.documentElement.dataset.platform = runtimePlatform;

// ===== Constants =====
const BASE_COLS = 35;
const ROWS = 18;
const BASE_CELL_SIZE = 34;
const MIN_CELL_SIZE = 12;
const MAX_CELL_SIZE = 72;
const BASE_GRID_CHROME = BASE_COLS + 1;

// Pre-compute column configs
const COL_CFG_CACHE: ColCfg[] = [];
const USABLE_START_CACHE: number[] = [];
const USABLE_END_CACHE: number[] = [];
function colConfig(c: number): ColCfg {
  if (c < COL_CFG_CACHE.length) return COL_CFG_CACHE[c];
  if (c >= BASE_COLS) return { indent: 0, tail: 0 };
  if (c >= 0 && c <= 5) return { indent: 4, tail: 0 };
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
let fmContentEl: HTMLElement;
let fmListEl: HTMLElement;
let fmPreviewPanelEl: HTMLElement;
let fmPreviewTitleEl: HTMLElement;
let fmPreviewTextEl: HTMLTextAreaElement;
let fmPreviewCopyBtn: HTMLButtonElement;
let gridWrapperEl: HTMLElement;
let gridEl: HTMLElement;
let textarea: HTMLTextAreaElement;
let statusText: HTMLElement;
let editorTitleEl: HTMLButtonElement;
let editorTitleInputEl: HTMLInputElement;
let saveStatusEl: HTMLElement;
let fmFileInput: HTMLInputElement;
let viewZoomValueEl: HTMLElement;
let fontSizeValueEl: HTMLElement;
let fontWeightValueEl: HTMLElement;
let gridSolidBtnEl: HTMLButtonElement;
let gridDashedBtnEl: HTMLButtonElement;
let settingsPreviewMode: 'char' | 'tcy' = 'char';
let settingsCursorPreviewPosition: AppSettings['cursorPosition'] = 'top';
let currentCellSize = BASE_CELL_SIZE;
let fileManagerPreviewId: string | null = null;
let isEditingTitleInline = false;

// ===== Editor state =====
let totalCols = BASE_COLS;
let cells: HTMLElement[][] = [];
let isComposing = false;
let compStart = -1;
let compSuffixLen = 0;
let compCellCol = -1;
let compCellRow = -1;
let autoSaveTimer: number | null = null;
let mouseIsDown = false;
let mouseAnchorCell: GridCell | null = null;
let mouseClientX = 0;
let mouseClientY = 0;
let selectionAutoScrollRAF = 0;
let preserveViewportWhileRendering = false;
let gridCursor: GridCell = { col: 0, row: 5 };
let anchorPos = 0;
let activePos = 0;

// ===== Render cache (for diff-based updates) =====
interface CellState { text: string; type: 'char'|'tcy'|'newline'|'empty'|'nl-mark'; flags: number; }
const FLAG_CURSOR   = 1;
const FLAG_COMPOSING = 2;
const FLAG_SELECTED = 4;
const FLAG_KINSOKU  = 8;
const FLAG_PUNCT    = 16;
const FLAG_ROT      = 32;
const FLAG_KAKKO_OPEN = 64;
const FLAG_KAKKO_CLOSE = 128;
const PUNCT_SET = new Set<string>(['、', '。', '，', '．', ',', '.']);
const ROTATE_SET = new Set<string>(['ー', '−', '—', '―', '–', '～', '〜', '…', '‥']);
const KAKKO_OPEN_SET = new Set<string>(['「', '『']);
const KAKKO_CLOSE_SET = new Set<string>(['」', '』']);
const VERTICAL_GLYPH_MAP: Record<string, string> = {
  '。': '︒',
  '、': '︑',
  '「': '﹁',
  '」': '﹂',
  '『': '﹃',
  '』': '﹄',
  '（': '︵',
  '）': '︶',
  '(': '︵',
  ')': '︶',
};
let prevCellStates: CellState[][] = [];
let renderRAF = 0;
let layoutRAF = 0;
let saveStatusTimer: number | null = null;
let historyPending = false;
let activeNotification: { dismiss: () => void; dismissOnInput: boolean } | null = null;

// ===== Cached computation =====
let cachedText = '';
let cachedUnits: Unit[] = [];
let cachedFlow: FlowResult | null = null;
let cachedRawStops: number[] = [];
let cursorSyncNeeded = true;

function invalidateCache() {
  cachedFlow = null;
  cachedRawStops = [];
  cursorSyncNeeded = true;
}

function scheduleLayoutRefresh() {
  if (layoutRAF) cancelAnimationFrame(layoutRAF);
  layoutRAF = requestAnimationFrame(() => {
    layoutRAF = 0;
    recalcSize();
    updateInlineControlState();
    if (isComposing) positionCompositionInput();
    scheduleRender();
  });
}

function getUnitsAndFlow(): { units: Unit[]; flow: FlowResult } {
  const text = textarea.value;
  if (cachedFlow && cachedText === text) return { units: cachedUnits, flow: cachedFlow };
  cachedText = text;
  cachedUnits = textToUnits(text);
  cachedFlow = flowToGrid(cachedUnits);
  cachedRawStops = buildRawStops(cachedUnits, text.length);
  return { units: cachedUnits, flow: cachedFlow };
}

function getRawStops(): number[] {
  const text = textarea.value;
  if (cachedText !== text || !cachedFlow) getUnitsAndFlow();
  return cachedRawStops;
}

function buildRawStops(units: Unit[], textLength: number): number[] {
  const stops: number[] = [];
  let prevStart = -1;
  for (let i = 0; i < units.length; i++) {
    const start = units[i].rawStart;
    if (start !== prevStart) {
      stops.push(start);
      prevStart = start;
    }
  }
  if (stops[stops.length - 1] !== textLength) stops.push(textLength);
  return stops;
}

function shiftSettingStep(steps: number[], current: number, delta: number): number {
  const currentIndex = steps.indexOf(current);
  const baseIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = Math.max(0, Math.min(steps.length - 1, baseIndex + delta));
  return steps[nextIndex];
}

function updateInlineControlState() {
  if (!viewZoomValueEl || !fontSizeValueEl || !fontWeightValueEl) return;
  viewZoomValueEl.textContent = `${Math.round((currentCellSize / BASE_CELL_SIZE) * 100)}%`;
  fontSizeValueEl.textContent = `${Math.round(appSettings.fontScale * 100)}%`;
  fontWeightValueEl.textContent = String(appSettings.baseFontWeight);
  gridSolidBtnEl.classList.toggle('active', appSettings.gridStyle === 'solid');
  gridDashedBtnEl.classList.toggle('active', appSettings.gridStyle === 'dashed');
}

function persistDisplaySettings() {
  localStorage.setItem('user_settings', JSON.stringify(appSettings));
}

function preserveGridViewport(run: () => void) {
  if (!gridWrapperEl || editorScreenEl?.style.display === 'none') {
    run();
    return;
  }

  const { scrollLeft, scrollTop } = gridWrapperEl;
  preserveViewportWhileRendering = true;
  try {
    run();
  } finally {
    preserveViewportWhileRendering = false;
  }

  gridWrapperEl.scrollTo({ left: scrollLeft, top: scrollTop, behavior: 'auto' });
  if (!isComposing) syncHiddenInputPosition();
}

function applyDisplaySettings() {
  preserveGridViewport(() => {
    applySettings(appSettings);
    recalcSize();
    updateInlineControlState();
    render();
  });
}

function stepViewZoom(delta: number) {
  appSettings.viewZoom = shiftSettingStep(VIEW_ZOOM_STEPS, appSettings.viewZoom, delta);
  persistDisplaySettings();
  applyDisplaySettings();
}

function stepFontScale(delta: number) {
  appSettings.fontScale = shiftSettingStep(FONT_SCALE_STEPS, appSettings.fontScale, delta);
  persistDisplaySettings();
  applyDisplaySettings();
}

function stepFontWeight(delta: number) {
  appSettings.baseFontWeight = shiftSettingStep(FONT_WEIGHT_STEPS, appSettings.baseFontWeight, delta);
  persistDisplaySettings();
  applyDisplaySettings();
}

function setGridStyle(style: 'solid' | 'dashed') {
  if (appSettings.gridStyle === style) return;
  appSettings.gridStyle = style;
  persistDisplaySettings();
  applyDisplaySettings();
}

function bindInlineControl(buttonId: string, handler: () => void) {
  const button = document.getElementById(buttonId)!;
  button.addEventListener('mousedown', (e) => { e.preventDefault(); });
  button.addEventListener('click', () => {
    handler();
    textarea.focus();
  });
}

function appendCharContent(cell: HTMLElement, text: string, flags: number) {
  cell.textContent = '';
  const needsSlot = !!(flags & (FLAG_PUNCT | FLAG_KAKKO_OPEN | FLAG_KAKKO_CLOSE));
  const displayText = VERTICAL_GLYPH_MAP[text] ?? text;
  const target = needsSlot ? document.createElement('span') : cell;
  if (needsSlot) {
    const slotClasses = ['glyph-slot'];
    if (flags & FLAG_PUNCT) slotClasses.push('glyph-slot-punct');
    if (flags & FLAG_KAKKO_OPEN) slotClasses.push('glyph-slot-kakko-open');
    if (flags & FLAG_KAKKO_CLOSE) slotClasses.push('glyph-slot-kakko-close');
    target.className = slotClasses.join(' ');
  }
  const span = document.createElement('span');
  const classes = ['glyph'];
  if (flags & FLAG_ROT) classes.push('rot');
  span.className = classes.join(' ');
  span.textContent = displayText;
  target.appendChild(span);
  if (needsSlot) cell.appendChild(target);
}

function getPreviewTcyScalePercent(): number {
  const input = document.getElementById('setting-tcy-scale') as HTMLInputElement | null;
  return input ? parseInt(input.value, 10) || Math.round(appSettings.tcyScale * 100) : Math.round(appSettings.tcyScale * 100);
}

function updateSettingsPreview() {
  const valueEl = document.getElementById('setting-tcy-scale-value');
  const glyphEl = document.getElementById('settings-preview-glyph') as HTMLElement | null;
  const previewCellEl = document.getElementById('settings-preview-cell') as HTMLElement | null;
  const charBtn = document.getElementById('settings-preview-char');
  const tcyBtn = document.getElementById('settings-preview-tcy');
  const cursorPositions: AppSettings['cursorPosition'][] = ['top', 'bottom', 'left', 'right'];
  if (!valueEl || !glyphEl || !charBtn || !tcyBtn || !previewCellEl) return;

  const tcyPercent = getPreviewTcyScalePercent();
  valueEl.textContent = `${tcyPercent}%`;
  charBtn.classList.toggle('active', settingsPreviewMode === 'char');
  tcyBtn.classList.toggle('active', settingsPreviewMode === 'tcy');
  for (const position of cursorPositions) {
    document.getElementById(`setting-cursor-${position}`)?.classList.toggle('active', settingsCursorPreviewPosition === position);
  }

  const cellSize = 56;
  const fontSize = Math.round(cellSize * appSettings.fontScale);
  const tcySize = Math.min(Math.floor(cellSize * 0.9), Math.round(fontSize * (tcyPercent / 100)));

  glyphEl.textContent = settingsPreviewMode === 'tcy' ? '99' : '縦';
  glyphEl.style.fontWeight = String(appSettings.baseFontWeight);
  glyphEl.style.fontSize = `${settingsPreviewMode === 'tcy' ? tcySize : fontSize}px`;
  glyphEl.style.letterSpacing = settingsPreviewMode === 'tcy' ? '-0.5px' : '0';
  previewCellEl.dataset.cursorPosition = settingsCursorPreviewPosition;
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

function showDataDirSwitchDialog(currentDir: string, nextDir: string, targetInfo: DataDirInspection): Promise<DataDirSwitchAction | null> {
  return new Promise((resolve) => {
    const overlay = document.getElementById('data-dir-overlay')!;
    const currentEl = document.getElementById('data-dir-current')!;
    const nextEl = document.getElementById('data-dir-next')!;
    const summaryEl = document.getElementById('data-dir-summary')!;
    const warningsEl = document.getElementById('data-dir-warnings')!;
    const migrateBtn = document.getElementById('data-dir-migrate') as HTMLButtonElement;
    const switchOnlyBtn = document.getElementById('data-dir-switch-only') as HTMLButtonElement;
    const confirmBtn = document.getElementById('data-dir-confirm') as HTMLButtonElement;
    const cancelBtn = document.getElementById('data-dir-cancel')!;
    const closeBtn = document.getElementById('data-dir-close')!;
    const actionButtons: Record<DataDirSwitchAction, HTMLButtonElement> = {
      migrate: migrateBtn,
      'switch-only': switchOnlyBtn,
    };
    let selectedAction: DataDirSwitchAction = 'switch-only';

    currentEl.textContent = currentDir;
    nextEl.textContent = nextDir;

    function renderNotice() {
      summaryEl.textContent = '';

      const warnings: string[] = [];
      if (selectedAction === 'switch-only' && targetInfo.file_count === 0) {
        warnings.push('切り替え後の原稿一覧は空になります。');
      }
      if (selectedAction === 'migrate' && targetInfo.overlapping_count > 0) {
        warnings.push(`重複する ${targetInfo.overlapping_count} 件は切替先の内容を優先します。`);
      }

      warningsEl.replaceChildren(...warnings.map((message) => {
        const warning = document.createElement('div');
        warning.className = 'data-dir-warning';
        warning.textContent = message;
        return warning;
      }));
    }

    function renderSelection() {
      (Object.entries(actionButtons) as [DataDirSwitchAction, HTMLButtonElement][]).forEach(([action, button]) => {
        const isSelected = selectedAction === action;
        button.classList.toggle('selected', isSelected);
        button.setAttribute('aria-pressed', String(isSelected));
      });
      renderNotice();
      confirmBtn.disabled = false;
    }

    renderSelection();
    overlay.style.display = 'flex';

    function cleanup(result: DataDirSwitchAction | null) {
      overlay.style.display = 'none';
      migrateBtn.removeEventListener('click', onChooseMigrate);
      switchOnlyBtn.removeEventListener('click', onChooseSwitchOnly);
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      closeBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onBg);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function selectAction(action: DataDirSwitchAction) {
      if (selectedAction === action) return;
      selectedAction = action;
      renderSelection();
    }
    function onChooseMigrate() { selectAction('migrate'); }
    function onChooseSwitchOnly() { selectAction('switch-only'); }
    function onConfirm() {
      cleanup(selectedAction);
    }
    function onCancel() { cleanup(null); }
    function onBg(e: MouseEvent) { if (e.target === overlay) onCancel(); }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter' && selectedAction) onConfirm();
    }

    migrateBtn.addEventListener('click', onChooseMigrate);
    switchOnlyBtn.addEventListener('click', onChooseSwitchOnly);
    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
    closeBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onBg);
    document.addEventListener('keydown', onKey);
  });
}

function normalizeDirPath(path: string): string {
  const normalized = path.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  return /^[a-z]:/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

// ===== Notification =====
function showNotification(msg: string, options: { dismissOnInput?: boolean } = {}) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);'
    + 'background:rgba(30,30,30,0.85);color:#fff;padding:10px 24px;border-radius:8px;'
    + 'font-size:13px;font-family:"游ゴシック","Yu Gothic","メイリオ",Meiryo,sans-serif;'
    + 'z-index:3000;pointer-events:none;transition:opacity 0.3s;';
  el.textContent = msg;
  activeNotification?.dismiss();
  document.body.appendChild(el);
  let closed = false;
  let fadeTimer = window.setTimeout(() => { el.style.opacity = '0'; }, 1200);
  let removeTimer = window.setTimeout(() => {
    if (el.parentNode) document.body.removeChild(el);
    if (activeNotification?.dismiss === dismiss) activeNotification = null;
  }, 1600);
  function dismiss() {
    if (closed) return;
    closed = true;
    window.clearTimeout(fadeTimer);
    window.clearTimeout(removeTimer);
    el.style.opacity = '0';
    removeTimer = window.setTimeout(() => {
      if (el.parentNode) document.body.removeChild(el);
      if (activeNotification?.dismiss === dismiss) activeNotification = null;
    }, 300);
  }
  activeNotification = {
    dismiss,
    dismissOnInput: options.dismissOnInput ?? false,
  };
}

function dismissInputNotification() {
  if (activeNotification?.dismissOnInput) {
    activeNotification.dismiss();
  }
}

// ===== Preview Side Panel =====
let previewPanel: HTMLElement;
let previewTitleEl: HTMLElement;
let previewTextEl: HTMLTextAreaElement;
let previewCopyBtn: HTMLElement;
let previewVisible = false;
let previewDirty = false;

function formatBodyAsLines(body: string): string {
  const units = textToUnits(body);
  const flow = flowToGrid(units);
  const { grid, maxOutputCol } = flow;

  if (units.length === 0) return "";

  const lines: string[] = [];
  for (let c = 0; c <= maxOutputCol; c++) {
    let lineStr = "";
    const start = usableStart(c);
    const end = usableEnd(c);
    for (let r = start; r < end; r++) {
      const ui = grid[c][r];
      if (ui !== null) {
        const u = units[ui];
        if (u.type !== 'newline') lineStr += u.text;
      }
    }
    lines.push(lineStr);
  }
  return lines.join('\n');
}

function getFormattedPreviewText(): string {
  const { units, flow } = getUnitsAndFlow();
  const { grid, maxOutputCol } = flow;

  if (units.length === 0) return "";

  let lines: string[] = [];
  for (let c = 0; c <= maxOutputCol; c++) {
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

  return lines.join('\n');
}

function togglePreview(title: string) {
  if (previewVisible) { hidePreview(); return; }
  previewTitleEl.textContent = title;
  previewTextEl.value = getFormattedPreviewText();
  previewPanel.style.display = 'flex';
  previewVisible = true;
  previewDirty = false;
  scheduleLayoutRefresh();
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
  scheduleLayoutRefresh();
}

function getFileEntryPreviewTitle(file: FileEntry) {
  return file.custom_title ? file.title : deriveTitle(file.body);
}

function getFileEntryPreviewText(file: FileEntry) {
  try {
    const formatted = formatBodyAsLines(file.body);
    if (formatted || !file.body) return formatted;
  } catch {}
  return file.body;
}

function showFileManagerPreview(file: FileEntry) {
  fileManagerPreviewId = file.id;
  fmPreviewTitleEl.textContent = getFileEntryPreviewTitle(file);
  fmPreviewTextEl.value = getFileEntryPreviewText(file);
  fmPreviewCopyBtn.textContent = 'コピー';
  fmContentEl.classList.add('has-preview');
  fmPreviewPanelEl.style.display = 'flex';
  updateFileManagerPreviewButtonState();
}

function hideFileManagerPreview() {
  fileManagerPreviewId = null;
  fmContentEl.classList.remove('has-preview');
  fmPreviewPanelEl.style.display = 'none';
  updateFileManagerPreviewButtonState();
}

function toggleFileManagerPreview(file: FileEntry) {
  if (fileManagerPreviewId === file.id) {
    hideFileManagerPreview();
  } else {
    showFileManagerPreview(file);
  }
}

function updateFileManagerPreviewButtonState() {
  const buttons = fmListEl.querySelectorAll('.act-preview');
  buttons.forEach((button) => {
    const el = button as HTMLButtonElement;
    const isActive = fileManagerPreviewId !== null && el.dataset.fileId === fileManagerPreviewId;
    el.classList.toggle('active', isActive);
    el.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

// ===== Title helper =====
function deriveTitle(body: string): string {
  const nl = body.indexOf('\n');
  const firstLine = (nl >= 0 ? body.slice(0, nl) : body).trim();
  return firstLine ? firstLine.slice(0, 20) : '無題';
}

function getDisplayedTitle() {
  return currentCustomTitle ? currentTitle : deriveTitle(textarea.value);
}

function updateTitleDisplay() {
  const nextTitle = getDisplayedTitle();
  editorTitleEl.textContent = nextTitle;
  if (!isEditingTitleInline) editorTitleInputEl.value = nextTitle;
}

function startInlineTitleEdit() {
  if (!currentFileId || isEditingTitleInline) return;
  isEditingTitleInline = true;
  const nextTitle = getDisplayedTitle();
  editorTitleInputEl.value = nextTitle;
  editorTitleEl.style.display = 'none';
  editorTitleInputEl.style.display = 'block';
  setTimeout(() => {
    editorTitleInputEl.focus();
    editorTitleInputEl.select();
  }, 0);
}

function stopInlineTitleEdit() {
  isEditingTitleInline = false;
  editorTitleInputEl.style.display = 'none';
  editorTitleEl.style.display = 'inline-block';
  updateTitleDisplay();
}

// ============================================================
//  FILE MANAGER
// ============================================================
function showFileManager() {
  if (isEditingTitleInline) stopInlineTitleEdit();
  fileManagerEl.style.display = 'flex';
  editorScreenEl.style.display = 'none';
  setImeAnchorReady(false);
  refreshFileList();
}

async function refreshFileList() {
  const files: FileEntry[] = await invoke('list_files');
  fmListEl.innerHTML = '';
  if (files.length === 0) {
    hideFileManagerPreview();
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
        <div class="fm-item-title-row">
          <div class="fm-item-title">${escHtml(f.title)}</div>
          <button class="fm-item-rename" type="button">変更</button>
        </div>
        <div class="fm-item-meta">${dateStr}　${f.char_count} / ${BASE_MAX} 文字</div>
        <div class="fm-item-preview">${escHtml(preview)}</div>
      </div>
      <div class="fm-item-actions">
        <button class="act-preview" type="button" data-file-id="${escHtml(f.id)}" aria-pressed="false">プレビュー</button>
        <button class="act-export">書出</button>
        <button class="act-delete danger">削除</button>
      </div>`;
    item.querySelector('.fm-item-info')!.addEventListener('click', () => openFile(f.id));
    item.querySelector('.fm-item-rename')!.addEventListener('click', (e) => {
      e.stopPropagation();
      renameFile(f.id, f.title, { refreshList: true });
    });
    item.querySelector('.act-preview')!.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFileManagerPreview(f);
    });
    item.querySelector('.act-export')!.addEventListener('click', (e) => { e.stopPropagation(); exportFileFromList(f); });
    item.querySelector('.act-delete')!.addEventListener('click', (e) => { e.stopPropagation(); deleteFile(f.id, f.title); });
    fmListEl.appendChild(item);
  }

  if (fileManagerPreviewId) {
    const previewFile = files.find((file) => file.id === fileManagerPreviewId);
    if (previewFile) showFileManagerPreview(previewFile);
    else hideFileManagerPreview();
  } else {
    updateFileManagerPreviewButtonState();
  }
}

function escHtml(s: string) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function createNewFile() {
  const created: CreateFileResult = await invoke('create_file');
  handleHistoryStatus(created.history_status, 'create');
  openFile(created.id);
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
  const result: HistoryActionResult = await invoke('delete_file', { id });
  handleHistoryStatus(result.history_status, 'delete');
  showNotification('削除しました');
  refreshFileList();
}

async function exportFileFromList(f: FileEntry) {
  const path = await save({
    defaultPath: `${f.title}.txt`,
    filters: [{ name: 'テキストファイル', extensions: ['txt'] }],
  });
  if (!path) return;
  const content = formatBodyAsLines(f.body);
  await invoke('export_file_to', { dest: path, content });
  showNotification('書き出しました');
}

async function importFile(file: File) {
  const text = await file.text();
  const created: CreateFileResult = await invoke('create_file');
  handleHistoryStatus(created.history_status, 'create');
  const result = await persistFile(created.id, text, { mode: 'manual' });
  if (!result) return;
  showNotification('読み込みました');
  refreshFileList();
}

// ============================================================
//  EDITOR SCREEN
// ============================================================
function showEditor() {
  fileManagerEl.style.display = 'none';
  editorScreenEl.style.display = 'flex';
  if (isEditingTitleInline) stopInlineTitleEdit();
  updateTitleDisplay();
  updateSaveStatus();
  buildGrid();
  recalcSize();
  updateInlineControlState();
  render();
  setImeAnchorReady(true);
  syncHiddenInputPosition();
  textarea.focus({ preventScroll: true });
  scheduleLayoutRefresh();
}

async function saveCurrentFile() {
  if (!currentFileId) return;
  const result = await persistFile(currentFileId, textarea.value, { mode: 'manual' });
  if (!result) return;
  if (result.history_status === 'committed') showNotification('保存しました', { dismissOnInput: true });
}

async function applyTitleRename(id: string, title: string, newTitle: string, options: { refreshList?: boolean } = {}) {
  if (newTitle === title) return true;
  const result: HistoryActionResult = await invoke('rename_file', { id, title: newTitle });
  handleHistoryStatus(result.history_status, 'rename');
  if (currentFileId === id) {
    currentTitle = newTitle;
    currentCustomTitle = true;
    updateTitleDisplay();
  }
  if (options.refreshList) await refreshFileList();
  showNotification('名前を変更しました');
  return true;
}

async function renameFile(id: string, title: string, options: { refreshList?: boolean } = {}) {
  const newTitle = await customPrompt('新しいタイトル:', title);
  if (newTitle === null || newTitle === title) return;
  await applyTitleRename(id, title, newTitle, options);
}

async function renameCurrentFile() {
  if (!currentFileId) return;
  await renameFile(currentFileId, currentTitle);
}

async function commitInlineTitleEdit() {
  if (!currentFileId || !isEditingTitleInline) return;
  const previousTitle = getDisplayedTitle();
  const nextTitle = editorTitleInputEl.value.trim();
  if (!nextTitle || nextTitle === previousTitle) {
    stopInlineTitleEdit();
    return;
  }
  await applyTitleRename(currentFileId, previousTitle, nextTitle);
  stopInlineTitleEdit();
}

async function exportCurrentFile() {
  if (!currentFileId) return;
  if (isDirty) {
    const result = await persistFile(currentFileId, textarea.value, { mode: 'background' });
    if (!result) return;
  }
  const path = await save({
    defaultPath: `${currentTitle}.txt`,
    filters: [{ name: 'テキストファイル', extensions: ['txt'] }],
  });
  if (!path) return;
  const content = getFormattedPreviewText();
  await invoke('export_file_to', { dest: path, content });
  showNotification('書き出しました');
}

function updateSaveStatus() {
  saveStatusEl.classList.remove('pending');
  if (historyPending) {
    saveStatusEl.textContent = '履歴未反映';
    saveStatusEl.style.color = '#c57b38';
    saveStatusEl.classList.add('pending');
    return;
  }
  saveStatusEl.textContent = isDirty ? '未保存' : '保存済';
  saveStatusEl.style.color = isDirty ? '#d48a4a' : '#aaa';
}

function scheduleAutoSave() {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = window.setTimeout(async () => {
    if (currentFileId && isDirty) {
      showSaveStatus('saving');
      const entry = await persistFile(currentFileId, textarea.value, { mode: 'background' });
      if (entry) showSaveStatus('saved');
    }
  }, 1000);
}

function showSaveStatus(state: 'saving' | 'saved' | 'idle' | 'error') {
  if (!saveStatusEl) return;
  if (saveStatusTimer) {
    clearTimeout(saveStatusTimer);
    saveStatusTimer = null;
  }
  saveStatusEl.classList.remove('saving', 'saved', 'error');
  if (state === 'saving') {
    saveStatusEl.textContent = '保存中…';
    saveStatusEl.classList.add('saving');
  } else if (state === 'saved') {
    updateSaveStatus();
    saveStatusEl.classList.add('saved');
    saveStatusTimer = window.setTimeout(() => {
      if (!isDirty && !historyPending) {
        saveStatusEl.classList.remove('saved');
      }
    }, 2000);
  } else if (state === 'error') {
    saveStatusEl.textContent = '保存失敗';
    saveStatusEl.classList.add('error');
  } else {
    updateSaveStatus();
  }
}

function clearSavedStatusOnInput() {
  if (saveStatusEl.classList.contains('saved')) {
    showSaveStatus('idle');
  }
}

function markDirty() {
  if (!isDirty) { isDirty = true; updateSaveStatus(); }
  scheduleAutoSave();
}

function handleHistoryStatus(status: HistoryStatus, source: 'save' | 'create' | 'rename' | 'delete' | 'restore' | 'startup' | 'background') {
  const wasPending = historyPending;
  historyPending = status === 'pending';
  updateSaveStatus();
  if (status === 'recovered') {
    showNotification(source === 'startup' ? '未反映の履歴を自動回復しました' : '履歴を自動回復しました');
    return;
  }
  if (status === 'pending' && (!wasPending || source === 'save' || source === 'create' || source === 'rename' || source === 'restore')) {
    showNotification('原稿は保存しました。履歴は次回起動時に自動回復します');
  }
}

function applySavedEntry(entry: FileEntry) {
  currentTitle = entry.title;
  currentCustomTitle = entry.custom_title;
  isDirty = false;
  updateTitleDisplay();
  updateSaveStatus();
}

async function persistFile(
  id: string,
  body: string,
  options: { mode: 'manual' | 'background' },
): Promise<FileSaveResult | null> {
  try {
    const result: FileSaveResult = await invoke('save_file', { id, body });
    applySavedEntry(result.entry);
    handleHistoryStatus(result.history_status, options.mode === 'manual' ? 'save' : 'background');
    return result;
  } catch (error) {
    showSaveStatus('error');
    if (options.mode === 'manual') {
      await showModal(`保存に失敗しました: ${String(error)}`, false);
    } else {
      showNotification('保存に失敗しました');
    }
    return null;
  }
}

async function backToList() {
  if (currentFileId && isDirty) {
    const result = await persistFile(currentFileId, textarea.value, { mode: 'background' });
    if (!result) return;
  }
  currentFileId = null;
  hidePreview();
  showFileManager();
}

// ===== Responsive sizing =====
function getContentBoxSize(el: HTMLElement): { width: number; height: number } {
  const styles = window.getComputedStyle(el);
  const paddingX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
  const paddingY = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
  return {
    width: Math.max(0, el.clientWidth - paddingX),
    height: Math.max(0, el.clientHeight - paddingY),
  };
}

function getAutoCellSize() {
  if (!gridWrapperEl) return BASE_CELL_SIZE;
  const { width, height } = getContentBoxSize(gridWrapperEl);
  if (width <= 0 || height <= 0) return BASE_CELL_SIZE;

  const fitByWidth = Math.floor((width - BASE_GRID_CHROME) / BASE_COLS);
  const fitByHeight = Math.floor((height - 1) / ROWS);
  // Keep the whole manuscript visible even on tighter Windows/WebView layouts.
  const fitted = Math.min(fitByWidth, fitByHeight);
  if (!Number.isFinite(fitted) || fitted <= 0) return BASE_CELL_SIZE;

  return Math.max(1, Math.min(MAX_CELL_SIZE, fitted));
}

function recalcSize() {
  const autoCellSize = getAutoCellSize();
  const minCellSize = Math.min(MIN_CELL_SIZE, autoCellSize);
  const cellSize = Math.min(MAX_CELL_SIZE, Math.max(minCellSize, Math.round(autoCellSize * appSettings.viewZoom)));
  const fontSize = Math.max(7, Math.round(cellSize * appSettings.fontScale));
  const boostedTcy = Math.round(fontSize * appSettings.tcyScale);
  const maxTcy = Math.floor(cellSize * 0.9);
  const tcySize = Math.max(6, Math.min(maxTcy, boostedTcy));
  currentCellSize = cellSize;
  document.documentElement.style.setProperty('--cell', cellSize + 'px');
  document.documentElement.style.setProperty('--fs', fontSize + 'px');
  document.documentElement.style.setProperty('--tcy', tcySize + 'px');
}

function keepCursorCellInView() {
  if (!gridWrapperEl) return;
  const cell = cells[gridCursor.col]?.[gridCursor.row];
  if (!cell) return;
  // Let the browser resolve scroll-origin differences across platforms.
  cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function getCellViewportRect(col: number, row: number) {
  const cell = cells[col]?.[row];
  if (!cell) return null;
  const rect = cell.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    right: rect.right,
    bottom: rect.bottom,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getAxisDistance(start: number, end: number, point: number) {
  if (point < start) return start - point;
  if (point > end) return point - end;
  return 0;
}

function applyTextareaRect(rect: { left: number; top: number; width: number; height: number }) {
  textarea.style.left = `${Math.round(rect.left)}px`;
  textarea.style.top = `${Math.round(rect.top)}px`;
  textarea.style.width = `${Math.max(1, Math.round(rect.width))}px`;
  textarea.style.height = `${Math.max(1, Math.round(rect.height))}px`;
}

function setImeAnchorReady(active: boolean) {
  if (!isWindows) return;
  textarea.classList.toggle('ime-anchor-ready', active);
}

function syncHiddenInputPosition() {
  if (cursorSyncNeeded) syncFromRaw();
  if (isComposing) positionCompositionInput();
  else positionHiddenInput();
}

function setMousePointer(clientX: number, clientY: number) {
  mouseClientX = clientX;
  mouseClientY = clientY;
}

function getCellFromElement(el: HTMLElement | null): GridCell | null {
  if (!el) return null;
  const cell = el.closest('.cell') as HTMLElement | null;
  if (!cell) return null;
  const col = parseInt(cell.dataset.col ?? '', 10);
  const row = parseInt(cell.dataset.row ?? '', 10);
  if (!Number.isFinite(col) || !Number.isFinite(row)) return null;
  if (row < usableStart(col) || row >= usableEnd(col)) return null;
  return { col, row };
}

function getCellFromClientPoint(clientX: number, clientY: number): GridCell | null {
  const wrapperRect = gridWrapperEl.getBoundingClientRect();
  if (wrapperRect.width <= 0 || wrapperRect.height <= 0) return null;

  const x = clamp(clientX, wrapperRect.left + 1, wrapperRect.right - 1);
  const y = clamp(clientY, wrapperRect.top + 1, wrapperRect.bottom - 1);
  const pointed = getCellFromElement(document.elementFromPoint(x, y) as HTMLElement | null);
  if (pointed) return pointed;

  let bestCol = -1;
  let bestColDistance = Number.POSITIVE_INFINITY;
  for (let c = 0; c < totalCols; c++) {
    const sampleRow = usableStart(c);
    const sampleCell = cells[c]?.[sampleRow];
    if (!sampleCell) continue;
    const rect = sampleCell.getBoundingClientRect();
    const distance = getAxisDistance(rect.left, rect.right, x);
    if (distance < bestColDistance) {
      bestColDistance = distance;
      bestCol = c;
      if (distance === 0) break;
    }
  }
  if (bestCol < 0) return null;

  let bestRow = usableStart(bestCol);
  let bestRowDistance = Number.POSITIVE_INFINITY;
  for (let r = usableStart(bestCol); r < usableEnd(bestCol); r++) {
    const rect = cells[bestCol]?.[r]?.getBoundingClientRect();
    if (!rect) continue;
    const distance = getAxisDistance(rect.top, rect.bottom, y);
    if (distance < bestRowDistance) {
      bestRowDistance = distance;
      bestRow = r;
      if (distance === 0) break;
    }
  }
  return { col: bestCol, row: bestRow };
}

function updateMouseSelectionToCell(cr: GridCell) {
  if (mouseAnchorCell) {
    const isSame = cr.col === mouseAnchorCell.col && cr.row === mouseAnchorCell.row;
    if (isSame) {
      activePos = cellToNearestRaw(cr.col, cr.row);
      anchorPos = activePos;
    } else {
      const anchorStart = cellToNearestRaw(mouseAnchorCell.col, mouseAnchorCell.row);
      const anchorEnd = cellRawEnd(mouseAnchorCell.col, mouseAnchorCell.row);
      const activeStart = cellToNearestRaw(cr.col, cr.row);
      const activeEnd = cellRawEnd(cr.col, cr.row);
      if (activeStart < anchorStart) {
        anchorPos = anchorEnd;
        activePos = activeStart;
      } else {
        anchorPos = anchorStart;
        activePos = activeEnd;
      }
    }
  } else {
    activePos = cellToNearestRaw(cr.col, cr.row);
  }
  updateSelection();
  scheduleCursorSync();
  scheduleRender();
}

function stopSelectionAutoScroll() {
  if (!selectionAutoScrollRAF) return;
  cancelAnimationFrame(selectionAutoScrollRAF);
  selectionAutoScrollRAF = 0;
}

function stepSelectionAutoScroll() {
  if (!mouseIsDown) {
    selectionAutoScrollRAF = 0;
    return;
  }

  const wrapperRect = gridWrapperEl.getBoundingClientRect();
  const edge = Math.max(28, Math.round(currentCellSize * 1.15));
  const maxStep = Math.max(18, Math.round(currentCellSize * 0.85));
  let deltaX = 0;
  let deltaY = 0;

  if (mouseClientX < wrapperRect.left + edge) {
    deltaX = Math.min(maxStep, Math.ceil((wrapperRect.left + edge - mouseClientX) * 0.35));
  } else if (mouseClientX > wrapperRect.right - edge) {
    deltaX = -Math.min(maxStep, Math.ceil((mouseClientX - (wrapperRect.right - edge)) * 0.35));
  }

  if (mouseClientY < wrapperRect.top + edge) {
    deltaY = -Math.min(maxStep, Math.ceil((wrapperRect.top + edge - mouseClientY) * 0.35));
  } else if (mouseClientY > wrapperRect.bottom - edge) {
    deltaY = Math.min(maxStep, Math.ceil((mouseClientY - (wrapperRect.bottom - edge)) * 0.35));
  }

  if (deltaX !== 0 || deltaY !== 0) {
    const beforeLeft = gridWrapperEl.scrollLeft;
    const beforeTop = gridWrapperEl.scrollTop;
    gridWrapperEl.scrollBy({ left: deltaX, top: deltaY, behavior: 'auto' });
    if (gridWrapperEl.scrollLeft !== beforeLeft || gridWrapperEl.scrollTop !== beforeTop) {
      const cr = getCellFromClientPoint(mouseClientX, mouseClientY);
      if (cr) updateMouseSelectionToCell(cr);
    }
  }

  selectionAutoScrollRAF = requestAnimationFrame(stepSelectionAutoScroll);
}

function startSelectionAutoScroll() {
  if (selectionAutoScrollRAF) return;
  selectionAutoScrollRAF = requestAnimationFrame(stepSelectionAutoScroll);
}

function isLikelyMouseWheelInput(event: WheelEvent) {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (Math.abs(event.deltaY) < 0.5 || Math.abs(event.deltaX) > 0.5) return false;
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE || event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return true;

  const legacyEvent = event as WheelEvent & { wheelDeltaY?: number; wheelDeltaX?: number };
  const legacyDeltaY = typeof legacyEvent.wheelDeltaY === 'number' ? Math.abs(legacyEvent.wheelDeltaY) : 0;
  const legacyDeltaX = typeof legacyEvent.wheelDeltaX === 'number' ? Math.abs(legacyEvent.wheelDeltaX) : 0;
  if (legacyDeltaY > 0 && legacyDeltaX < 1 && legacyDeltaY % 120 === 0) return true;

  const absY = Math.abs(event.deltaY);
  if (absY < 40) return false;
  const rounded = Math.round(absY);
  return Math.abs(absY - rounded) < 0.01 && (rounded % 100 === 0 || rounded % 120 === 0);
}

function getWindowsImeDockRect(referenceRect: ReturnType<typeof getCellViewportRect>) {
  const wrapperRect = gridWrapperEl.getBoundingClientRect();
  const toolbarRect = document.getElementById('toolbar')?.getBoundingClientRect();
  const baseWidth = Math.max(22, Math.round((referenceRect?.width ?? currentCellSize) * 0.8));
  const desiredHeight = Math.max(Math.round((referenceRect?.height ?? currentCellSize) * 8), 180);
  const topMin = Math.max((toolbarRect?.bottom ?? 0) + 12, wrapperRect.top + 8);
  const height = Math.min(desiredHeight, Math.max((referenceRect?.height ?? currentCellSize) * 4, window.innerHeight - topMin - 24));
  const topMax = Math.max(topMin, window.innerHeight - height - 24);
  const top = clamp(referenceRect?.top ?? topMin, topMin, topMax);
  const preferredLeft = (referenceRect?.left ?? (wrapperRect.left + baseWidth + 20)) - baseWidth - 14;
  const leftMin = Math.max(12, wrapperRect.left + 8);
  const leftMax = Math.max(leftMin, window.innerWidth - baseWidth - 24);
  return {
    left: clamp(preferredLeft, leftMin, leftMax),
    top,
    width: baseWidth,
    height,
  };
}

function positionHiddenInput() {
  const rect = getCellViewportRect(gridCursor.col, gridCursor.row);
  if (!rect) return;
  if (isWindows) {
    applyTextareaRect(getWindowsImeDockRect(rect));
    return;
  }
  applyTextareaRect(rect);
}

// ===== Grid DOM =====
function buildGrid() {
  gridEl.textContent = '';
  cells = [];
  prevCellStates = [];
  const fragment = document.createDocumentFragment();
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
      colDiv.appendChild(cellDiv);
      cells[c][r] = cellDiv;
      prevCellStates[c][r] = { text: '', type: 'empty', flags: 0 };
    }
    fragment.appendChild(colDiv);
  }
  gridEl.appendChild(fragment);
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
  const newlineMarkerSet = new Set<number>();
  let col = 0, row = usableStart(0);
  let neededCols = BASE_COLS;
  let displayCount = 0;
  function ensure(c: number) {
    while (grid.length <= c) grid.push(new Array(ROWS).fill(null));
    if (c >= USABLE_START_CACHE.length) ensureColCache(c);
  }
  for (let ui = 0; ui < units.length; ui++) {
    const u = units[ui];
    if (u.type === 'newline') {
      unitPos.push({ col, row: -1 });
      if (row < usableEnd(col)) {
        newlineMarkers.push({ col, row });
        newlineMarkerSet.add(col * ROWS + row);
      }
      col++;
      row = usableStart(col);
      neededCols = Math.max(neededCols, col + 1);
      continue;
    }
    if (row >= usableEnd(col)) { col++; row = usableStart(col); }
    ensure(col);
    grid[col][row] = ui;
    unitPos.push({ col, row });
    displayCount++;
    row++;
    neededCols = Math.max(neededCols, col + 1);
  }
  if (row >= usableEnd(col)) {
    col++;
    row = usableStart(col);
    neededCols = Math.max(neededCols, col + 1);
  }
  while (grid.length < BASE_COLS) grid.push(new Array(ROWS).fill(null));
  let maxOutputCol = 0;
  if (units.length > 0) {
    const lastIndex = units.length - 1;
    maxOutputCol = unitPos[lastIndex]?.col ?? 0;
    if (units[lastIndex].type === 'newline') maxOutputCol++;
  }
  return {
    grid,
    unitPos,
    nextCol: col,
    nextRow: row,
    neededCols: Math.max(neededCols, grid.length),
    newlineMarkers,
    newlineMarkerSet,
    displayCount,
    maxOutputCol,
  };
}

// ===== Cursor Mapping =====
function rawToCell(rawPos: number, units: Unit[], flow: FlowResult): GridCell {
  const { unitPos, nextCol, nextRow, newlineMarkers } = flow;
  if (units.length === 0) return { col: 0, row: usableStart(0) };
  const unitIndex = findUnitIndexAtRaw(rawPos, units);
  if (unitIndex >= 0 && unitIndex < units.length) {
    const u = units[unitIndex];
    if (u.type === 'newline') {
      const nlCol = unitPos[unitIndex].col;
      for (let mi = 0; mi < newlineMarkers.length; mi++) {
        if (newlineMarkers[mi].col === nlCol) return newlineMarkers[mi];
      }
      return { col: nlCol, row: usableStart(nlCol) };
    }
    return unitPos[unitIndex];
  }
  return { col: nextCol, row: nextRow };
}

function findUnitIndexAtRaw(rawPos: number, units: Unit[]): number {
  let low = 0;
  let high = units.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const unit = units[mid];
    if (rawPos < unit.rawStart) {
      high = mid - 1;
    } else if (rawPos >= unit.rawStart + unit.rawLen) {
      low = mid + 1;
    } else {
      return mid;
    }
  }
  return low;
}

// ===== Sync =====
function syncFromRaw(units?: Unit[], flow?: FlowResult) {
  const resolved = units && flow ? { units, flow } : getUnitsAndFlow();
  const { units: resolvedUnits, flow: resolvedFlow } = resolved;
  cursorSyncNeeded = false;
  const ac = rawToCell(activePos, resolvedUnits, resolvedFlow);
  if (ac) gridCursor = { col: ac.col, row: ac.row };
}

function scheduleCursorSync() {
  cursorSyncNeeded = true;
}

function updateSelection() {
  textarea.selectionStart = Math.min(anchorPos, activePos);
  textarea.selectionEnd = Math.max(anchorPos, activePos);
}

// ===== Movement =====
function moveUnit(delta: number, extend: boolean) {
  const stops = getRawStops();
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

function cellRawEnd(col: number, row: number): number {
  const { units, flow } = getUnitsAndFlow();
  if (col < flow.grid.length && flow.grid[col][row] !== null) {
    const u = units[flow.grid[col][row]!];
    return u.rawStart + u.rawLen;
  }
  return cellToNearestRaw(col, row);
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
  const { grid, neededCols, newlineMarkerSet, displayCount } = flow;

  if (cursorSyncNeeded) syncFromRaw(units, flow);

  if (neededCols !== totalCols) { totalCols = neededCols; buildGrid(); recalcSize(); }

  const text = textarea.value;
  const compEnd = isComposing && compStart >= 0 ? text.length - compSuffixLen : -1;
  const selMin = Math.min(anchorPos, activePos);
  const selMax = Math.max(anchorPos, activePos);
  const hasSelection = selMin !== selMax;
  const visualCursor = (!hasSelection && isComposing && compEnd >= 0)
    ? rawToCell(compEnd, units, flow)
    : gridCursor;

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
        if (u.type === 'char' && PUNCT_SET.has(u.text)) flags |= FLAG_PUNCT;
        if (u.type === 'char' && ROTATE_SET.has(u.text)) flags |= FLAG_ROT;
        if (u.type === 'char' && KAKKO_OPEN_SET.has(u.text)) flags |= FLAG_KAKKO_OPEN;
        if (u.type === 'char' && KAKKO_CLOSE_SET.has(u.text)) flags |= FLAG_KAKKO_CLOSE;
      }

      // Newline marker
      const isNl = newlineMarkerSet.has(c * ROWS + r);
      if (isNl) { newType = 'nl-mark'; newText = '↵'; }

      // Cursor
      if (!hasSelection && c === visualCursor.col && r === visualCursor.row) flags |= FLAG_CURSOR;

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
      } else if (newType === 'char') {
        appendCharContent(cell, newText, flags);
      } else if (newType === 'nl-mark') {
        // May have char content + newline mark overlay
        if (ui !== null && units[ui]) {
          const u = units[ui];
          if (u.type === 'tcy') {
            cell.textContent = '';
            const span = document.createElement('span');
            span.className = 'tcy'; span.textContent = u.text;
            cell.appendChild(span);
          } else if (u.type === 'char') {
            appendCharContent(cell, u.text, flags);
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
      cell.classList.toggle('punct', !!(flags & FLAG_PUNCT));
      cell.classList.toggle('kakko-open', !!(flags & FLAG_KAKKO_OPEN));
      cell.classList.toggle('kakko-close', !!(flags & FLAG_KAKKO_CLOSE));
    }
  }

  let s = displayCount + ' / ' + BASE_MAX + ' 文字';
  const charInCol = visualCursor.row - usableStart(visualCursor.col) + 1;
  s += '　第' + (visualCursor.col + 1) + '行 第' + charInCol + '字';
  if (displayCount > BASE_MAX) s += '　<span class="overflow-warn">超過 +' + (displayCount - BASE_MAX) + '</span>';
  statusText.innerHTML = s;
  if (!hasSelection && !preserveViewportWhileRendering) {
    const prevCursor = gridCursor;
    gridCursor = visualCursor;
    keepCursorCellInView();
    gridCursor = prevCursor;
  }

  // IME変換中はtextarea位置を更新しない（compositionstartで固定済み）
  // 変換中に位置を動かすとIMEがリセットされ候補が消える

  if (!isComposing) {
    positionHiddenInput();
  }
}

// ===== Event Handlers =====
function cellFromEvent(e: MouseEvent): GridCell | null {
  return getCellFromElement(e.target as HTMLElement | null);
}

function onCellMouseDown(e: MouseEvent) {
  const cr = cellFromEvent(e);
  if (!cr) {
    setImeAnchorReady(true);
    textarea.focus({ preventScroll: true });
    return;
  }
  e.preventDefault();
  activePos = cellToNearestRaw(cr.col, cr.row);
  if (!e.shiftKey) {
    anchorPos = activePos;
    mouseAnchorCell = cr;
  }
  mouseIsDown = true;
  setMousePointer(e.clientX, e.clientY);
  startSelectionAutoScroll();
  updateSelection();
  syncFromRaw();
  setImeAnchorReady(true);
  positionHiddenInput();
  textarea.focus({ preventScroll: true });
  scheduleRender();
}

function resetCursor() {
  anchorPos = activePos = 0;
  textarea.selectionStart = textarea.selectionEnd = 0;
  syncFromRaw();
}

function positionCompositionInput() {
  const rect = getCellViewportRect(compCellCol, compCellRow);
  if (!rect) return;
  if (isWindows) {
    applyTextareaRect(getWindowsImeDockRect(rect));
    return;
  }
  const toolbarRect = document.getElementById('toolbar')?.getBoundingClientRect();
  const top = Math.max((toolbarRect?.bottom ?? 0) + 12, rect.top);

  const inputWidth = 220;
  const inputHeight = rect.height * 2;
  const anchorGap = 24;
  const anchorRight = Math.min(window.innerWidth - 24, rect.right + anchorGap);
  applyTextareaRect({
    left: anchorRight - inputWidth,
    top,
    width: inputWidth,
    height: inputHeight,
  });
}

function setCompositionAnchorActive(active: boolean) {
  textarea.classList.toggle('ime-anchor-active', active);
}

// ============================================================
//  INIT
// ============================================================
window.addEventListener('DOMContentLoaded', async () => {
  fileManagerEl = document.getElementById('file-manager')!;
  editorScreenEl = document.getElementById('editor-screen')!;
  fmContentEl = document.getElementById('fm-content')!;
  fmListEl = document.getElementById('fm-list')!;
  fmPreviewPanelEl = document.getElementById('fm-preview-panel')!;
  fmPreviewTitleEl = document.getElementById('fm-preview-title')!;
  fmPreviewTextEl = document.getElementById('fm-preview-text') as HTMLTextAreaElement;
  fmPreviewCopyBtn = document.getElementById('fm-preview-copy') as HTMLButtonElement;
  gridWrapperEl = document.getElementById('grid-wrapper')!;
  gridEl = document.getElementById('grid')!;
  textarea = document.getElementById('hidden-input') as HTMLTextAreaElement;
  statusText = document.getElementById('status-text')!;
  editorTitleEl = document.getElementById('editor-title') as HTMLButtonElement;
  editorTitleInputEl = document.getElementById('editor-title-input') as HTMLInputElement;
  saveStatusEl = document.getElementById('save-status')!;
  fmFileInput = document.getElementById('fm-file-input') as HTMLInputElement;
  viewZoomValueEl = document.getElementById('view-zoom-value')!;
  fontSizeValueEl = document.getElementById('font-size-value')!;
  fontWeightValueEl = document.getElementById('font-weight-value')!;
  gridSolidBtnEl = document.getElementById('btn-grid-solid') as HTMLButtonElement;
  gridDashedBtnEl = document.getElementById('btn-grid-dashed') as HTMLButtonElement;

  // Preview panel
  previewPanel = document.getElementById('preview-panel')!;
  previewTitleEl = document.getElementById('preview-title')!;
  previewTextEl = document.getElementById('preview-text') as HTMLTextAreaElement;
  previewCopyBtn = document.getElementById('btn-preview-copy')!;
  document.getElementById('btn-preview-close')!.addEventListener('click', hidePreview);
  previewCopyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(previewTextEl.value).then(() => {
      previewCopyBtn.textContent = 'コピー済';
      setTimeout(() => { previewCopyBtn.textContent = 'コピー'; }, 1200);
    });
  });

  // File manager
  document.getElementById('fm-new')!.addEventListener('click', createNewFile);
  document.getElementById('fm-import')!.addEventListener('click', () => fmFileInput.click());
  document.getElementById('fm-preview-close')!.addEventListener('click', hideFileManagerPreview);
  fmPreviewCopyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(fmPreviewTextEl.value).then(() => {
      fmPreviewCopyBtn.textContent = 'コピー済';
      setTimeout(() => { fmPreviewCopyBtn.textContent = 'コピー'; }, 1200);
    });
  });
  fmFileInput.addEventListener('change', () => {
    const file = fmFileInput.files?.[0];
    if (file) importFile(file);
    fmFileInput.value = '';
  });

  // Editor toolbar
  document.getElementById('btn-back')!.addEventListener('click', backToList);
  document.getElementById('btn-save')!.addEventListener('click', saveCurrentFile);
  document.getElementById('btn-rename')!.addEventListener('click', renameCurrentFile);
  editorTitleEl.addEventListener('click', startInlineTitleEdit);
  editorTitleInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitInlineTitleEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      stopInlineTitleEdit();
    }
  });
  editorTitleInputEl.addEventListener('blur', () => {
    if (isEditingTitleInline) commitInlineTitleEdit();
  });
  document.getElementById('btn-export')!.addEventListener('click', exportCurrentFile);
  document.getElementById('btn-preview')!.addEventListener('click', () => {
    const title = currentCustomTitle ? currentTitle : deriveTitle(textarea.value);
    togglePreview(title);
  });
  document.getElementById('btn-history')!.addEventListener('click', openHistory);
  bindInlineControl('btn-zoom-smaller', () => stepViewZoom(-1));
  bindInlineControl('btn-zoom-larger', () => stepViewZoom(1));
  gridEl.addEventListener('mousedown', onCellMouseDown);
  bindInlineControl('btn-font-smaller', () => stepFontScale(-1));
  bindInlineControl('btn-font-larger', () => stepFontScale(1));
  bindInlineControl('btn-weight-lighter', () => stepFontWeight(-1));
  bindInlineControl('btn-weight-heavier', () => stepFontWeight(1));
  bindInlineControl('btn-grid-solid', () => setGridStyle('solid'));
  bindInlineControl('btn-grid-dashed', () => setGridStyle('dashed'));
  updateInlineControlState();

  // IME composition
  textarea.addEventListener('focus', () => {
    setImeAnchorReady(true);
    if (!isComposing) syncHiddenInputPosition();
  });
  textarea.addEventListener('blur', () => {
    if (!isComposing) setImeAnchorReady(false);
  });
  textarea.addEventListener('compositionstart', () => {
    dismissInputNotification();
    isComposing = true;
    setImeAnchorReady(true);
    setCompositionAnchorActive(true);
    clearSavedStatusOnInput();
    if (cursorSyncNeeded) syncFromRaw();
    compStart = textarea.selectionStart;
    compSuffixLen = textarea.value.length - textarea.selectionEnd;
    compCellCol = gridCursor.col;
    compCellRow = gridCursor.row;
    positionCompositionInput();
  });
  textarea.addEventListener('input', () => {
    dismissInputNotification();
    clearSavedStatusOnInput();
    invalidateCache();
    anchorPos = activePos = textarea.selectionStart;
    scheduleCursorSync();
    if (!isComposing) {
      markDirty();
      updateTitleDisplay();
      markPreviewDirty();
    }
    scheduleRender();
  });
  textarea.addEventListener('compositionend', () => {
    dismissInputNotification();
    isComposing = false; compStart = -1; compSuffixLen = 0; compCellCol = -1; compCellRow = -1;
    setCompositionAnchorActive(false);
    setImeAnchorReady(document.activeElement === textarea);
    invalidateCache();
    anchorPos = activePos = textarea.selectionStart;
    scheduleCursorSync();
    markDirty();
    updateTitleDisplay();
    markPreviewDirty();
    flushPreview();
    scheduleRender();
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
    setMousePointer(e.clientX, e.clientY);
    const cr = getCellFromClientPoint(e.clientX, e.clientY);
    if (!cr) return;
    updateMouseSelectionToCell(cr);
  });
  document.addEventListener('mouseup', () => {
    mouseIsDown = false;
    mouseAnchorCell = null;
    stopSelectionAutoScroll();
  });
  document.addEventListener('mousedown', (e) => {
    if (editorScreenEl.style.display !== 'none' && !(e.target as HTMLElement).closest('#toolbar') && (e.target as HTMLElement).tagName !== 'INPUT' && !(e.target as HTMLElement).closest('#preview-panel'))
      setTimeout(() => textarea.focus({ preventScroll: true }), 0);
  });

  window.addEventListener('resize', () => {
    if (editorScreenEl.style.display !== 'none') scheduleLayoutRefresh();
  });
  window.visualViewport?.addEventListener('resize', () => {
    if (editorScreenEl.style.display !== 'none') scheduleLayoutRefresh();
  });
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(() => {
      if (editorScreenEl.style.display !== 'none') scheduleLayoutRefresh();
    });
    observer.observe(gridWrapperEl);
  }
  gridWrapperEl.addEventListener('scroll', () => {
    if (editorScreenEl.style.display === 'none' || isComposing) return;
    syncHiddenInputPosition();
  }, { passive: true });
  gridWrapperEl.addEventListener('wheel', (e) => {
    if (editorScreenEl.style.display === 'none' || !isLikelyMouseWheelInput(e)) return;

    const targetAxis = e.shiftKey ? 'top' : 'left';
    const before = targetAxis === 'left' ? gridWrapperEl.scrollLeft : gridWrapperEl.scrollTop;
    gridWrapperEl.scrollBy({
      left: e.shiftKey ? 0 : e.deltaY,
      top: e.shiftKey ? e.deltaY : 0,
      behavior: 'auto',
    });
    const after = targetAxis === 'left' ? gridWrapperEl.scrollLeft : gridWrapperEl.scrollTop;
    if (after !== before) e.preventDefault();
  }, { passive: false });

  // Periodic preview flush (debounced, not per-keystroke)
  setInterval(() => { if (previewDirty) flushPreview(); }, 300);

  // Focus/blur auto-save
  window.addEventListener('blur', async () => {
    if (currentFileId && isDirty) {
      showSaveStatus('saving');
      const result = await persistFile(currentFileId, textarea.value, { mode: 'background' });
      if (result) showSaveStatus('saved');
    }
  });

  // Periodic dirty check (every 30s)
  setInterval(async () => {
    if (currentFileId && isDirty) {
      showSaveStatus('saving');
      const result = await persistFile(currentFileId, textarea.value, { mode: 'background' });
      if (result) showSaveStatus('saved');
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
    const result: FileSaveResult = await invoke('git_restore', { id: currentFileId, commitHash: historySelectedHash });
    handleHistoryStatus(result.history_status, 'restore');
    textarea.value = result.entry.body;
    currentTitle = result.entry.title;
    currentCustomTitle = result.entry.custom_title;
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
      const result = await persistFile(currentFileId, textarea.value, { mode: 'background' });
      if (!result) return;
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
  const inputSettingTcyScale = document.getElementById('setting-tcy-scale') as HTMLInputElement;
  const previewCharBtn = document.getElementById('settings-preview-char')!;
  const previewTcyBtn = document.getElementById('settings-preview-tcy')!;
  const cursorTopBtn = document.getElementById('setting-cursor-top')!;
  const cursorBottomBtn = document.getElementById('setting-cursor-bottom')!;
  const cursorLeftBtn = document.getElementById('setting-cursor-left')!;
  const cursorRightBtn = document.getElementById('setting-cursor-right')!;

  btnSettings.addEventListener('click', openSettings);
  btnSettingsClose.addEventListener('click', closeSettings);
  settingsOverlay.addEventListener('click', (e) => {
    if (e.target === settingsOverlay) closeSettings();
  });
  inputSettingTcyScale.addEventListener('input', updateSettingsPreview);
  previewCharBtn.addEventListener('click', () => {
    settingsPreviewMode = 'char';
    updateSettingsPreview();
  });
  previewTcyBtn.addEventListener('click', () => {
    settingsPreviewMode = 'tcy';
    updateSettingsPreview();
  });
  cursorTopBtn.addEventListener('click', () => {
    settingsCursorPreviewPosition = 'top';
    updateSettingsPreview();
  });
  cursorBottomBtn.addEventListener('click', () => {
    settingsCursorPreviewPosition = 'bottom';
    updateSettingsPreview();
  });
  cursorLeftBtn.addEventListener('click', () => {
    settingsCursorPreviewPosition = 'left';
    updateSettingsPreview();
  });
  cursorRightBtn.addEventListener('click', () => {
    settingsCursorPreviewPosition = 'right';
    updateSettingsPreview();
  });
  btnSettingsSave.addEventListener('click', () => {
    appSettings.kinsokuHead = inputSettingHead.value;
    appSettings.kinsokuTail = inputSettingTail.value;
    appSettings.kinsokuColorHex = inputSettingColor.value;
    appSettings.tcyScale = (parseInt(inputSettingTcyScale.value, 10) || 104) / 100;
    appSettings.cursorPosition = settingsCursorPreviewPosition;

    persistDisplaySettings();
    applySettings(appSettings);
    recalcSize();
    updateInlineControlState();
    
    // Refresh the view
    invalidateCache();
    syncFromRaw();
    render();
    if (previewVisible) flushPreview();
    
    closeSettings();
    showNotification('設定を保存しました');
  });

  function openSettings() {
    inputSettingHead.value = appSettings.kinsokuHead;
    inputSettingTail.value = appSettings.kinsokuTail;
    inputSettingColor.value = appSettings.kinsokuColorHex;
    inputSettingTcyScale.value = String(Math.round(appSettings.tcyScale * 100));
    settingsCursorPreviewPosition = appSettings.cursorPosition;
    settingsPreviewMode = 'tcy';
    updateSettingsPreview();
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
    fmDatadirPath.setAttribute('title', dir);
  }

  async function chooseFolder(): Promise<string | null> {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === 'string') return selected;
    return null;
  }

  async function recoverHistoryOnLaunch() {
    try {
      const result: HistoryRecoveryResult = await invoke('recover_history');
      if (result.recovered) {
        handleHistoryStatus('recovered', 'startup');
      }
    } catch {
      // Keep the app usable even if recovery check itself fails.
    }
  }

  document.getElementById('fm-datadir-change')!.addEventListener('click', async () => {
    const dir = await chooseFolder();
    if (!dir) return;
    const currentDir: string = await invoke('get_data_dir');
    if (normalizeDirPath(dir) === normalizeDirPath(currentDir)) return;
    const targetInfo: DataDirInspection = await invoke('inspect_data_dir', { path: dir, currentPath: currentDir });
    const action = await showDataDirSwitchDialog(currentDir, dir, targetInfo);
    if (!action) return;
    const migrateExisting = action === 'migrate';
    try {
      await invoke('switch_data_dir', { path: dir, migrateExisting });
      await recoverHistoryOnLaunch();
      await updateDataDirDisplay();
      await refreshFileList();
      showNotification(migrateExisting ? '保存先を変更して原稿を引き継ぎました' : '保存先を変更しました');
    } catch (error) {
      await showModal(`保存先の切り替えに失敗しました: ${String(error)}`, false);
    }
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
      await recoverHistoryOnLaunch();
      await updateDataDirDisplay();
      showFileManager();
    });

    document.getElementById('setup-choose')!.addEventListener('click', async () => {
      const dir = await chooseFolder();
      if (!dir) return;
      await invoke('set_data_dir', { path: dir });
      setupScreen.style.display = 'none';
      await recoverHistoryOnLaunch();
      await updateDataDirDisplay();
      showFileManager();
    });
  } else {
    await recoverHistoryOnLaunch();
    await updateDataDirDisplay();
    showFileManager();
  }
});
