<script>
  import { onMount } from 'svelte';
  let items = $state([]);
  let query = $state('');
  let draft = $state('');
  let nextId = 0;
  let visible = $derived(items.filter((item) => item.body.includes(query)));
  const row = (id) => ({ id, author: 'User' + (id % 25), body: 'message-' + (id % 10) + ' lorem ipsum dolor sit amet ' + id });
  const afterPaint = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  onMount(() => {
    window.__bench = {
      async reset(count) {
        nextId = count;
        query = '';
        items = Array.from({ length: count }, (_, id) => row(id));
        await afterPaint();
      },
      async append() {
        items = [...items, row(nextId++)];
        await afterPaint();
      },
      async appendBatch(count) {
        const batch = Array.from({ length: count }, () => row(nextId++));
        items = [...items, ...batch];
        await afterPaint();
      },
      async filter(value) {
        query = value;
        await afterPaint();
      },
      async setDraft(value) {
        draft = value;
        await afterPaint();
      },
    };
  });
</script>
<section id="composer"><input id="draft" value={draft} readonly /><output id="preview">{draft}</output></section>
<main id="rows">
  {#each visible as item (item.id)}
    <article data-mid={item.id}><span class="author">{item.author}</span><span class="body">{item.body}</span></article>
  {/each}
</main>
