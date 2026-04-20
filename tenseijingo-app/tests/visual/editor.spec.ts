import { expect, test, type Page } from '@playwright/test';

type MockFile = {
  id: string;
  title: string;
  body: string;
  updated_at: string;
  char_count: number;
  custom_title: boolean;
};

type BootstrapOptions = {
  files?: MockFile[];
  firstLaunch?: boolean;
  dialogSelections?: Array<string | null>;
  platformOverride?: 'windows' | 'macos' | 'linux';
};

const defaultFiles: MockFile[] = [
  {
    id: 'file-1',
    title: '縦書き表示確認',
    body: '「テスト」。\n（99）ー',
    updated_at: '2026-04-16T10:00:00',
    char_count: 11,
    custom_title: true,
  },
];

const defaultTestPlatform = process.platform === 'darwin'
  ? 'macos'
  : process.platform === 'win32'
    ? 'windows'
    : 'linux';

async function bootstrap(page: Page, options: BootstrapOptions = {}) {
  const resolvedPlatform = options.platformOverride ?? defaultTestPlatform;
  await page.addInitScript(({ files, firstLaunch, dialogSelections, platformOverride }) => {
    const fileMap = new Map(files.map((file) => [file.id, { ...file }]));
    let currentDataDir = 'C:/Users/test/AppData/Roaming/com.penguin.tenseijingo-editor/manuscripts';
    let callbackId = 0;
    let eventId = 0;
    const queuedDialogSelections = [...dialogSelections];
    const invokeLog: Array<{ cmd: string; args: Record<string, unknown> }> = [];

    localStorage.setItem('user_settings', JSON.stringify({
      viewZoom: 1,
      fontScale: 0.72,
      baseFontWeight: 700,
      gridStyle: 'solid',
      tcyScale: 1.02,
      cursorPosition: 'top',
    }));

    // @ts-expect-error test-only globals
    window.__TEST_PLATFORM__ = platformOverride;

    // @ts-expect-error test-only globals
    window.__TEST_STATE__ = {
      getInvokeLog() {
        return invokeLog;
      },
      getCurrentDataDir() {
        return currentDataDir;
      },
    };

    // @ts-expect-error test-only globals
    window.__TAURI_INTERNALS__ = {
      transformCallback(callback: unknown) {
        callbackId += 1;
        return callbackId;
      },
      unregisterCallback() {},
      async invoke(cmd: string, args: Record<string, unknown>) {
        invokeLog.push({ cmd, args: { ...args } });
        switch (cmd) {
          case 'plugin:event|listen':
            eventId += 1;
            return eventId;
          case 'plugin:event|unlisten':
            return null;
          case 'plugin:dialog|open':
            return queuedDialogSelections.shift() ?? null;
          case 'plugin:dialog|save':
            return null;
          case 'is_first_launch':
            return firstLaunch;
          case 'get_data_dir':
            return currentDataDir;
          case 'get_default_data_dir':
            return 'C:/Users/test/AppData/Roaming/com.penguin.tenseijingo-editor/manuscripts';
          case 'list_files':
            return Array.from(fileMap.values()).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
          case 'read_file':
            return fileMap.get(String(args.id));
          case 'create_file': {
            const id = `created-${fileMap.size + 1}`;
            fileMap.set(id, {
              id,
              title: '無題',
              body: '',
              updated_at: '2026-04-16T10:00:00',
              char_count: 0,
              custom_title: false,
            });
            return {
              id,
              history_status: 'committed',
            };
          }
          case 'save_file': {
            const id = String(args.id);
            const current = fileMap.get(id);
            if (!current) return null;
            const body = String(args.body ?? '');
            const next = {
              ...current,
              body,
              title: current.custom_title ? current.title : (body.split('\n')[0].trim() || '無題').slice(0, 20),
              char_count: [...body].filter((char) => char !== '\n').length,
              updated_at: '2026-04-16T10:01:00',
            };
            fileMap.set(id, next);
            return {
              entry: next,
              history_status: 'committed',
            };
          }
          case 'recover_history':
            return { recovered: false };
          case 'switch_data_dir':
            currentDataDir = String(args.path);
            return null;
          case 'inspect_data_dir':
            return {
              file_count: String(args.path).includes('existing') ? 1 : 0,
              overlapping_count: String(args.path).includes('existing') ? 1 : 0,
            };
          case 'set_data_dir':
            currentDataDir = String(args.path);
            return null;
          case 'set_default_data_dir':
            currentDataDir = 'C:/Users/test/AppData/Roaming/com.penguin.tenseijingo-editor/manuscripts';
            return currentDataDir;
          case 'git_log':
            return [
              {
                commit_hash: 'aaa111',
                message: '保存: 縦書き表示確認',
                timestamp: '2026/04/16 10:00:00',
                char_count: 11,
              },
              {
                commit_hash: 'bbb222',
                message: '新規作成: 縦書き表示確認',
                timestamp: '2026/04/16 09:58:00',
                char_count: 0,
              },
            ];
          case 'git_show':
            return '「テスト」。';
          case 'git_restore':
            return {
              entry: fileMap.get('file-1'),
              history_status: 'committed',
            };
          case 'rename_file': {
            const id = String(args.id);
            const current = fileMap.get(id);
            if (!current) return { history_status: 'committed' };
            const title = String(args.title ?? current.title);
            fileMap.set(id, {
              ...current,
              title,
              custom_title: true,
            });
            return { history_status: 'committed' };
          }
          case 'delete_file':
            return { history_status: 'committed' };
          case 'export_file_to':
            return null;
          default:
            throw new Error(`Unhandled invoke: ${cmd}`);
        }
      },
    };

    // @ts-expect-error test-only globals
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener() {},
    };
  }, {
    files: options.files ?? defaultFiles,
    firstLaunch: options.firstLaunch ?? false,
    dialogSelections: options.dialogSelections ?? [],
    platformOverride: resolvedPlatform,
  });

  await page.goto('/');
}

async function openEditor(page: Page) {
  await page.locator('.fm-item-info').click();
  await expect(page.locator('#editor-screen')).toBeVisible();
  await expect(page.locator('#grid .cell')).toHaveCount(35 * 18);
}

async function openEditorWithOverflow(page: Page) {
  await page.locator('.fm-item-info').click();
  await expect(page.locator('#editor-screen')).toBeVisible();
  await expect.poll(async () => page.locator('#grid .cell').count()).toBeGreaterThan(35 * 18);
}

async function moveCursorToEnd(page: Page) {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
}

async function expectCursorVisibleInsideGrid(page: Page, margin = 4) {
  const cursorBox = await page.locator('.cell.cursor-cell').boundingBox();
  const wrapperBox = await page.locator('#grid-wrapper').boundingBox();
  expect(cursorBox).not.toBeNull();
  expect(wrapperBox).not.toBeNull();
  expect((cursorBox?.x ?? 0)).toBeGreaterThanOrEqual((wrapperBox?.x ?? 0) + margin);
  expect((cursorBox?.y ?? 0)).toBeGreaterThanOrEqual((wrapperBox?.y ?? 0) + margin);
  expect((cursorBox?.x ?? 0) + (cursorBox?.width ?? 0)).toBeLessThanOrEqual((wrapperBox?.x ?? 0) + (wrapperBox?.width ?? 0) - margin);
  expect((cursorBox?.y ?? 0) + (cursorBox?.height ?? 0)).toBeLessThanOrEqual((wrapperBox?.y ?? 0) + (wrapperBox?.height ?? 0) - margin);
}

async function measureGridLayout(page: Page) {
  return page.evaluate(() => {
    const wrapper = document.getElementById('grid-wrapper') as HTMLElement;
    const grid = document.getElementById('grid') as HTMLElement;
    const cell = grid.querySelector('.cell') as HTMLElement;
    return {
      wrapperWidth: wrapper.clientWidth,
      wrapperHeight: wrapper.clientHeight,
      gridWidth: grid.getBoundingClientRect().width,
      gridHeight: grid.getBoundingClientRect().height,
      cellWidth: cell.getBoundingClientRect().width,
      cellHeight: cell.getBoundingClientRect().height,
    };
  });
}

function createFilledFile(body: string, title = '長文原稿'): MockFile {
  return {
    id: 'file-1',
    title,
    body,
    updated_at: '2026-04-16T10:00:00',
    char_count: [...body].filter((char) => char !== '\n').length,
    custom_title: true,
  };
}

test('captures first launch setup screen', async ({ page }) => {
  await bootstrap(page, { firstLaunch: true });
  await expect(page.locator('#setup-screen')).toBeVisible();
  await expect(page.locator('#setup-box')).toHaveScreenshot('setup-screen.png');
});

test('captures file manager appearance', async ({ page }) => {
  await bootstrap(page);
  await expect(page.locator('#file-manager')).toBeVisible();
  await expect(page.locator('#fm-list .fm-item')).toHaveCount(1);
  await expect(page).toHaveScreenshot('file-manager.png');
});

test('renames a manuscript directly from the file list', async ({ page }) => {
  await bootstrap(page);
  await expect(page.locator('#file-manager')).toBeVisible();

  await page.locator('.fm-item-rename').click();
  await expect(page.locator('#modal-overlay')).toBeVisible();
  await page.locator('#modal-input').fill('一覧から変更');
  await page.locator('#modal-ok').click();

  await expect(page.locator('.fm-item-title')).toHaveText('一覧から変更');
  await expect(page.getByText('名前を変更しました')).toBeVisible();
});

test('opens preview in the file list sidebar without entering the editor', async ({ page }) => {
  await bootstrap(page);
  await expect(page.locator('#file-manager')).toBeVisible();

  await page.locator('.act-preview').click();

  await expect(page.locator('#file-manager')).toBeVisible();
  await expect(page.locator('#editor-screen')).toBeHidden();
  await expect(page.locator('#fm-preview-panel')).toBeVisible();
  await expect(page.locator('#fm-preview-title')).toHaveText('縦書き表示確認');
  await expect(page.locator('#fm-preview-text')).toHaveValue('「テスト」。\n（99）ー');
  await expect(page.locator('.act-preview')).toHaveAttribute('aria-pressed', 'true');
});

test('toggles the same file preview button in the file list', async ({ page }) => {
  await bootstrap(page);
  await expect(page.locator('#file-manager')).toBeVisible();

  await page.locator('.act-preview').click();
  await expect(page.locator('#fm-preview-panel')).toBeVisible();
  await expect(page.locator('.act-preview')).toHaveClass(/active/);

  await page.locator('.act-preview').click();
  await expect(page.locator('#fm-preview-panel')).toBeHidden();
  await expect(page.locator('.act-preview')).not.toHaveClass(/active/);
  await expect(page.locator('.act-preview')).toHaveAttribute('aria-pressed', 'false');
});

test('switches the file list preview to another manuscript', async ({ page }) => {
  await bootstrap(page, {
    files: [
      {
        id: 'file-1',
        title: '一つ目の原稿',
        body: '一つ目の本文',
        updated_at: '2026-04-16T10:00:00',
        char_count: 6,
        custom_title: true,
      },
      {
        id: 'file-2',
        title: '二つ目の原稿',
        body: '二つ目の本文',
        updated_at: '2026-04-16T09:00:00',
        char_count: 6,
        custom_title: true,
      },
    ],
  });
  await expect(page.locator('#file-manager')).toBeVisible();

  await page.locator('.act-preview').nth(0).click();
  await expect(page.locator('#fm-preview-title')).toHaveText('一つ目の原稿');
  await expect(page.locator('.act-preview').nth(0)).toHaveClass(/active/);

  await page.locator('.act-preview').nth(1).click();
  await expect(page.locator('#fm-preview-title')).toHaveText('二つ目の原稿');
  await expect(page.locator('#fm-preview-text')).toHaveValue('二つ目の本文');
  await expect(page.locator('.act-preview').nth(0)).not.toHaveClass(/active/);
  await expect(page.locator('.act-preview').nth(1)).toHaveClass(/active/);
});

test('keeps the file list preview aligned with the list top margin', async ({ page }) => {
  await bootstrap(page, {
    files: Array.from({ length: 12 }, (_, index) => ({
      id: `file-${index + 1}`,
      title: `原稿${index + 1}`,
      body: `本文${index + 1}`,
      updated_at: `2026-04-${String(16 - Math.min(index, 9)).padStart(2, '0')}T10:00:00`,
      char_count: 3,
      custom_title: true,
    })),
  });
  await expect(page.locator('#file-manager')).toBeVisible();

  const targetItem = page.locator('.fm-item').last();
  const targetButton = targetItem.locator('.act-preview');
  await targetButton.scrollIntoViewIfNeeded();
  const targetItemBox = await targetItem.boundingBox();
  expect(targetItemBox).not.toBeNull();

  await targetButton.click();

  const previewBox = await page.locator('#fm-preview-panel').boundingBox();
  const wrapperBox = await page.locator('#fm-list-wrapper').boundingBox();
  expect(previewBox).not.toBeNull();
  expect(wrapperBox).not.toBeNull();
  expect(Math.abs((previewBox?.y ?? 0) - (wrapperBox?.y ?? 0))).toBeLessThanOrEqual(24);
});

test('opens the file list preview even when the manuscript exceeds the character limit', async ({ page }) => {
  await bootstrap(page, {
    files: [{
      id: 'file-1',
      title: '文字数超過原稿',
      body: 'あ'.repeat(640),
      updated_at: '2026-04-16T10:00:00',
      char_count: 640,
      custom_title: true,
    }],
  });
  await expect(page.locator('#file-manager')).toBeVisible();

  await page.locator('.act-preview').click();

  await expect(page.locator('#fm-preview-panel')).toBeVisible();
  await expect(page.locator('#fm-preview-title')).toHaveText('文字数超過原稿');
  await expect(page.locator('#fm-preview-text')).not.toHaveValue('');
  await expect(page.locator('.act-preview')).toHaveAttribute('aria-pressed', 'true');
});

test('edits the title directly from the editor toolbar', async ({ page }) => {
  await bootstrap(page);
  await openEditor(page);

  await page.locator('#editor-title').click();
  await expect(page.locator('#editor-title-input')).toBeVisible();
  await page.locator('#editor-title-input').fill('直接変更した題名');
  await page.locator('#editor-title-input').press('Enter');

  await expect(page.locator('#editor-title')).toHaveText('直接変更した題名');
  await expect(page.locator('#editor-title-input')).toBeHidden();
  await expect(page.getByText('名前を変更しました')).toBeVisible();
});

test('captures editor grid appearance', async ({ page }) => {
  await bootstrap(page);
  await openEditor(page);
  await expect(page).toHaveScreenshot('editor-grid.png');
});

test('grows the grid on a larger viewport', async ({ page }) => {
  await bootstrap(page);
  await openEditor(page);

  const before = await page.locator('#grid .cell').first().boundingBox();
  expect(before).not.toBeNull();

  await page.setViewportSize({ width: 1600, height: 1000 });

  await expect.poll(async () => {
    const after = await page.locator('#grid .cell').first().boundingBox();
    return after?.width ?? 0;
  }).toBeGreaterThan((before?.width ?? 0) + 1);
});

test('fits the full grid on the first Windows render even in a tighter viewport', async ({ page }) => {
  await page.setViewportSize({ width: 920, height: 560 });
  await bootstrap(page, { platformOverride: 'windows' });
  await openEditor(page);

  const layout = await measureGridLayout(page);
  expect(layout.gridWidth).toBeLessThanOrEqual(layout.wrapperWidth + 1);
  expect(layout.gridHeight).toBeLessThanOrEqual(layout.wrapperHeight + 1);
  expect(layout.cellWidth).toBeLessThan(24);
});

test('shrinks the Windows grid when the viewport height gets smaller', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await bootstrap(page, { platformOverride: 'windows' });
  await openEditor(page);

  const before = await page.locator('#grid .cell').first().boundingBox();
  expect(before).not.toBeNull();

  await page.setViewportSize({ width: 1400, height: 620 });

  await expect.poll(async () => {
    const after = await page.locator('#grid .cell').first().boundingBox();
    return after?.width ?? 0;
  }).toBeLessThan((before?.width ?? 0) - 3);

  const layout = await measureGridLayout(page);
  expect(layout.gridWidth).toBeLessThanOrEqual(layout.wrapperWidth + 1);
  expect(layout.gridHeight).toBeLessThanOrEqual(layout.wrapperHeight + 1);
});

test('applies Windows display zoom steps without auto-fill cancelling them out', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await bootstrap(page, { platformOverride: 'windows' });
  await openEditor(page);

  const before = await page.locator('#grid .cell').first().boundingBox();
  expect(before).not.toBeNull();

  await page.locator('#btn-zoom-smaller').click();
  await page.locator('#btn-zoom-smaller').click();

  await expect.poll(async () => {
    const after = await page.locator('#grid .cell').first().boundingBox();
    return after?.width ?? 0;
  }).toBeLessThan((before?.width ?? 0) - 4);
});

test('balances the left and right margins when only the base grid is visible', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await bootstrap(page);
  await openEditor(page);

  const margins = await page.evaluate(() => {
    const wrapper = document.getElementById('grid-wrapper') as HTMLElement;
    const grid = document.getElementById('grid') as HTMLElement;
    const wrapperRect = wrapper.getBoundingClientRect();
    const gridRect = grid.getBoundingClientRect();
    return {
      leftGap: gridRect.left - wrapperRect.left,
      rightGap: wrapperRect.right - gridRect.right,
    };
  });

  expect(Math.abs(margins.leftGap - margins.rightGap)).toBeLessThanOrEqual(2);
});

test('preserves horizontal scroll position when changing display zoom', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 720 });
  await bootstrap(page, {
    files: [createFilledFile('あ'.repeat(900), '倍率スクロール保持確認')],
  });
  await openEditorWithOverflow(page);

  const before = await page.locator('#grid-wrapper').evaluate((element) => {
    const wrapper = element as HTMLElement;
    wrapper.scrollLeft = Math.min(320, wrapper.scrollWidth - wrapper.clientWidth);
    return {
      scrollLeft: wrapper.scrollLeft,
      maxScrollLeft: wrapper.scrollWidth - wrapper.clientWidth,
    };
  });
  expect(before.maxScrollLeft).toBeGreaterThan(0);
  expect(before.scrollLeft).toBeGreaterThan(0);

  await page.locator('#btn-zoom-larger').click();

  const after = await page.locator('#grid-wrapper').evaluate((element) => {
    const wrapper = element as HTMLElement;
    return wrapper.scrollLeft;
  });
  expect(after).toBeGreaterThan(0);
  expect(Math.abs(after - before.scrollLeft)).toBeLessThanOrEqual(40);
});

test('swaps mouse-wheel scrolling axes without remapping trackpad-like scroll deltas', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 720 });
  await bootstrap(page, {
    files: [createFilledFile('あ'.repeat(900), 'ホイール確認')],
  });
  await openEditorWithOverflow(page);

  const metrics = await page.locator('#grid-wrapper').evaluate((element) => {
    const wrapper = element as HTMLElement;
    const stage = document.getElementById('grid-stage') as HTMLElement;
    stage.style.minHeight = `${wrapper.clientHeight * 2}px`;

    wrapper.scrollLeft = Math.min(320, wrapper.scrollWidth - wrapper.clientWidth);
    wrapper.scrollTop = 0;
    const beforeMouseWheel = wrapper.scrollLeft;
    wrapper.dispatchEvent(new WheelEvent('wheel', {
      deltaY: 120,
      bubbles: true,
      cancelable: true,
    }));
    const mouseWheel = { before: beforeMouseWheel, left: wrapper.scrollLeft, top: wrapper.scrollTop };

    wrapper.scrollLeft = 0;
    wrapper.scrollTop = 60;
    const beforeShiftMouseWheel = wrapper.scrollTop;
    wrapper.dispatchEvent(new WheelEvent('wheel', {
      deltaY: 120,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }));
    const shiftMouseWheel = { before: beforeShiftMouseWheel, left: wrapper.scrollLeft, top: wrapper.scrollTop };

    wrapper.scrollLeft = 0;
    wrapper.scrollTop = 0;
    wrapper.dispatchEvent(new WheelEvent('wheel', {
      deltaY: 18,
      bubbles: true,
      cancelable: true,
    }));
    const trackpadLike = { left: wrapper.scrollLeft, top: wrapper.scrollTop };

    stage.style.minHeight = '';
    return { mouseWheel, shiftMouseWheel, trackpadLike };
  });

  expect(metrics.mouseWheel.left).toBeLessThan(metrics.mouseWheel.before);
  expect(metrics.mouseWheel.top).toBe(0);
  expect(metrics.shiftMouseWheel.left).toBe(0);
  expect(metrics.shiftMouseWheel.top).toBeGreaterThan(metrics.shiftMouseWheel.before);
  expect(metrics.trackpadLike.left).toBe(0);
  expect(metrics.trackpadLike.top).toBe(0);
});

test('captures preview panel appearance', async ({ page }) => {
  await bootstrap(page);
  await openEditor(page);
  await page.locator('#btn-preview').click();
  await expect(page.locator('#preview-panel')).toBeVisible();
  await expect(page.locator('#editor-body')).toHaveScreenshot('preview-panel.png');
});

test('captures history list appearance', async ({ page }) => {
  await bootstrap(page);
  await openEditor(page);
  await page.locator('#btn-history').click();
  await expect(page.locator('#history-overlay')).toBeVisible();
  await expect(page.locator('#history-list .history-item')).toHaveCount(2);
  await expect(page.locator('#history-box')).toHaveScreenshot('history-list.png');
});

test('captures history preview appearance', async ({ page }) => {
  await bootstrap(page);
  await openEditor(page);
  await page.locator('#btn-history').click();
  await page.locator('#history-list .history-item').nth(1).click();
  await expect(page.locator('#history-preview-wrapper')).toBeVisible();
  await expect(page.locator('#history-box')).toHaveScreenshot('history-preview.png');
});

test('captures settings preview appearance', async ({ page }) => {
  await bootstrap(page);
  await openEditor(page);
  await page.locator('#btn-settings').click();
  await expect(page.locator('#settings-overlay')).toBeVisible();
  await page.locator('#settings-preview-char').click();
  await page.locator('#setting-cursor-right').click();
  await expect(page.locator('#settings-box')).toHaveScreenshot('settings-preview.png');
});

test('captures save directory confirmation modal', async ({ page }) => {
  await bootstrap(page, {
    dialogSelections: ['D:/tenseijingo-project/existing-manuscripts'],
  });
  await expect(page.locator('#file-manager')).toBeVisible();
  await page.locator('#fm-datadir-change').click();
  await expect(page.locator('#data-dir-overlay')).toBeVisible();
  await expect(page.locator('#data-dir-confirm')).toBeEnabled();
  await expect(page.locator('#data-dir-summary')).toBeEmpty();
  await expect(page.locator('#data-dir-warnings')).toBeEmpty();
  await expect(page.locator('#data-dir-box')).toHaveScreenshot('save-dir-confirm.png');
});

test('clears saved status immediately on new input', async ({ page }) => {
  await bootstrap(page);
  await openEditor(page);
  await page.keyboard.type('追記');
  await expect(page.locator('#save-status')).toContainText('未保存');
  await expect(page.locator('#save-status')).toContainText('保存済', { timeout: 3000 });
  await page.keyboard.type('あ');
  await expect(page.locator('#save-status')).toContainText('未保存');
});

test('dismisses manual save notification immediately on next input', async ({ page }) => {
  await bootstrap(page);
  await openEditor(page);
  await page.locator('#btn-save').click();
  await expect(page.getByText('保存しました')).toBeVisible();
  await page.keyboard.type('あ');
  await expect(page.getByText('保存しました')).toBeHidden();
});

test('keeps the cursor visible after deleting back to the first cell', async ({ page }) => {
  await bootstrap(page, {
    files: [{
      id: 'file-1',
      title: '削除確認',
      body: 'あいう',
      updated_at: '2026-04-16T10:00:00',
      char_count: 3,
      custom_title: true,
    }],
  });
  await openEditor(page);
  await moveCursorToEnd(page);
  await page.keyboard.press('Backspace');
  await expect(page.locator('.cell.cursor-cell')).toHaveCount(1);
  await page.keyboard.press('Backspace');
  await expect(page.locator('.cell.cursor-cell')).toHaveCount(1);
  await page.keyboard.press('Backspace');

  await expect(page.locator('.cell.cursor-cell')).toHaveCount(1);
  await expect(page.locator('.cell.cursor-cell')).toHaveAttribute('data-col', '0');
  await expect(page.locator('.cell.cursor-cell')).toHaveAttribute('data-row', '4');
});

test('keeps the cursor visible after deleting back to the top row of a later column', async ({ page }) => {
  await bootstrap(page, {
    files: [{
      id: 'file-1',
      title: '後半列削除確認',
      body: 'あ'.repeat(85),
      updated_at: '2026-04-16T10:00:00',
      char_count: 85,
      custom_title: true,
    }],
  });
  await openEditor(page);
  await moveCursorToEnd(page);
  await page.keyboard.press('Backspace');

  await expect(page.locator('.cell.cursor-cell')).toHaveCount(1);
  await expect(page.locator('.cell.cursor-cell')).toHaveAttribute('data-col', '6');
  await expect(page.locator('.cell.cursor-cell')).toHaveAttribute('data-row', '0');
});

test('keeps the cursor visible during IME composition', async ({ page }) => {
  await bootstrap(page, {
    files: [{
      id: 'file-1',
      title: 'IME確認',
      body: '',
      updated_at: '2026-04-16T10:00:00',
      char_count: 0,
      custom_title: true,
    }],
  });
  await openEditor(page);

  await page.locator('#hidden-input').evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    textarea.focus();
    textarea.selectionStart = 0;
    textarea.selectionEnd = 0;
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    textarea.value = 'あ';
    textarea.selectionStart = 0;
    textarea.selectionEnd = 0;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });

  await expect(page.locator('.cell.cursor-cell')).toHaveCount(1);
  await expect(page.locator('.cell.composing')).toHaveCount(1);
  await expect(page.locator('.cell.cursor-cell')).toHaveAttribute('data-col', '0');
  await expect(page.locator('.cell.cursor-cell')).toHaveAttribute('data-row', '5');
});

test('keeps the cursor visible while extending into later columns on Windows', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 720 });
  await bootstrap(page, {
    platformOverride: 'windows',
    files: [{
      id: 'file-1',
      title: 'Windows横スクロール確認',
      body: '',
      updated_at: '2026-04-16T10:00:00',
      char_count: 0,
      custom_title: true,
    }],
  });
  await openEditor(page);

  await page.locator('#hidden-input').evaluate((element, value) => {
    const textarea = element as HTMLTextAreaElement;
    textarea.focus();
    textarea.value = value as string;
    textarea.selectionStart = textarea.value.length;
    textarea.selectionEnd = textarea.value.length;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }, 'あ'.repeat(140));

  await expect(page.locator('html')).toHaveAttribute('data-platform', 'windows');
  await expect.poll(async () => Number(await page.locator('.cell.cursor-cell').getAttribute('data-col'))).toBeGreaterThan(8);
  await expectCursorVisibleInsideGrid(page);
});

test('auto-scrolls while drag-selecting toward the grid edge', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 720 });
  await bootstrap(page, {
    files: [createFilledFile('あ'.repeat(900), 'ドラッグ選択確認')],
  });
  await openEditorWithOverflow(page);

  const startCell = await page.locator('.cell[data-col="0"][data-row="5"]').boundingBox();
  const wrapper = await page.locator('#grid-wrapper').boundingBox();
  expect(startCell).not.toBeNull();
  expect(wrapper).not.toBeNull();

  const y = (startCell?.y ?? 0) + ((startCell?.height ?? 0) / 2);
  await page.mouse.move((startCell?.x ?? 0) + ((startCell?.width ?? 0) / 2), y);
  await page.mouse.down();
  await page.mouse.move((wrapper?.x ?? 0) + 4, y, { steps: 12 });

  await expect.poll(async () => page.locator('#grid-wrapper').evaluate((element) => {
    const wrapper = element as HTMLElement;
    return wrapper.scrollLeft;
  })).toBeGreaterThan(0);

  const selectionState = await page.locator('#hidden-input').evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    const wrapper = document.getElementById('grid-wrapper') as HTMLElement;
    return {
      selectionLength: textarea.selectionEnd - textarea.selectionStart,
      scrollLeft: wrapper.scrollLeft,
    };
  });
  await page.mouse.up();

  expect(selectionState.scrollLeft).toBeGreaterThan(0);
  expect(selectionState.selectionLength).toBeGreaterThan(600);
  await expect.poll(async () => page.locator('.cell.selected').count()).toBeGreaterThan(30);
});

test('keeps the IME anchor near the active cell on upper rows', async ({ page }) => {
  await bootstrap(page, {
    platformOverride: 'macos',
    files: [{
      id: 'file-1',
      title: 'IME上端確認',
      body: '',
      updated_at: '2026-04-16T10:00:00',
      char_count: 0,
      custom_title: true,
    }],
  });
  await openEditor(page);
  await expect(page.locator('html')).toHaveAttribute('data-platform', 'macos');

  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('ArrowUp');
  }

  const cursorBox = await page.locator('.cell.cursor-cell').boundingBox();
  expect(cursorBox).not.toBeNull();

  await page.locator('#hidden-input').evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    textarea.focus();
    textarea.selectionStart = 0;
    textarea.selectionEnd = 0;
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
  });

  const inputBox = await page.locator('#hidden-input').boundingBox();
  expect(inputBox).not.toBeNull();
  expect(Math.abs((inputBox?.y ?? 0) - (cursorBox?.y ?? 0))).toBeLessThan(60);
  expect(Math.abs(((inputBox?.x ?? 0) + (inputBox?.width ?? 0)) - ((cursorBox?.x ?? 0) + (cursorBox?.width ?? 0)))).toBeLessThanOrEqual(26);
  await expect(page.locator('#hidden-input')).toHaveClass(/ime-anchor-active/);
  await expect(page.locator('#hidden-input')).toHaveCSS('text-align', 'right');
});

test('uses a vertical IME anchor on Windows to avoid left drift during composition', async ({ page }) => {
  await bootstrap(page, {
    platformOverride: 'windows',
    files: [{
      id: 'file-1',
      title: 'Windows IME確認',
      body: '',
      updated_at: '2026-04-16T10:00:00',
      char_count: 0,
      custom_title: true,
    }],
  });
  await openEditor(page);

  await page.locator('#hidden-input').evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    textarea.focus();
    textarea.selectionStart = 0;
    textarea.selectionEnd = 0;
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    textarea.value = 'かんじへんかん';
    textarea.selectionStart = textarea.value.length;
    textarea.selectionEnd = textarea.value.length;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });

  await expect(page.locator('html')).toHaveAttribute('data-platform', 'windows');
  await expect(page.locator('#hidden-input')).toHaveClass(/ime-anchor-active/);
  await expect(page.locator('#hidden-input')).toHaveCSS('writing-mode', 'vertical-rl');
  await expect(page.locator('#hidden-input')).toHaveCSS('font-size', '1px');

  const inputBox = await page.locator('#hidden-input').boundingBox();
  expect(inputBox).not.toBeNull();
  expect((inputBox?.height ?? 0)).toBeGreaterThan((inputBox?.width ?? 0) * 3);
});

test('keeps the Windows IME anchor to the left of the active text', async ({ page }) => {
  await bootstrap(page, {
    platformOverride: 'windows',
    files: [{
      id: 'file-1',
      title: 'Windows IME位置確認',
      body: '',
      updated_at: '2026-04-16T10:00:00',
      char_count: 0,
      custom_title: true,
    }],
  });
  await openEditor(page);

  await page.locator('#hidden-input').evaluate((element, value) => {
    const textarea = element as HTMLTextAreaElement;
    textarea.focus();
    textarea.value = value as string;
    textarea.selectionStart = textarea.value.length;
    textarea.selectionEnd = textarea.value.length;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
  }, 'こんにちは');

  const cursorBox = await page.locator('.cell.cursor-cell').boundingBox();
  const inputBox = await page.locator('#hidden-input').boundingBox();
  expect(cursorBox).not.toBeNull();
  expect(inputBox).not.toBeNull();
  expect((inputBox?.x ?? 0) + (inputBox?.width ?? 0)).toBeLessThanOrEqual((cursorBox?.x ?? 0) - 12);
  expect((cursorBox?.x ?? 0) - ((inputBox?.x ?? 0) + (inputBox?.width ?? 0))).toBeLessThanOrEqual(64);
});

test('keeps the Windows IME anchor stable when composition starts', async ({ page }) => {
  await bootstrap(page, { platformOverride: 'windows' });
  await openEditor(page);

  const before = await page.locator('#hidden-input').boundingBox();
  expect(before).not.toBeNull();

  await page.locator('#hidden-input').evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    textarea.focus();
    textarea.selectionStart = 0;
    textarea.selectionEnd = 0;
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
  });

  const after = await page.locator('#hidden-input').boundingBox();
  expect(after).not.toBeNull();
  expect(Math.abs((after?.x ?? 0) - (before?.x ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((after?.width ?? 0) - (before?.width ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((after?.height ?? 0) - (before?.height ?? 0))).toBeLessThanOrEqual(1);
});

test('moves the Windows IME anchor immediately when clicking a filled cell', async ({ page }) => {
  await bootstrap(page, {
    platformOverride: 'windows',
    files: [{
      id: 'file-1',
      title: 'Windows IMEクリック確認',
      body: 'あ'.repeat(140),
      updated_at: '2026-04-16T10:00:00',
      char_count: 140,
      custom_title: true,
    }],
  });
  await openEditor(page);

  const result = await page.evaluate(() => {
    const target = document.querySelector('.cell[data-col="7"][data-row="5"]') as HTMLElement;
    const textarea = document.getElementById('hidden-input') as HTMLTextAreaElement;
    const before = textarea.getBoundingClientRect();
    const cell = target.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    const after = textarea.getBoundingClientRect();
    return {
      before: { x: before.x, y: before.y, width: before.width, height: before.height },
      after: { x: after.x, y: after.y, width: after.width, height: after.height },
      cell: { x: cell.x, y: cell.y, width: cell.width, height: cell.height },
      focused: document.activeElement === textarea,
      ready: textarea.classList.contains('ime-anchor-ready'),
    };
  });

  expect(result.focused).toBe(true);
  expect(result.ready).toBe(true);
  expect(Math.abs(result.after.x - result.before.x) + Math.abs(result.after.y - result.before.y)).toBeGreaterThan(2);
  expect(result.after.x + result.after.width).toBeLessThanOrEqual(result.cell.x - 12);
  expect(Math.abs(result.after.y - result.cell.y)).toBeLessThan(60);
});

test('switches save directory after confirmation and updates the label', async ({ page }) => {
  await bootstrap(page, {
    dialogSelections: ['D:/tenseijingo-project/manuscripts'],
  });
  await expect(page.locator('#file-manager')).toBeVisible();
  await page.locator('#fm-datadir-change').click();
  await expect(page.locator('#data-dir-switch-only')).toHaveClass(/selected/);
  await expect(page.locator('#data-dir-confirm')).toBeEnabled();
  await page.locator('#data-dir-migrate').click();
  await expect(page.locator('#data-dir-migrate')).toHaveClass(/selected/);
  await page.locator('#data-dir-confirm').click();
  await expect(page.locator('#data-dir-overlay')).toBeHidden();
  await expect(page.locator('#fm-datadir-path')).toHaveText('D:/tenseijingo-project/manuscripts');
  await expect(page.locator('body')).toContainText('保存先を変更して原稿を引き継ぎました');

  const switchCall = await page.evaluate(() => {
    // @ts-expect-error test-only globals
    return window.__TEST_STATE__.getInvokeLog().find((entry: { cmd: string; args: Record<string, unknown> }) => entry.cmd === 'switch_data_dir');
  });
  expect(switchCall).toEqual({
    cmd: 'switch_data_dir',
    args: {
      path: 'D:/tenseijingo-project/manuscripts',
      migrateExisting: true,
    },
  });
});

test('shows only the relevant warning for migration conflicts', async ({ page }) => {
  await bootstrap(page, {
    dialogSelections: ['D:/tenseijingo-project/existing-manuscripts'],
  });
  await expect(page.locator('#file-manager')).toBeVisible();
  await page.locator('#fm-datadir-change').click();
  await expect(page.locator('#data-dir-warnings')).toBeEmpty();
  await page.locator('#data-dir-migrate').click();
  await expect(page.locator('#data-dir-summary')).toBeEmpty();
  await expect(page.locator('.data-dir-warning')).toHaveCount(1);
  await expect(page.locator('.data-dir-warning')).toContainText('重複する 1 件は切替先の内容を優先します。');
});
