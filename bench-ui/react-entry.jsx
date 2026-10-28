import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

let nextId = 0;
const row = (id) => ({ id, author: 'User' + (id % 25), body: 'message-' + (id % 10) + ' lorem ipsum dolor sit amet ' + id });
const afterPaint = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

function MessageList() {
  const [items, setItems] = useState([]);
  const [query, setQuery] = useState('');
  const [draft, setDraftState] = useState('');
  const visible = useMemo(() => items.filter((item) => item.body.includes(query)), [items, query]);
  useEffect(() => {
    window.__bench = {
      async reset(count) {
        nextId = count;
        setQuery('');
        setItems(Array.from({ length: count }, (_, id) => row(id)));
        await afterPaint();
      },
      async append() {
        setItems((previous) => [...previous, row(nextId++)]);
        await afterPaint();
      },
      async appendBatch(count) {
        const batch = Array.from({ length: count }, () => row(nextId++));
        setItems((previous) => [...previous, ...batch]);
        await afterPaint();
      },
      async filter(value) {
        setQuery(value);
        await afterPaint();
      },
      async setDraft(value) {
        setDraftState(value);
        await afterPaint();
      },
    };
  }, []);
  return (
    <>
    <section id="composer"><input id="draft" value={draft} readOnly /><output id="preview">{draft}</output></section>
    <main id="rows">
      {visible.map((item) => <article data-mid={item.id} key={item.id}>
        <span className="author">{item.author}</span><span className="body">{item.body}</span>
      </article>)}
    </main>
    </>
  );
}
createRoot(document.getElementById('root')).render(<MessageList />);
