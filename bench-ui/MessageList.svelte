<script>
  import { onMount } from 'svelte';
  let items = $state([]);
  let query = $state('');
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
      async filter(value) {
        query = value;
        await afterPaint();
      },
    };
  });
</script>
<main id="rows">
  {#each visible as item (item.id)}
    <article data-mid={item.id}><span class="author">{item.author}</span><span class="body">{item.body}</span></article>
  {/each}
</main>
