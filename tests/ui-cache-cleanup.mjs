/** Browser acceptance for the explicit image-cache cleanup control.
 * This suite only mocks the cleanup endpoint. It never touches a real cache
 * directory or music file.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '.codex/ui-preview');
const require = createRequire(import.meta.url);
let playwright;
for (const value of [process.env.PLAYWRIGHT_MODULE, 'playwright', path.join(path.dirname(path.dirname(process.execPath)), 'node_modules/playwright')].filter(Boolean)) {
  try { playwright = require(value); break; } catch { /* Try the next installed runtime. */ }
}
if (!playwright) throw new Error('Install Playwright or set PLAYWRIGHT_MODULE.');

const port = Number(process.env.METATIDY_CACHE_UI_PORT || 18996);
const base = `http://127.0.0.1:${port}`;
const snapshot = () => ({ checked_at: 1700000000, database: { engine: 'PostgreSQL', connected: true, stores: ['曲库索引', '应用设置', '别名', '任务记录'] },
  music: { path: '/fixture-music', exists: true }, cache: { root: '/fixture-data', format: 'AVIF', on_demand: true,
    originals: { path: '/fixture-data/covers', exists: true, files: 2, bytes: 204800, truncated: false, error: '' },
    thumbnails: { path: '/fixture-data/thumbs', exists: true, files: 15, bytes: 78600, truncated: false, error: '' } },
  runtime: { container: false }, write_checks: null });
const success = (scope = 'thumbnails') => ({ scope, finished_at: 1700000010, complete: true, removed_files: scope === 'all' ? 34 : scope === 'originals' ? 4 : 30,
  removed_images: scope === 'all' ? 17 : scope === 'originals' ? 2 : 15, removed_metadata: scope === 'all' ? 17 : scope === 'originals' ? 2 : 15, removed_bytes: scope === 'all' ? 28672 : 12000,
  skipped_entries: 1, failed_entries: 0, errors: [], truncated: false });
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let browser, server, passed = 0;
const failures = [];

async function check(name, action) {
  if (process.env.METATIDY_CACHE_UI_CHECK && !name.includes(process.env.METATIDY_CACHE_UI_CHECK)) return;
  try { await action(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack || error.message}`); }
}

async function withPage(action, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce', ...options });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const calls = [], errors = [], controls = { clear: [], get: 0, getResponses: [], auth: false, gates: [] };
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window);
    window.cacheCleanupDelivered = 0;
    window.fetch = (input, options = {}) => {
      if (new URL(typeof input === 'string' ? input : input.url, location.href).pathname !== '/api/storage/clear-cache') return fetch(input, options);
      // Deliver a late body even when canceled, so lifecycle guards are tested.
      return fetch(input, { ...options, signal: undefined }).then(response => {
        const text = response.text.bind(response);
        response.text = async () => { const body = await text(); window.cacheCleanupDelivered += 1; return body; };
        return response;
      });
    };
  });
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const body = request.postData() ? request.postDataJSON() : null;
    calls.push({ path: url.pathname, method: request.method(), body });
    if (url.pathname === '/api/storage' && request.method() === 'GET') {
      controls.get += 1;
      const queued = controls.getResponses.shift();
      return route.fulfill({ status: queued?.status || 200, json: queued?.data || snapshot() });
    }
    if (url.pathname === '/api/storage/clear-cache' && request.method() === 'POST') {
      const planned = controls.clear.shift() || {};
      if (planned.gate) { controls.gates.push(planned.gate); await planned.gate.promise; }
      if (planned.abort) return route.abort('connectionreset');
      if (planned.status) return route.fulfill({ status: planned.status, json: planned.data || { detail: '受控清理失败' } });
      return route.fulfill({ status: 200, json: planned.data || success(body.scope) });
    }
    if (url.pathname === '/api/session' && controls.auth) return route.fulfill({ status: 401, json: { detail: '会话已失效' } });
    return route.continue();
  });
  try {
    await action({ page, context, calls, controls });
    assert.deepEqual(errors, [], 'Cache cleanup must not raise browser exceptions');
    assert.deepEqual(calls.filter(call => !['GET', 'HEAD'].includes(call.method) && !['/api/storage/clear-cache', '/api/storage/check'].includes(call.path)), [], 'Cache cleanup must not issue unrelated writes');
  } finally { for (const delayed of controls.gates) delayed.resolve(); await context.close(); }
}

async function ready(page) {
  await page.goto(`${base}/#settings`);
  await page.locator('#panel-settings[data-active="true"]').waitFor();
  await page.locator('#storage-clear-cache').waitFor();
  await page.waitForFunction(() => document.querySelector('#storage-clear-cache')?.disabled === false);
}

async function openDialog(page) {
  await page.locator('#storage-clear-cache').click();
  await page.locator('#storage-clear-dialog[open]').waitFor();
}

function assertDialogGeometry(page, width, height) {
  return page.locator('#storage-clear-dialog').evaluate((dialog, size) => {
    const rect = dialog.getBoundingClientRect();
    const buttons = [...dialog.querySelectorAll('button')].filter(button => !button.hidden).map(button => {
      const box = button.getBoundingClientRect();
      return { id: button.id, left: box.left, right: box.right, top: box.top, bottom: box.bottom,
        reached: document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('button') === button };
    });
    return { rect: rect.toJSON(), width: size.width, height: size.height, pageWidth: document.documentElement.scrollWidth, buttons };
  }, { width, height }).then(result => {
    assert.ok(result.pageWidth <= result.width + 1 && result.rect.left >= 0 && result.rect.right <= result.width
      && result.rect.top >= 0 && result.rect.bottom <= result.height, JSON.stringify(result));
    for (const button of result.buttons) assert.ok(button.left >= 0 && button.right <= result.width + 1 && button.top >= 0 && button.bottom <= result.height + 1 && button.reached, JSON.stringify(button));
  });
}

try {
  await mkdir(output, { recursive: true });
  server = spawn(process.execPath, ['tests/ui-preview.mjs', `--port=${port}`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Cache fixture did not start')), 10000);
    server.stdout.on('data', value => { if (String(value).includes('UI FIXTURE')) { clearTimeout(timer); resolve(); } });
    server.stderr.on('data', value => { clearTimeout(timer); reject(new Error(String(value))); });
    server.on('error', reject);
  });
  browser = await playwright.chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });

  await check('Opening settings reads cache usage without starting a cleanup', () => withPage(async ({ page, calls }) => {
    await ready(page);
    assert.equal(calls.filter(call => call.path === '/api/storage/clear-cache').length, 0);
    assert.match(await page.locator('#storage-cards').textContent(), /图片缓存/);
  }));

  await check('Canceling cache cleanup never posts and leaves the settings page usable', () => withPage(async ({ page, calls }) => {
    await ready(page); await openDialog(page);
    await page.locator('input[name="cache-scope"][value="all"]').check();
    await page.locator('#storage-clear-cancel').click();
    await page.locator('#storage-clear-dialog').waitFor({ state: 'detached' });
    assert.equal(calls.filter(call => call.path === '/api/storage/clear-cache').length, 0);
    assert.equal(await page.locator('#storage-clear-cache').isEnabled(), true);
  }));

  await check('Confirming one scope posts exactly once, disables controls, reports counts and refreshes usage', () => withPage(async ({ page, calls, controls }) => {
    controls.clear.push({ gate: gate() });
    await ready(page); await openDialog(page); await page.locator('input[name="cache-scope"][value="originals"]').check();
    const pending = controls.clear[0].gate;
    await page.locator('#storage-clear-confirm').click();
    await page.waitForFunction(() => document.querySelector('#storage-clear-confirm')?.disabled === true);
    await page.locator('#storage-clear-confirm').evaluate(button => button.click());
    assert.equal(calls.filter(call => call.path === '/api/storage/clear-cache').length, 1);
    assert.deepEqual(calls.find(call => call.path === '/api/storage/clear-cache').body, { scope: 'originals' });
    pending.resolve();
    await page.waitForFunction(() => /已清理|清理完成|删除/.test(document.querySelector('#storage-clear-result')?.textContent || document.querySelector('#storage-clear-dialog')?.textContent || ''));
    assert.equal(calls.filter(call => call.path === '/api/storage').length >= 2, true);
  }));

  await check('Partial cleanup keeps a clear warning and does not pretend every entry was removed', () => withPage(async ({ page, controls }) => {
    controls.clear.push({ data: { ...success('thumbnails'), complete: false, removed_files: 4, removed_images: 2, removed_metadata: 2, failed_entries: 2, skipped_entries: 3,
      errors: [{ path: '/fixture-data/thumbs/bad.avif', message: '文件被占用' }], truncated: true } });
    await ready(page); await openDialog(page); await page.locator('#storage-clear-confirm').click();
    await page.waitForFunction(() => /部分|失败|跳过/.test(document.querySelector('#storage-clear-result')?.textContent || document.querySelector('#storage-clear-dialog')?.textContent || ''));
    const text = await page.locator('#storage-clear-result').textContent();
    assert.match(text, /2/); assert.match(text, /3/);
  }));

  await check('Malformed success responses are shown as an error without an automatic retry or second POST', () => withPage(async ({ page, calls, controls }) => {
    controls.clear.push({ data: { scope: 'all', complete: 'yes', removed_files: '14' } });
    await ready(page); await openDialog(page); await page.locator('input[name="cache-scope"][value="all"]').check(); await page.locator('#storage-clear-confirm').click();
    await page.waitForFunction(() => /响应|格式|失败|无法/.test(document.querySelector('#storage-clear-result')?.textContent || ''));
    assert.equal(calls.filter(call => call.path === '/api/storage/clear-cache').length, 1);
  }));

  await check('A truncated zero-removal result does not claim the cache is empty', () => withPage(async ({ page, controls }) => {
    controls.clear.push({ data: { ...success(), complete: false, removed_files: 0, removed_images: 0, removed_metadata: 0,
      removed_bytes: 0, skipped_entries: 50000, truncated: true } });
    await ready(page); await openDialog(page); await page.locator('#storage-clear-confirm').click();
    await page.waitForFunction(() => document.querySelector('#storage-clear-dialog')?.dataset.phase === 'partial');
    const text = await page.locator('#storage-clear-result').textContent();
    assert.match(text, /部分清理|未能完整/);
    assert.doesNotMatch(text, /没有可删除/);
  }));

  await check('Every displayed scope is sent exactly and the default is thumbnails only', async () => {
    for (const scope of ['thumbnails', 'originals', 'all']) await withPage(async ({ page, calls }) => {
      await ready(page); await openDialog(page);
      assert.equal(await page.locator('input[name="cache-scope"][value="thumbnails"]').isChecked(), true);
      await page.locator(`input[name="cache-scope"][value="${scope}"]`).check();
      await page.locator('#storage-clear-confirm').click();
      await page.waitForFunction(() => Boolean(document.querySelector('#storage-clear-result')));
      assert.deepEqual(calls.filter(call => call.path === '/api/storage/clear-cache').map(call => call.body), [{ scope }]);
    });
  });

  await check('A usage refresh failure retains the successful cleanup report and manual refresh is GET only', () => withPage(async ({ page, calls, controls }) => {
    await ready(page); controls.getResponses.push({ status: 503, data: { detail: '受控用量刷新失败' } });
    await openDialog(page); await page.locator('#storage-clear-confirm').click();
    await page.waitForFunction(() => Boolean(document.querySelector('#storage-clear-result')?.textContent));
    assert.match(await page.locator('#storage-clear-result').textContent(), /清理完成|已清理|删除/);
    await page.waitForFunction(() => document.querySelector('#storage-clear-dialog')?.dataset.phase === 'done');
    const writes = calls.filter(call => call.path === '/api/storage/clear-cache').length;
    await page.locator('#storage-clear-close').click();
    await page.locator('#btn-status-reload').click();
    await page.waitForFunction(() => !document.querySelector('#btn-status-reload')?.disabled);
    assert.equal(calls.filter(call => call.path === '/api/storage/clear-cache').length, writes);
    assert.match(await page.locator('#storage-clear-result').textContent(), /清理完成|已清理|删除/);
  }));

  await check('An unknown network result offers usage refresh without automatically posting cleanup again', () => withPage(async ({ page, calls, controls }) => {
    controls.clear.push({ abort: true });
    await ready(page); await openDialog(page); await page.locator('#storage-clear-confirm').click();
    await page.waitForFunction(() => /不明|无法确认|未确认|失败|连接|网络/.test(document.querySelector('#storage-clear-result')?.textContent || document.querySelector('#storage-clear-dialog')?.textContent || ''));
    assert.equal(calls.filter(call => call.path === '/api/storage/clear-cache').length, 1);
    assert.equal(calls.filter(call => call.path === '/api/storage/check').length, 0);
  }));

  await check('Empty caches report zero removals without claiming a failed cleanup', () => withPage(async ({ page, calls, controls }) => {
    controls.clear.push({ data: { ...success(), removed_files: 0, removed_images: 0, removed_metadata: 0, removed_bytes: 0, skipped_entries: 0 }, gate: gate() });
    await ready(page); await openDialog(page); await page.locator('#storage-clear-confirm').click();
    await page.waitForFunction(() => document.querySelector('#storage-clear-dialog')?.dataset.phase === 'clearing' && document.querySelector('#storage-clear-confirm')?.disabled);
    controls.gates.at(-1).resolve();
    await page.waitForFunction(() => document.querySelector('#storage-clear-dialog')?.dataset.phase === 'done');
    await page.locator('#storage-clear-close').click();
    const report = await page.locator('#storage-clear-result').textContent();
    assert.match(report, /0|无需清理|没有.*缓存/);
    assert.equal(calls.filter(call => call.path === '/api/storage/clear-cache').length, 1);
  }));

  await check('A cleanup 401 closes the confirmation and restores the login overlay', () => withPage(async ({ page, calls, controls }) => {
    controls.clear.push({ status: 401, data: { detail: '受控会话失效' } });
    await ready(page); await openDialog(page); await page.locator('#storage-clear-confirm').click();
    await page.locator('#auth-veil').waitFor({ state: 'visible' });
    await page.locator('#storage-clear-dialog').waitFor({ state: 'detached' });
    assert.equal(calls.filter(call => call.path === '/api/storage/clear-cache').length, 1);
  }));

  await check('Authentication and navigation close an in-flight cleanup and ignore its late response', async () => {
    for (const boundary of ['tab', 'hash', 'unauthorized']) await withPage(async ({ page, calls, controls }) => {
      const delayed = gate(); controls.clear.push({ gate: delayed });
      await ready(page); await openDialog(page); await page.locator('#storage-clear-confirm').click();
      await page.waitForFunction(() => document.querySelector('#storage-clear-confirm')?.disabled === true);
      await page.evaluate(boundary => {
        if (boundary === 'tab') document.getElementById('tab-tracks').click();
        else if (boundary === 'hash') location.hash = '#tracks';
        else window.dispatchEvent(new CustomEvent('metatidy:unauthorized', { detail: '受控会话失效' }));
      }, boundary);
      await page.locator('#storage-clear-dialog').waitFor({ state: 'detached' });
      const before = await page.locator('#storage-feedback').textContent();
      delayed.resolve(); await page.waitForFunction(() => window.cacheCleanupDelivered === 1);
      assert.equal(calls.filter(call => call.path === '/api/storage/clear-cache').length, 1);
      assert.equal(await page.locator('#storage-feedback').textContent(), before, boundary);
    });
  });

  await check('Cache cleanup dialog controls stay inside light/dark desktop, phone and landscape viewports', async () => {
    for (const [width, height] of [[320, 480], [390, 844], [844, 390], [1440, 1000]]) for (const colorScheme of ['light', 'dark']) await withPage(async ({ page }) => {
      await ready(page); await openDialog(page); await assertDialogGeometry(page, width, height);
      await page.screenshot({ path: path.join(output, `storage-clear-${width}x${height}-${colorScheme}.png`), animations: 'disabled' });
      await page.locator('#storage-clear-close, #storage-clear-cancel').first().click();
    }, { viewport: { width, height }, colorScheme, reducedMotion: 'reduce' });
  });

  console.log(`\n${passed} cache cleanup checks passed; ${failures.length} failed. Screenshots: ${output}`);
  if (failures.length) process.exitCode = 1;
} finally { await browser?.close(); server?.kill(); }
