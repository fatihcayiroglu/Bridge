<!-- client/js/core/SkeletonLoader.svelte -->
<!-- Sprint 116 — skeleton-loading.ts → Svelte 5 Runes -->
<script lang="ts">
  type SkeletonType = 'message' | 'channel' | 'member' | 'card' | 'text' | 'avatar';

  interface Props {
    type?: SkeletonType;
    count?: number;
    animated?: boolean;
  }

  let { type = 'message', count = 5, animated = true }: Props = $props();
</script>

<div class="skeleton-list" aria-busy="true" aria-label="Yükleniyor" role="list">
  {#each Array(count) as _, i}
    <div class="skeleton-item skeleton-{type} {animated ? 'animated' : ''}" role="listitem">
      {#if type === 'message'}
        <div class="sk-avatar"></div>
        <div class="sk-body">
          <div class="sk-line sk-name" style="width: {55 + (i * 7) % 25}%"></div>
          <div class="sk-line sk-text" style="width: {70 + (i * 11) % 20}%"></div>
          {#if i % 3 === 0}
            <div class="sk-line sk-text" style="width: {40 + (i * 9) % 30}%"></div>
          {/if}
        </div>
      {:else if type === 'channel'}
        <div class="sk-icon-sm"></div>
        <div class="sk-line sk-ch-name" style="width: {50 + (i * 13) % 30}%"></div>
      {:else if type === 'member'}
        <div class="sk-avatar sk-avatar-sm"></div>
        <div class="sk-body">
          <div class="sk-line" style="width: {40 + (i * 7) % 25}%"></div>
        </div>
      {:else if type === 'card'}
        <div class="sk-card-img"></div>
        <div class="sk-line" style="width: 80%; margin-top:8px"></div>
        <div class="sk-line" style="width: 60%"></div>
      {:else}
        <div class="sk-line" style="width: {60 + (i * 8) % 35}%"></div>
      {/if}
    </div>
  {/each}
</div>

<style>
.skeleton-list { display: flex; flex-direction: column; gap: 4px; padding: 8px; }
.skeleton-item { display: flex; align-items: flex-start; gap: 10px; padding: 8px; border-radius: 6px; }

.sk-avatar {
  width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0;
  background: var(--bridge-skel, #2c2f33);
}
.sk-avatar-sm { width: 28px; height: 28px; }
.sk-icon-sm   { width: 18px; height: 18px; border-radius: 3px; background: var(--bridge-skel, #2c2f33); flex-shrink:0; }
.sk-body      { flex: 1; display: flex; flex-direction: column; gap: 6px; padding-top: 4px; }
.sk-card-img  { width: 100%; height: 80px; border-radius: 6px; background: var(--bridge-skel, #2c2f33); }
.sk-line {
  height: 12px; border-radius: 4px;
  background: var(--bridge-skel, #2c2f33);
}
.sk-name { height: 14px; width: 30%; }
.sk-text { height: 11px; }
.sk-ch-name { height: 13px; align-self: center; }

.animated .sk-avatar,
.animated .sk-line,
.animated .sk-icon-sm,
.animated .sk-card-img {
  animation: shimmer 1.4s infinite linear;
  background: linear-gradient(
    90deg,
    var(--bridge-skel, #2c2f33) 25%,
    var(--bridge-skel2, #393c40) 50%,
    var(--bridge-skel, #2c2f33) 75%
  );
  background-size: 200% 100%;
}
@keyframes shimmer { to { background-position: -200% 0; } }
</style>
