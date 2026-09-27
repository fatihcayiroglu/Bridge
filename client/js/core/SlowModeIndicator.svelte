<!-- client/js/core/SlowModeIndicator.svelte -->
<!--
  FAZ 8/6 — YAVAŞ MOD GÖRÜNÜR HALE GETİRİLDİ.

  Sunucu yavaş modu ZATEN uyguluyordu (`socket/handlers/messages-send.ts`:
  `checkSlowmode` → `error:slowmode { remaining, channelId }`), ama kullanıcı
  tarafında HİÇBİR açıklama yoktu: mesaj sessizce gitmiyordu ve neden
  olduğunu anlamanın yolu yoktu.

  Bu bileşen gerçek bir uygulamaydı ama hiçbir giriş noktasından import
  edilmiyordu ve `setSlowMode` / `startSlowModeCooldown` sözleşmesini ÇAĞIRAN
  yoktu. Arka uç davranışı DEĞİŞTİRİLMEDİ — yalnızca görünür kılındı.
-->
<script lang="ts">
  import { t } from './i18n/reactive.svelte.ts';
  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';

  let cooldown       = $state(0);
  let slowModeSecs   = $state(0);
  let isActive       = $state(false);

  let _timer: ReturnType<typeof setInterval> | null = null;

  function startCooldown(secs: number) {
    cooldown = secs; isActive = true;
    if (_timer) clearInterval(_timer);
    _timer = setInterval(() => {
      cooldown--;
      if (cooldown <= 0) {
        cooldown = 0; isActive = false;
        if (_timer) { clearInterval(_timer); _timer = null; }
      }
    }, 1000);
  }

  function setSlowMode(secs: number) {
    slowModeSecs = secs;
  }

  let pct = $derived(slowModeSecs > 0 ? (cooldown / slowModeSecs) * 100 : 0);
  // Tam cümle: rozet dar, ama ekran okuyucu ve tooltip NEDENİNİ söylemeli.
  // "Sessizce gitmedi" en kötü hatadır; kullanıcı ne olduğunu bilmelidir.
  let label = $derived(
    isActive
      ? t('slow_mode_cooldown', 'Yavaş mod açık. {seconds} saniye sonra tekrar mesaj gönderebilirsiniz.', { seconds: cooldown })
      : slowModeSecs > 0
        ? t('slow_mode_interval', 'Yavaş mod açık. Bu kanalda {seconds} saniyede bir mesaj gönderilebilir.', { seconds: slowModeSecs })
        : ''
  );

  onMount(() => {
    BridgeRegistry.register('startSlowModeCooldown', startCooldown);
    BridgeRegistry.register('setSlowMode', setSlowMode);
  });
  onDestroy(() => {
    if (_timer) clearInterval(_timer);
    // Kayıtlar BIRAKILIR: sökülmüş bir bileşene işaret eden kayıt, çağıranın
    // sessizce hiçbir şey yapmamasına yol açar.
    BridgeRegistry.unregister?.('startSlowModeCooldown');
    BridgeRegistry.unregister?.('setSlowMode');
  });
</script>

{#if slowModeSecs > 0}
<div class="slow-mode {isActive ? 'active' : ''}" role="status" aria-live="polite" aria-label={label} title={label}>
  <div class="sm-icon" aria-hidden="true">🐌</div>
  {#if isActive}
    <div class="sm-bar">
      <div class="sm-fill" style="width:{pct}%"></div>
    </div>
    <span class="sm-secs">{cooldown}s</span>
  {:else}
    <span class="sm-secs">{slowModeSecs}s</span>
  {/if}
</div>
{/if}

<style>
.slow-mode {
  display: flex; align-items: center; gap: 5px;
  padding: 2px 8px; border-radius: 4px;
  background: var(--bridge-surface2, #232636);
  font-size: .75rem; color: var(--bridge-muted, #8a91ad);
}
.slow-mode.active { color: var(--bridge-yellow, #faa61a); }
.sm-bar {
  width: 48px; height: 4px; border-radius: 2px;
  background: var(--bridge-surface3, #2c3048); overflow: hidden;
}
.sm-fill {
  height: 100%; border-radius: 2px;
  background: var(--bridge-yellow, #faa61a);
  transition: width 1s linear;
}
.sm-icon { font-size: .8rem; }
</style>
