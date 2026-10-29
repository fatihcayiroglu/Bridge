import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeAiProvider, hashEmbed } from './lib/fake-ai.mjs';
import { VECTOR_EDIT_FIXTURE, VECTOR_EDIT_THRESHOLD, vectorEditGeometry } from './lib/vector-edit-fixture.mjs';

const cosine = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0)
  / Math.hypot(...a) / Math.hypot(...b);

for (const [key, mustMatch] of [['oldBefore', true], ['oldAfter', false], ['newBefore', false], ['newAfter', true]]) {
  test(`the edit search control discriminates ${key}`, () => {
    const similarity = vectorEditGeometry(768)[key];
    assert.equal(similarity > VECTOR_EDIT_THRESHOLD, mustMatch);
  });
}

test('the former tagged wording can match a correctly replaced vector', () => {
  const tag = '00000001'; // Controlled reproduction, not the unarchived CI tag.
  const query = `draft${tag}`;
  const after = `kangaroo final${tag} plan`;
  assert.ok(!after.includes(query));
  assert.ok(cosine(hashEmbed(query, 768), hashEmbed(after, 768)) > VECTOR_EDIT_THRESHOLD);
});

test('incompatible embedding geometry fails the fixture prerequisite', () => {
  assert.equal(vectorEditGeometry(2).valid, false);
  assert.equal(vectorEditGeometry(768).valid, true);
});

test('the actual HTTP embedder preserves all four fixture controls', async () => {
  const provider = new FakeAiProvider({ port: 0, dim: 768 });
  await provider.start();
  try {
    const address = provider.server.address();
    assert.ok(address && typeof address === 'object');
    const embed = async prompt => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/embeddings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'lab-embed', prompt }),
      });
      assert.equal(response.status, 200);
      return (await response.json()).embedding;
    };
    const fixture = VECTOR_EDIT_FIXTURE;
    const [before, after, oldQuery, newQuery] = await Promise.all(
      [fixture.before, fixture.after, fixture.oldQuery, fixture.newQuery].map(embed));
    assert.ok(cosine(oldQuery, before) > VECTOR_EDIT_THRESHOLD);
    assert.ok(cosine(oldQuery, after) < VECTOR_EDIT_THRESHOLD);
    assert.ok(cosine(newQuery, before) < VECTOR_EDIT_THRESHOLD);
    assert.ok(cosine(newQuery, after) > VECTOR_EDIT_THRESHOLD);
    assert.equal(provider.requests.length, 4);
  } finally {
    await provider.stop();
  }
});
