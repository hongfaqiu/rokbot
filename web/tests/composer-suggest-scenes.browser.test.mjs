// The composer assist in a real browser (headless Chromium): the strip is not generated while a
// turn runs, is generated once after it, again when a reply quote is added, and inline completion
// is not requested for a /command or during IME composition.
// Opt-in: ROKBOT_TEST_PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core [ROKBOT_TEST_CHROMIUM=/path/to/chrome] node --test web/tests/composer-suggest-scenes.browser.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PW = process.env.ROKBOT_TEST_PLAYWRIGHT_CORE;

const PAGE = `<!doctype html><html lang="zh-CN"><body>
<div class="sand-agents-sidebar"><div class="sand-agent-item" data-agent-id="rokbot" aria-current="page">RokBot</div></div>
<div class="sand-virtual-transcript">
  <div data-entry-id="u1" data-role="user">跑一下 e2e</div>
  <div data-entry-id="a1" data-role="assistant">e2e 挂了 2 个：upload.spec 和 lint。</div>
</div>
<div id="composer"><form class="sand-prompt-form"><div contenteditable="true" id="input"></div>
<button type="submit" aria-label="Send">send</button></form></div>
</body></html>`;

function installScript() {
  window.requests = [];
  window.RokBotComposerAssist.installComposerSuggestions({
    installSettings: false,
    getViewingAgentId: () => 'rokbot',
    request: async (path, body) => {
      window.requests.push({ path, body: body ? JSON.parse(JSON.stringify(body)) : null });
      if (path === '/local/suggestions/settings') return { enabled: true, aiEnabled: true, completionEnabled: true, quickPhrases: [{ id: 'p1', text: '继续' }] };
      if (path === '/local/suggestions') {
        return { source: 'model', enabled: true, aiEnabled: true, agentId: body.agentId, requestId: body.requestId,
          quickPhrases: [{ id: 'p1', text: '继续' }], aiSuggestions: [`建议${window.requests.length}`] };
      }
      if (path === '/local/suggestions/complete') return { enabled: true, completion: '', source: 'model' };
      return {};
    },
  });
}

test('composer assist in a browser: idle-only generation, quote trigger, completion gates', { skip: !PW && 'set ROKBOT_TEST_PLAYWRIGHT_CORE' }, async t => {
  const { chromium } = createRequire(import.meta.url)(PW);
  // ROKBOT_TEST_CHROMIUM: a Chromium / headless shell binary when the bundled revision is not installed.
  const browser = await chromium.launch(process.env.ROKBOT_TEST_CHROMIUM ? { executablePath: process.env.ROKBOT_TEST_CHROMIUM } : {});
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(PAGE);
  await page.addScriptTag({ content: fs.readFileSync(path.join(REPO, 'mac/clients/desktop/composer-assist.cjs'), 'utf8') });
  await page.evaluate(installScript);
  const generations = () => page.evaluate(() => window.requests.filter(r => r.path === '/local/suggestions'));
  const completions = () => page.evaluate(() => window.requests.filter(r => r.path === '/local/suggestions/complete').length);
  const chips = () => page.evaluate(() => [...document.querySelectorAll('.rokbot-suggestions:not([hidden]) .rokbot-suggestions__chip')].map(el => el.textContent));
  const skeleton = () => page.evaluate(() => document.querySelectorAll('.rokbot-suggestions:not([hidden]) .rokbot-suggestions__skeleton').length);

  // The chat opens idle: prepared once in the background.
  await page.waitForTimeout(900);
  assert.equal((await generations()).length, 1);

  // A turn: the Stop button shows, rows stream in, a tool call follows, the Stop button blinks.
  await page.evaluate(() => {
    const form = document.querySelector('.sand-prompt-form');
    const stop = document.createElement('button');
    stop.id = 'stop'; stop.setAttribute('aria-label', 'Stop'); form.appendChild(stop);
    document.querySelector('.sand-virtual-transcript').insertAdjacentHTML('beforeend', '<div data-entry-id="u2" data-role="user">先修 upload.spec</div>');
  });
  await page.focus('#input');
  for (let i = 0; i < 8; i++) {
    await page.evaluate(i => {
      const tr = document.querySelector('.sand-virtual-transcript');
      tr.insertAdjacentHTML('beforeend', `<div data-entry-id="s${i}" data-role="assistant">正在处理第 ${i} 步</div>`);
      if (i === 4) document.getElementById('stop').remove();          // between two steps
      if (i === 5) {                                                   // the turn goes on
        const stop = document.createElement('button');
        stop.id = 'stop'; stop.setAttribute('aria-label', 'Stop');
        document.querySelector('.sand-prompt-form').appendChild(stop);
      }
    }, i);
    await page.waitForTimeout(250);
    assert.equal(await skeleton(), 0, 'no placeholders while the turn runs');
    assert.ok((await chips()).every(text => text === '继续'), 'only the quick phrases while busy');
  }
  assert.equal((await generations()).length, 1, 'nothing generated during the turn');

  // The turn ends: quiet for the settle time, then generated exactly once.
  await page.evaluate(() => {
    document.getElementById('stop').remove();
    document.querySelector('.sand-virtual-transcript').insertAdjacentHTML('beforeend', '<div data-entry-id="a2" data-role="assistant">upload.spec 修好了。</div>');
  });
  await page.waitForTimeout(600);
  assert.equal((await generations()).length, 1, 'still settling');
  await page.waitForTimeout(2_000);
  const afterTurn = await generations();
  assert.equal(afterTurn.length, 2, 'generated once after the turn');
  assert.equal(afterTurn[1].body.lastEntryId, 'a2');
  assert.deepEqual(await chips(), ['继续', '建议' + (await page.evaluate(() => window.requests.findLastIndex(r => r.path === '/local/suggestions') + 1))]);

  // A reply quote is added to the composer: generated again with it (after the per-Bot interval).
  await page.evaluate(() => {
    document.getElementById('composer').insertAdjacentHTML('afterbegin',
      '<div class="sand-prompt-reply-pill" role="region"><span class="sand-reply-quote__body">upload.spec 修好了。</span></div>');
  });
  await page.waitForTimeout(4_800);
  const quoted = await generations();
  assert.equal(quoted.length, 3, 'a quote added is a new trigger');
  assert.deepEqual(quoted[2].body.quotes, [{ text: 'upload.spec 修好了。' }]);
  // Removed again: the answer of that state is reused, nothing new is asked.
  await page.evaluate(() => document.querySelector('.sand-prompt-reply-pill').remove());
  await page.waitForTimeout(1_000);
  assert.equal((await generations()).length, 3);

  // Inline completion: nothing for a /command, nothing during IME composition, asked for a plain draft.
  await page.focus('#input');
  await page.keyboard.type('/mod');
  await page.waitForTimeout(600);
  assert.equal(await completions(), 0, 'no completion for a /command');
  await page.evaluate(() => { document.getElementById('input').textContent = ''; });
  await page.evaluate(() => {
    const input = document.getElementById('input');
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    input.textContent = '帮我kan';
    const range = document.createRange(); range.selectNodeContents(input); range.collapse(false);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
  });
  await page.waitForTimeout(600);
  assert.equal(await completions(), 0, 'no completion while composing');
  await page.evaluate(() => {
    const input = document.getElementById('input');
    input.textContent = '帮我看下';
    const range = document.createRange(); range.selectNodeContents(input); range.collapse(false);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    input.dispatchEvent(new CompositionEvent('compositionend'));
    input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: false }));
  });
  await page.waitForTimeout(700);
  assert.equal(await completions(), 1, 'asked once the composition is committed');
  // Caret moved to the start: no new request for the same draft, and none when it changes there.
  await page.evaluate(() => {
    const input = document.getElementById('input');
    const range = document.createRange(); range.setStart(input.firstChild, 0); range.collapse(true);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    input.firstChild.textContent = '请帮我看下';
    range.setStart(input.firstChild, 1); range.collapse(true);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  await page.waitForTimeout(700);
  assert.equal(await completions(), 1, 'caret not at the end: no completion');
});

test('composer assist in a browser: the Host says the Bot is still working, asked again after the turn', { skip: !PW && 'set ROKBOT_TEST_PLAYWRIGHT_CORE' }, async t => {
  const { chromium } = createRequire(import.meta.url)(PW);
  const browser = await chromium.launch(process.env.ROKBOT_TEST_CHROMIUM ? { executablePath: process.env.ROKBOT_TEST_CHROMIUM } : {});
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(PAGE);
  await page.addScriptTag({ content: fs.readFileSync(path.join(REPO, 'mac/clients/desktop/composer-assist.cjs'), 'utf8') });
  await page.evaluate(() => {
    window.requests = [];
    window.RokBotComposerAssist.installComposerSuggestions({
      installSettings: false,
      getViewingAgentId: () => 'rokbot',
      request: async (path, body) => {
        window.requests.push({ path });
        if (path === '/local/suggestions/settings') return { enabled: true, aiEnabled: true, quickPhrases: [] };
        const n = window.requests.filter(r => r.path === '/local/suggestions').length;
        // The first answer: a tool call still runs on the Host although the screen looks idle.
        return n === 1
          ? { source: 'busy', enabled: true, aiEnabled: true, agentId: body.agentId, requestId: body.requestId, aiSuggestions: [] }
          : { source: 'model', enabled: true, aiEnabled: true, agentId: body.agentId, requestId: body.requestId, aiSuggestions: ['看下 lint'] };
      },
    });
  });
  const count = () => page.evaluate(() => window.requests.filter(r => r.path === '/local/suggestions').length);
  await page.waitForTimeout(900);
  assert.equal(await count(), 1);
  await page.waitForTimeout(2_500);
  assert.equal(await count(), 1, 'not polled right away');
  await page.waitForTimeout(3_500);
  assert.equal(await count(), 2, 'asked again once the turn should be over, without focus');
  await page.waitForTimeout(6_000);
  assert.equal(await count(), 2, 'and only once the answer came');
  // The prepared answer shows on focus without another request.
  await page.focus('#input');
  await page.waitForTimeout(400);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.rokbot-suggestions:not([hidden]) .rokbot-suggestions__chip')].map(el => el.textContent)), ['看下 lint']);
  assert.equal(await count(), 2);
});
