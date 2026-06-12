<!-- client/js/core/OnboardingWizard.svelte -->
<!-- Sprint 121 — Tam onboarding implementasyonu (Sprint 116 stub'ını replace eder) -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('OnboardingWizard');

  const STORAGE_KEY = 'bridge_onboarding_v3';

  interface Step {
    icon:  string;
    title: string;
    body:  string;
    tip?:  string;
  }

  const STEPS: Step[] = [
    {
      icon:  '👋',
      title: "Bridge'e Hoş Geldin",
      body:  "Bridge; güvenli, açık kaynaklı ve federasyon destekli bir sohbet platformudur. Bu kısa tur seni birkaç dakikada temel özelliklere alıştıracak.",
      tip:   'Dilediğinde Esc veya "Atla" ile çıkabilirsin.',
    },
    {
      icon:  '🔒',
      title: 'Uçtan Uca Şifreleme',
      body:  'E2E modunda mesajların yalnızca sen ve karşı tarafça okunabilir. DM penceresinde kilit simgesine tıklayarak etkinleştirebilirsin.',
      tip:   'E2EE varsayılan olarak kapalıdır — istediğin sohbette açabilirsin.',
    },
    {
      icon:  '🌐',
      title: 'Federasyon — Uzak Sunuculara Bağlan',
      body:  "Bridge; Mastodon ve diğer ActivityPub sunucularıyla konuşabilir. Sol çubukta yer küre simgesine tıklayarak uzak kullanıcıları takip edebilirsin.",
      tip:   '@kullanıcı@sunucu.com formatıyla uzak kullanıcıları arayabilirsin.',
    },
    {
      icon:  '🤖',
      title: 'Bot Marketi',
      body:  "Sunucuna müzik, anket, moderasyon ve daha fazlası için botlar ekleyebilirsin. Sunucu ayarlarından Bot Marketi'ni aç.",
      tip:   'Kendi botunu Bot SDK ile kolayca yazabilirsin.',
    },
    {
      icon:  '🎙️',
      title: 'Sesli Mesaj & Ekran Paylaşımı',
      body:  'Mesaj kutusunun yanındaki mikrofon simgesiyle sesli mesaj kaydedebilir, ses/video kanallarında ekranını paylaşabilirsin.',
      tip:   'Sesli mesajlar otomatik olarak metne dönüştürülür.',
    },
    {
      icon:  '🔍',
      title: 'Gelişmiş Arama & AI Özet',
      body:  "Ctrl+K ile anlık arama, kanal başlığındaki büyüteç ile mesaj araması yapabilirsin. AI kanal özetini kanal başlığındaki robot simgesinden açabilirsin.",
      tip:   'Arama: from:kullanıcı, before:2024-01-01 gibi filtreler desteklenir.',
    },
    {
      icon:  '⌨️',
      title: 'Klavye Kısayolları',
      body:  'Ctrl+K — arama  •  Ctrl+Shift+M — mikrofonu kapat  •  Ctrl+Shift+D — sesi kapat  •  Esc — modalı kapat',
      tip:   undefined,
    },
    {
      icon:  '🎉',
      title: 'Hazırsın!',
      body:  "Bridge'i keşfetmeye başlayabilirsin. Herhangi bir konuda yardıma ihtiyaç duyarsan Ayarlar → Yardım'dan dökümanlara ulaşabilirsin.",
      tip:   undefined,
    },
  ];

  let isVisible  = $state(false);
  let step       = $state(0);
  let animating  = $state(false);

  const total    = STEPS.length;
  const current  = $derived(STEPS[step]);
  const isLast   = $derived(step === total - 1);
  const progress = $derived(((step + 1) / total) * 100);

  function show(): void  { isVisible = true; }
  
  async function hide(): Promise<void>  { 
    isVisible = false; 
    await _persist(); 
  }

  function next(): void {
    if (animating) return;
    if (isLast) { hide(); return; }
    animating = true;
    setTimeout(() => { step += 1; animating = false; }, 180);
  }

  function prev(): void {
    if (animating || step === 0) return;
    animating = true;
    setTimeout(() => { step -= 1; animating = false; }, 180);
  }

  function goTo(i: number): void {
    if (animating || i === step) return;
    animating = true;
    setTimeout(() => { step = i; animating = false; }, 120);
  }

  /** Persist onboarding completion to server + localStorage */
  async function _persist(): Promise<void> {
    // Try localStorage first (offline support)
    try { 
      localStorage.setItem(STORAGE_KEY, 'done'); 
    } catch { 
      /* ignore */ 
    }

    // Also sync to server for multi-device support
    try {
      // Try to get serverId from global context or current URL
      let serverId = (window as Record<string, unknown>).__BRIDGE_SERVER_ID__ as string | undefined;
      
      // Fallback: extract from URL if in server context
      if (!serverId) {
        const match = window.location.pathname.match(/\/servers\/([a-zA-Z0-9-]+)/);
        if (match) serverId = match[1];
      }

      // Only call API if we have a serverId
      if (serverId) {
        const response = await fetch(`/api/servers/${serverId}/onboarding/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answers: { wizardStep: step } }),
        });

        if (!response.ok) {
          log.warn('Failed to persist onboarding to server', { status: response.status });
        }
      }
    } catch (err) {
      log.warn('Error persisting onboarding', err);
    }
  }

  function _handleKey(e: KeyboardEvent): void {
    if (!isVisible) return;
    if (e.key === 'Escape')      { hide(); return; }
    if (e.key === 'ArrowRight')  { next(); return; }
    if (e.key === 'ArrowLeft')   { prev(); return; }
  }

  onMount(() => {
    BridgeRegistry.register('showOnboardingWizard', show);
    BridgeRegistry.register('hideOnboardingWizard', hide);
    document.addEventListener('keydown', _handleKey);

    // İlk açılışta otomatik göster
    try {
      if (!localStorage.getItem(STORAGE_KEY)) {
        setTimeout(show, 800);
      }
    } catch { setTimeout(show, 800); }

    log.info('OnboardingWizard mounted');
  });

  onDestroy(() => {
    BridgeRegistry.unregister?.('showOnboardingWizard');
    BridgeRegistry.unregister?.('hideOnboardingWizard');
    document.removeEventListener('keydown', _handleKey);
  });
</script>

{#if isVisible}
<div
  class="ow-backdrop"
  role="dialog"
  aria-modal="true"
  aria-label="Onboarding sihirbazı"
  tabindex="-1"
  onclick={(e) => { if ((e.target as HTMLElement).classList.contains('ow-backdrop')) hide(); }}
  onkeydown={_handleKey}
>
  <div class="ow-card" class:animating>

    <!-- Kapat -->
    <button class="ow-close" onclick={hide} aria-label="Kapat">✕</button>

    <!-- Progress bar -->
    <div class="ow-progress-bar" role="progressbar" aria-valuenow={step + 1} aria-valuemax={total}>
      <div class="ow-progress-fill" style="width:{progress}%"></div>
    </div>

    <!-- Step dots -->
    <div class="ow-dots" role="tablist" aria-label="Adımlar">
      {#each STEPS as _, i}
        <button
          class="ow-dot"
          class:active={i === step}
          class:done={i < step}
          onclick={() => goTo(i)}
          role="tab"
          aria-selected={i === step}
          aria-label="Adım {i + 1}"
        ></button>
      {/each}
    </div>

    <!-- İçerik -->
    <div class="ow-body" class:animating>
      <div class="ow-icon" aria-hidden="true">{current.icon}</div>
      <h2 class="ow-title">{current.title}</h2>
      <p class="ow-text">{current.body}</p>
      {#if current.tip}
        <div class="ow-tip" role="note">
          <span class="ow-tip-icon" aria-hidden="true">💡</span>
          {current.tip}
        </div>
      {/if}
    </div>

    <!-- Adım sayacı -->
    <div class="ow-counter" aria-live="polite">{step + 1} / {total}</div>

    <!-- Butonlar -->
    <div class="ow-actions">
      {#if step > 0}
        <button class="ow-btn ow-btn-secondary" onclick={prev} aria-label="Önceki adım">
          ← Geri
        </button>
      {:else}
        <button class="ow-btn ow-btn-ghost" onclick={hide} aria-label="Onboarding'i atla">
          Atla
        </button>
      {/if}

      <button class="ow-btn ow-btn-primary" onclick={next} aria-label={isLast ? 'Tamamla' : 'Sonraki adım'}>
        {isLast ? '🎉 Başla!' : 'Devam →'}
      </button>
    </div>

  </div>
</div>
{/if}

<style>
.ow-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.72);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  animation: ow-fade-in 0.2s ease;
}

@keyframes ow-fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}

.ow-card {
  position: relative;
  width: 100%;
  max-width: 480px;
  background: var(--surface, #1e1f2e);
  border: 1px solid var(--border, rgba(120,120,255,0.18));
  border-radius: 20px;
  padding: 36px 32px 28px;
  box-shadow: 0 24px 80px rgba(0,0,0,0.6);
  animation: ow-slide-up 0.25s cubic-bezier(0.34,1.56,0.64,1);
}

@keyframes ow-slide-up {
  from { transform: translateY(32px) scale(0.96); opacity: 0; }
  to   { transform: translateY(0) scale(1);       opacity: 1; }
}

.ow-close {
  position: absolute;
  top: 14px;
  right: 14px;
  background: none;
  border: none;
  color: var(--muted, #888);
  font-size: 16px;
  cursor: pointer;
  padding: 6px 8px;
  border-radius: 6px;
  line-height: 1;
  transition: color 0.15s, background 0.15s;
}
.ow-close:hover { color: var(--text, #fff); background: rgba(255,255,255,0.08); }

.ow-progress-bar {
  height: 3px;
  background: rgba(255,255,255,0.08);
  border-radius: 2px;
  margin-bottom: 20px;
  overflow: hidden;
}
.ow-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent, #5b7fff), var(--accent-g, #00e0c6));
  border-radius: 2px;
  transition: width 0.3s ease;
}

.ow-dots {
  display: flex;
  gap: 6px;
  justify-content: center;
  margin-bottom: 28px;
}
.ow-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: none;
  background: rgba(255,255,255,0.15);
  cursor: pointer;
  padding: 0;
  transition: background 0.2s, transform 0.2s;
}
.ow-dot.active  { background: var(--accent, #5b7fff); transform: scale(1.3); }
.ow-dot.done    { background: var(--accent-g, #00e0c6); }

.ow-body { transition: opacity 0.18s; }
.ow-body.animating { opacity: 0; }

.ow-icon {
  font-size: 48px;
  text-align: center;
  margin-bottom: 16px;
  line-height: 1;
}

.ow-title {
  font-size: 22px;
  font-weight: 700;
  color: var(--text, #eeeeff);
  text-align: center;
  margin-bottom: 12px;
  line-height: 1.3;
}

.ow-text {
  font-size: 14px;
  color: var(--muted, #aaa);
  text-align: center;
  line-height: 1.65;
  margin-bottom: 16px;
}

.ow-tip {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  background: rgba(91,127,255,0.1);
  border: 1px solid rgba(91,127,255,0.2);
  border-radius: 10px;
  padding: 10px 14px;
  font-size: 12.5px;
  color: var(--text, #ccc);
  line-height: 1.5;
  margin-bottom: 8px;
}
.ow-tip-icon { font-size: 14px; flex-shrink: 0; margin-top: 1px; }

.ow-counter {
  text-align: center;
  font-size: 11px;
  color: var(--muted, #666);
  margin: 12px 0 20px;
  letter-spacing: 0.5px;
}

.ow-actions {
  display: flex;
  gap: 10px;
  justify-content: space-between;
}

.ow-btn {
  flex: 1;
  padding: 11px 20px;
  border-radius: 10px;
  border: none;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s, transform 0.15s, background 0.15s;
}
.ow-btn:hover  { opacity: 0.88; transform: translateY(-1px); }
.ow-btn:active { transform: translateY(0); }

.ow-btn-primary {
  background: linear-gradient(135deg, var(--accent, #5b7fff), #7b5ea7);
  color: #fff;
}
.ow-btn-secondary {
  background: rgba(255,255,255,0.06);
  color: var(--text, #ccc);
  border: 1px solid rgba(255,255,255,0.1);
}
.ow-btn-ghost {
  background: none;
  color: var(--muted, #888);
  border: 1px solid transparent;
}
.ow-btn-ghost:hover { color: var(--text, #ccc); background: rgba(255,255,255,0.05); }

@media (max-width: 480px) {
  .ow-card    { padding: 28px 20px 22px; border-radius: 16px; }
  .ow-title   { font-size: 19px; }
  .ow-icon    { font-size: 40px; }
}
</style>
