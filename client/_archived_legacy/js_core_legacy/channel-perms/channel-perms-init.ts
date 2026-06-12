// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/ChannelPermsInitPanel.svelte
//              client/js/core/channel-perms-init-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/channel-perms/channel-perms-init.ts
// Sprint 34: ESM wiring — import all modal modules and inject deps.
//
// Bu dosya app bootstrap'ında bir kez çağrılır:
//   import { initChannelPerms } from './channel-perms/channel-perms-init.ts';
//   initChannelPerms({ getServer, toast, apiFetch, getAPI, socket, ... });

import { initModalActions, ActionDeps }   from './modal-actions';
import { initModalAuditSync, AuditSyncDeps } from './modal-audit-sync';
import { initModalCore, CoreDeps }        from './modal-core';
import {
  openChannelPermsModal,
  saveChannelPerms,
  chpermsShowInheritance,
} from './modal-core';
import {
  chpermsTab,
  chpermsLoadSyncList,
  chpermsSyncSelectAll,
  chpermsSyncSelectCat,
  chpermsBulkSyncPreview,
  chpermsBulkSync,
  chpermsExport,
  chpermsImportClick,
  chpermsImportFile,
} from './modal-audit-sync';
import {
  chpermsApplyTemplate,
  chpermsOpenUserSearch,
  chpermsSearchUser,
  chpermsAddUser,
  chpermsSelectRole,
  chpermsGrantAll,
  chpermsDenyAll,
  chpermsResetAll,
  chpermsSyncServer,
  chpermsRemoveRow,
} from './modal-actions';

// ── App-level dep types ───────────────────────────────────────────────────────
import type { ChpermsState, OverrideState } from './modal-state';
import { setPermGroups } from './modal-state';
import type { PermGroup, PermTemplate } from '../channel-perms-data';

export interface ChannelPermsBootstrapDeps {
  getState:            () => ChpermsState;
  clearDirty:          () => void;
  markDirty:           () => void;
  readRow:             (tr: HTMLTableRowElement) => OverrideState;
  rowIsDirty:          (id: string, cur: OverrideState) => boolean;
  updateSaveInfo:      () => void;
  buildMatrix:         () => string;
  setCurrentChannelId: (id: string) => void;
  getCurrentChannelId: () => string | null;
  loadAudit:           (channelId: string) => Promise<void>;
  applyAuditFilter:    () => void;
  resetAuditFilter:    () => void;
  toast:               (msg: string, type: string, duration?: number) => void;
  apiFetch:            (url: string, opts?: RequestInit) => Promise<Response>;
  getAPI:              () => string;
  getServer:           () => { _id: string; channels?: Array<{ _id: string; name: string }> } | null;
  socket?:             { on: Function; off: Function };
  loadServerChannels?: (serverId: string) => Promise<void>;
  renderChannels?:     () => void;
  permGroups:          PermGroup[];
  permTemplates:       PermTemplate[];
}

export function initChannelPerms(deps: ChannelPermsBootstrapDeps): void {
  // permGroups'u modal-state'e enjekte et (window.PERM_GROUPS erişimini kaldırır)
  setPermGroups(deps.permGroups);

  // Shared helper
  const getServerId = (): string | null => deps.getServer()?._id ?? null;

  // ── modal-actions ──────────────────────────────────────────────────────────
  const actionDeps: ActionDeps = {
    getState:       deps.getState,
    markDirty:      deps.markDirty,
    updateSaveInfo: deps.updateSaveInfo,
    buildMatrix:    deps.buildMatrix,
    toast:          deps.toast,
    apiFetch:       deps.apiFetch,
    getAPI:         deps.getAPI,
    getServerId,
    permGroups:     deps.permGroups,
    permTemplates:  deps.permTemplates,
  };
  initModalActions(actionDeps);

  // ── modal-audit-sync ───────────────────────────────────────────────────────
  const auditSyncDeps: AuditSyncDeps = {
    getState:            deps.getState,
    getCurrentChannelId: deps.getCurrentChannelId,
    setCurrentChannelId: deps.setCurrentChannelId,
    loadAudit:           deps.loadAudit,
    applyAuditFilter:    deps.applyAuditFilter,
    resetAuditFilter:    deps.resetAuditFilter,
    openModal:           openChannelPermsModal,
    toast:               deps.toast,
    apiFetch:            deps.apiFetch,
    getAPI:              deps.getAPI,
    getServerId,
    permGroups:          deps.permGroups,
  };
  initModalAuditSync(auditSyncDeps);

  // ── modal-core ─────────────────────────────────────────────────────────────
  const coreDeps: CoreDeps = {
    getState:            deps.getState,
    clearDirty:          deps.clearDirty,
    readRow:             deps.readRow,
    rowIsDirty:          deps.rowIsDirty,
    updateSaveInfo:      deps.updateSaveInfo,
    buildMatrix:         deps.buildMatrix,
    setCurrentChannelId: deps.setCurrentChannelId,
    markDirty:           deps.markDirty,
    // Cross-module function refs
    chpermsTab,
    chpermsSelectRole,
    chpermsGrantAll,
    chpermsDenyAll,
    chpermsResetAll,
    chpermsSyncServer,
    chpermsRemoveRow,
    chpermsOpenUserSearch,
    chpermsApplyTemplate,
    chpermsSyncSelectAll,
    chpermsBulkSyncPreview,
    chpermsExport,
    chpermsImportClick,
    chpermsApplyAuditFilter: deps.applyAuditFilter,
    chpermsResetAuditFilter: deps.resetAuditFilter,
    chpermsShowInheritance,
    // Globals
    toast:               deps.toast,
    apiFetch:            deps.apiFetch,
    getAPI:              deps.getAPI,
    getServer:           deps.getServer,
    socket:              deps.socket,
    loadServerChannels:  deps.loadServerChannels,
    renderChannels:      deps.renderChannels,
    permGroups:          deps.permGroups,
    permTemplates:       deps.permTemplates,
  };
  initModalCore(coreDeps);
}

// ── Re-export public API ──────────────────────────────────────────────────────
// Consumers import from here, not the individual module files.
export {
  openChannelPermsModal,
  saveChannelPerms,
  chpermsShowInheritance,
  chpermsTab,
  chpermsLoadSyncList,
  chpermsSyncSelectAll,
  chpermsSyncSelectCat,
  chpermsBulkSyncPreview,
  chpermsBulkSync,
  chpermsExport,
  chpermsImportClick,
  chpermsImportFile,
  chpermsApplyTemplate,
  chpermsOpenUserSearch,
  chpermsSearchUser,
  chpermsAddUser,
  chpermsSelectRole,
  chpermsGrantAll,
  chpermsDenyAll,
  chpermsResetAll,
  chpermsSyncServer,
  chpermsRemoveRow,
};
