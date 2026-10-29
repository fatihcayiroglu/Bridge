import { hashEmbed } from './fake-ai.mjs';

// Fixed within a newly isolated server. Random suffixes can alias different
// words to one hashed feature, invalidating an old/new search negative control.
export const VECTOR_EDIT_FIXTURE = Object.freeze({
  before: 'kangaroo bridgevectorprevious plan',
  after: 'kangaroo bridgevectorreplacement plan',
  oldQuery: 'bridgevectorprevious',
  newQuery: 'bridgevectorreplacement',
});

export const VECTOR_EDIT_THRESHOLD = 0.3; // Unchanged production default.

export function vectorEditGeometry(dim) {
  const { before, after, oldQuery, newQuery } = VECTOR_EDIT_FIXTURE;
  const cosine = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0)
    / Math.hypot(...a) / Math.hypot(...b);
  const similarity = (query, text) => cosine(hashEmbed(query, dim), hashEmbed(text, dim));
  const evidence = {
    oldBefore: similarity(oldQuery, before), oldAfter: similarity(oldQuery, after),
    newBefore: similarity(newQuery, before), newAfter: similarity(newQuery, after),
  };
  return { ...evidence, valid: Object.values(evidence).every(Number.isFinite)
    && evidence.oldBefore > VECTOR_EDIT_THRESHOLD && evidence.newAfter > VECTOR_EDIT_THRESHOLD
    && evidence.oldAfter < VECTOR_EDIT_THRESHOLD && evidence.newBefore < VECTOR_EDIT_THRESHOLD };
}
