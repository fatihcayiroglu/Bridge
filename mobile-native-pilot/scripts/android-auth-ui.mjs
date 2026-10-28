import assert from 'node:assert/strict';
const decode = text => text.replace(/&(amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, (_, entity) => {
  const named={amp:'&',quot:'"',apos:"'",lt:'<',gt:'>'};
  return named[entity] ?? String.fromCodePoint(entity.startsWith('#x') ? parseInt(entity.slice(2),16) : Number(entity.slice(1)));
});
// UIAutomator's native accessibility hierarchy, never page script or a callback.
export function nodesOf(xml) {
  assert.match(xml, /<hierarchy\b/, 'NATIVE_UI_HIERARCHY_REQUIRED');
  return [...xml.matchAll(/<node\b([^>]+)>/g)].map(([,attrs]) => Object.fromEntries(
    [...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map(([,key,value])=>[key,decode(value)])));
}
export function namedNode(nodes, label, packages) {
  const matches=nodes.filter(n=>packages.includes(n.package) && n.enabled==='true'
    && (n.text===label || n['content-desc']===label));
  assert.ok(matches.length<=1,'AMBIGUOUS_NATIVE_CONTROL');
  return matches[0] ?? null;
}
export function centerOf(node) {
  const m=/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(node?.bounds ?? '');
  assert.ok(m,'NATIVE_CONTROL_BOUNDS_REQUIRED');
  const [x1,y1,x2,y2]=m.slice(1).map(Number);
  assert.ok(x2>x1 && y2>y1,'EMPTY_NATIVE_CONTROL');
  return [Math.floor((x1+x2)/2),Math.floor((y1+y2)/2)];
}
