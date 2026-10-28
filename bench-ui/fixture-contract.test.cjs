'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { JSDOM } = require('jsdom');

async function waitForBench(win) {
  for (let i = 0; i < 100; i++) {
    if (typeof win.__bench?.reset === 'function') return win.__bench;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Fixture did not initialize its benchmark API');
}

for (const framework of ['svelte', 'react']) {
  test(framework + ' fixture executes every comparison scenario with actual DOM state', { timeout: 30000 }, async () => {
    const html = '<!doctype html><html><body><div id="root"></div></body></html>';
    const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });
    try {
      dom.window.eval(readFileSync(join(__dirname, 'generated', framework + '.js'), 'utf8'));
      const bench = await waitForBench(dom.window);
      for (const size of [1000, 10000]) {
        await bench.reset(size);
        assert.equal(dom.window.document.querySelectorAll('#rows article').length, size);
        await bench.append();
        assert.equal(dom.window.document.querySelectorAll('#rows article').length, size + 1);
        await bench.appendBatch(100);
        assert.equal(dom.window.document.querySelectorAll('#rows article').length, size + 101);
        await bench.filter('message-7');
        assert.equal(dom.window.document.querySelectorAll('#rows article').length, size / 10 + 10);
        const draft = 'test-' + framework + '-' + size;
        await bench.setDraft(draft);
        assert.equal(dom.window.document.querySelector('#preview').textContent, draft);
      }
    } finally {
      dom.window.close();
    }
  });
}
