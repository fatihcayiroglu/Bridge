// client/js/core/group-dm-svelte.ts
// ADR-0008 Faz 2 — GroupDmPanel.svelte mount + geriye dönük uyumluluk shim
//
// group-dm.ts'teki tüm dışa aktarımlar BridgeRegistry üzerinden
// erişilebilir; mevcut socket kodu değişmez.
//
// Sprint 113

import { mount }          from 'svelte';
import GroupDmPanel        from './GroupDmPanel.svelte';
import { BridgeRegistry }  from './bridge-registry.ts';

let _panelInstance: ReturnType<typeof mount> | null = null;

// ── Mount ─────────────────────────────────────────────────────────────────

export function mountGroupDmPanel(targetId = 'dm-panel'): void {
  if (_panelInstance) return;

  let target = document.getElementById(targetId);
  if (!target) {
    target = document.createElement('div');
    target.id = targetId;
    document.body.appendChild(target);
  }

  _panelInstance = mount(GroupDmPanel, {
    target,
    props: {
      onClose: () => {
        const el = document.getElementById(targetId);
        if (el) el.style.display = 'none';
      },
    },
  });
}

// ── Geriye dönük uyumluluk ────────────────────────────────────────────────

export function openGroupDmPanel(): void {
  const el = document.getElementById('dm-panel');
  if (el) el.style.display = 'flex';
  void loadGroupDmList();
}

export async function loadGroupDmList(): Promise<void> {
  await BridgeRegistry.get('groupDmPanel:loadList')?.();
}

export function openGroupDm(group: Record<string, unknown>): void {
  BridgeRegistry.get('groupDmPanel:openGroupDm')?.(group);
}

// ── Bootstrap — mount timing ─────────────────────────────────────────────
//
// voice-svelte.ts ile aynı strateji (ADR-0008):
//
//   DOMContentLoaded — DOM hazır olduğunda paneli bağlar.
//     GroupDmPanel, socket bağımlılıklarını lazy getter ile çözümlediğinden
//     socket hazır olmadan mount edilmesi güvenlidir.
//
//   bridge:socket-ready — Modül geç yüklendiyse güvenlik ağı.
//     mountGroupDmPanel() guard (_panelInstance) çifte mount'u önler.

document.addEventListener('DOMContentLoaded',   () => mountGroupDmPanel());
document.addEventListener('bridge:socket-ready', () => mountGroupDmPanel());
