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

async function bootstrap(page: Page, options: BootstrapOptions = {}) {
  await page.addInitScript(({ files, firstLaunch, dialogSelections }) => {
    const fileMap = new Map(files.map((file) => [file.id, { ...file }]));
    let currentDataDir = 'C:/Users/test/AppData/Roaming/com.penguin.tenseijingo-editor/manuscripts';
    let callbackId = 0;
    let eventId = 0;
    const queuedDialogSelections = [...dialogSelections];
    const invokeLog: Array<{ cmd: string; args: Record<string, unknown> }> = [];

    localStorage.setItem('user_settings', JSON.stringify({
      fontScale: 0.72,
      baseFontWeight: 700,
      gridStyle: 'solid',
      tcyScale: 1.02,
      cursorPosition: 'top',
    }));

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
            return id;
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
            return next;
          }
          case 'switch_data_dir':
            currentDataDir = String(args.path);
            return null;
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
            return fileMap.get('file-1');
          case 'rename_file':
          case 'delete_file':
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
  });

  await page.goto('/');
}

async function openEditor(page: Page) {
  await page.locator('.fm-item-info').click();
  await expect(page.locator('#editor-screen')).toBeVisible();
  await expect(page.locator('#grid .cell')).toHaveCount(35 * 18);
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

test('captures editor grid appearance', async ({ page }) => {
  await bootstrap(page);
  await openEditor(page);
  await expect(page).toHaveScreenshot('editor-grid.png');
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
    dialogSelections: ['D:/tenseijingo-project/manuscripts'],
  });
  await expect(page.locator('#file-manager')).toBeVisible();
  await page.locator('#fm-datadir-change').click();
  await expect(page.locator('#modal-overlay')).toBeVisible();
  await expect(page.locator('#modal-box')).toHaveScreenshot('save-dir-confirm.png');
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

test('switches save directory after confirmation and updates the label', async ({ page }) => {
  await bootstrap(page, {
    dialogSelections: ['D:/tenseijingo-project/manuscripts'],
  });
  await expect(page.locator('#file-manager')).toBeVisible();
  await page.locator('#fm-datadir-change').click();
  await page.locator('#modal-ok').click();
  await expect(page.locator('#modal-overlay')).toBeHidden();
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
