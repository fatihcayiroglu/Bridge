"use strict";
(() => {
  // mobile/capacitor-bridge.ts
  if (typeof Capacitor === "undefined") {
    console.debug("[Bridge Mobile] Capacitor bulunamad\u0131, native mod\xFCl devre d\u0131\u015F\u0131.");
  } else {
    let handleDeepLink = function(url) {
      if (!url) return;
      let parsed;
      try {
        parsed = new URL(url);
      } catch (_) {
        return;
      }
      const isCustomScheme = parsed.protocol === "bridge:";
      const rawPath = isCustomScheme ? (parsed.hostname + parsed.pathname).replace(/^\/+/, "") : parsed.pathname.replace(/^\/+/, "");
      const parts = rawPath.split("/").filter(Boolean);
      const section = parts[0];
      const rest = parts.slice(1);
      const navPayload = (() => {
        switch (section) {
          case "channel":
            return { type: "navigate:channel", channelId: rest[0] };
          case "dm":
            return { type: "navigate:dm", userId: rest[0] };
          case "user":
            return { type: "navigate:profile", userId: rest[0] };
          case "server":
            return rest[1] === "channel" ? { type: "navigate:channel", serverId: rest[0], channelId: rest[2] } : { type: "navigate:server", serverId: rest[0] };
          case "invite":
            return { type: "navigate:invite", code: rest[0] };
          case "activity":
            return { type: "navigate:activity", channelId: rest[0], activityId: rest[1] };
          case "settings":
            return { type: "navigate:settings", tab: rest[0] ?? "account" };
          case "auth":
            if (rest[0] === "callback") {
              const idx = url.indexOf("?");
              const qs = idx !== -1 ? url.slice(idx + 1) : "";
              return { type: "auth:callback", token: new URLSearchParams(qs).get("token") };
            }
            return null;
          default:
            console.warn("[Bridge Mobile] Bilinmeyen deep link:", section, "| URL:", url);
            return null;
        }
      })();
      if (navPayload) {
        void bridgeHaptic.light();
        window.dispatchEvent(new CustomEvent("bridge:deeplink", { detail: navPayload }));
        console.debug("[Bridge Mobile] Deep link dispatched:", navPayload);
      }
    }, formatPhoto = function(photo) {
      const ext = (photo.format ?? "jpeg").toLowerCase();
      const mimeType = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg";
      const dataUrl = photo.dataUrl ?? `data:${mimeType};base64,${photo.base64String ?? ""}`;
      return {
        dataUrl,
        mimeType,
        fileName: `bridge_${Date.now()}.${ext}`,
        toBlob() {
          const base64 = dataUrl.split(",")[1];
          const binary = atob(base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          return new Blob([bytes], { type: mimeType });
        },
        toFile() {
          return new File([this.toBlob()], this.fileName, { type: mimeType });
        }
      };
    }, createOfflineBanner = function() {
      const el = document.createElement("div");
      el.id = "offline-banner";
      Object.assign(el.style, {
        position: "fixed",
        top: "0",
        left: "0",
        right: "0",
        background: "#ed4245",
        color: "#fff",
        textAlign: "center",
        padding: "8px",
        zIndex: "9999",
        display: "none",
        fontSize: "13px"
      });
      document.body.prepend(el);
      return el;
    };
    const {
      PushNotifications,
      LocalNotifications,
      StatusBar,
      SplashScreen,
      Keyboard,
      Haptics,
      Network,
      App,
      BiometricAuth,
      Camera,
      Badge,
      Share
    } = Capacitor.Plugins;
    window.addEventListener("DOMContentLoaded", async () => {
      try {
        await SplashScreen?.hide({ fadeOutDuration: 300 });
      } catch (_) {
      }
    });
    async function applyStatusBar(isDark) {
      try {
        await StatusBar?.setStyle({ style: isDark ? "Dark" : "Light" });
        await StatusBar?.setBackgroundColor({ color: isDark ? "#1a1a2e" : "#ffffff" });
      } catch (_) {
      }
    }
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
    applyStatusBar(prefersDark.matches);
    prefersDark.addEventListener("change", (e) => applyStatusBar(e.matches));
    if (Keyboard) {
      Keyboard.addListener("keyboardWillShow", (info) => {
        document.documentElement.style.setProperty("--keyboard-height", `${info.keyboardHeight}px`);
        document.body.classList.add("keyboard-open");
      });
      Keyboard.addListener("keyboardWillHide", () => {
        document.documentElement.style.setProperty("--keyboard-height", "0px");
        document.body.classList.remove("keyboard-open");
      });
    }
    const bridgeHaptic = {
      light: () => Haptics?.impact({ style: "Light" }).catch(() => {
      }) ?? Promise.resolve(),
      medium: () => Haptics?.impact({ style: "Medium" }).catch(() => {
      }) ?? Promise.resolve(),
      success: () => Haptics?.notification({ type: "Success" }).catch(() => {
      }) ?? Promise.resolve(),
      warning: () => Haptics?.notification({ type: "Warning" }).catch(() => {
      }) ?? Promise.resolve(),
      error: () => Haptics?.notification({ type: "Error" }).catch(() => {
      }) ?? Promise.resolve()
    };
    window.bridgeHaptic = bridgeHaptic;
    document.addEventListener("click", (e) => {
      if (e.target.closest("#sendButton, .send-btn, [data-haptic]")) {
        void bridgeHaptic.light();
      }
    });
    const bridgeBadge = {
      _count: 0,
      async set(count) {
        this._count = Math.max(0, count);
        try {
          if (Badge) await Badge.set({ count: this._count });
        } catch (_) {
        }
        window.dispatchEvent(new CustomEvent("bridge:badge", { detail: { count: this._count } }));
      },
      async increment() {
        await this.set(this._count + 1);
      },
      async clear() {
        await this.set(0);
        const jwt = localStorage.getItem("bridge_token");
        if (jwt) {
          fetch("/api/mobile/push/badge/clear", {
            method: "POST",
            headers: { "Authorization": `Bearer ${jwt}` }
          }).catch(() => {
          });
        }
      }
    };
    window.bridgeBadge = bridgeBadge;
    async function setupPushNotifications() {
      if (!PushNotifications) return;
      const permission = await PushNotifications.requestPermissions();
      if (permission.receive !== "granted") {
        console.warn("[Bridge Mobile] Push izni verilmedi");
        return;
      }
      await PushNotifications.register();
      PushNotifications.addListener("registration", async (token) => {
        try {
          const jwt = localStorage.getItem("bridge_token");
          if (!jwt) return;
          await fetch("/api/mobile/push/register-native", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${jwt}` },
            body: JSON.stringify({ token: token.value, platform: Capacitor.getPlatform() })
          });
        } catch (err) {
          console.error("[Bridge Mobile] Token kayd\u0131 ba\u015Far\u0131s\u0131z:", err);
        }
      });
      PushNotifications.addListener("pushNotificationReceived", (notification) => {
        void showLocalNotification(notification.title ?? "", notification.body ?? "", notification.data ?? {});
        void bridgeBadge.increment();
      });
      PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
        const data = action.notification.data;
        void bridgeBadge.clear();
        if (data?.channelId) {
          window.dispatchEvent(new CustomEvent("bridge:navigate", {
            detail: { channelId: data.channelId, serverId: data.serverId }
          }));
        }
      });
    }
    async function showLocalNotification(title, body, data) {
      if (!LocalNotifications) return;
      try {
        await LocalNotifications.schedule({
          notifications: [{
            title,
            body,
            id: Date.now(),
            extra: data,
            smallIcon: "ic_stat_bridge",
            iconColor: "#2d9cdb"
          }]
        });
      } catch (_) {
      }
    }
    if (App) {
      App.addListener("appUrlOpen", (event) => handleDeepLink(event.url));
      App.getLaunchUrl().then((result) => {
        if (result?.url) handleDeepLink(result.url);
      }).catch(() => {
      });
    }
    window.bridgeDeepLink = { handle: handleDeepLink };
    const bridgeBiometric = {
      async isAvailable() {
        if (!BiometricAuth) return false;
        try {
          const r = await BiometricAuth.checkBiometry();
          return r.isAvailable;
        } catch (_) {
          return false;
        }
      },
      async authenticate(reason) {
        if (!BiometricAuth) return { success: false, error: "plugin_unavailable" };
        try {
          await BiometricAuth.authenticate({
            reason: reason ?? "Bridge'e giri\u015F yapmak i\xE7in kimli\u011Finizi do\u011Frulay\u0131n",
            cancelTitle: "\u0130ptal",
            allowDeviceCredential: true,
            iosFallbackTitle: "\u015Eifre Kullan"
          });
          return { success: true };
        } catch (err) {
          const e = err;
          return { success: false, error: e.code ?? e.message };
        }
      },
      isEnabled() {
        return localStorage.getItem("bridge_biometric_enabled") === "true";
      },
      enable() {
        localStorage.setItem("bridge_biometric_enabled", "true");
      },
      disable() {
        localStorage.removeItem("bridge_biometric_enabled");
      }
    };
    window.bridgeBiometric = bridgeBiometric;
    window.addEventListener("load", async () => {
      const jwt = localStorage.getItem("bridge_token");
      if (jwt && bridgeBiometric.isEnabled()) {
        const available = await bridgeBiometric.isAvailable();
        if (available) window.dispatchEvent(new CustomEvent("bridge:biometric:prompt"));
      }
    });
    const bridgeCamera = {
      takePhoto: () => _capture("CAMERA"),
      pickFromGallery: () => _capture("PHOTOS"),
      async pickMultiple() {
        if (!Camera) return [];
        try {
          const result = await Camera.pickImages({ quality: 85, limit: 10 });
          return (result.photos ?? []).map(formatPhoto);
        } catch (err) {
          const e = err;
          if (e.message?.includes("cancelled") || e.message?.includes("User cancelled")) return [];
          console.error("[Bridge Mobile] \xC7oklu galeri hatas\u0131:", err);
          return [];
        }
      },
      async isAvailable() {
        if (!Camera) return false;
        try {
          const p = await Camera.checkPermissions();
          return p.camera !== "denied";
        } catch (_) {
          return false;
        }
      },
      async requestPermissions() {
        if (!Camera) return false;
        try {
          const r = await Camera.requestPermissions({ permissions: ["camera", "photos"] });
          return r.camera === "granted" || r.photos === "granted";
        } catch (_) {
          return false;
        }
      }
    };
    async function _capture(source) {
      if (!Camera) return null;
      try {
        const photo = await Camera.getPhoto({
          quality: 85,
          allowEditing: false,
          resultType: "dataUrl",
          source,
          saveToGallery: false
        });
        return formatPhoto(photo);
      } catch (err) {
        const e = err;
        if (e.message?.includes("cancelled") || e.message?.includes("User cancelled")) return null;
        console.error("[Bridge Mobile] Kamera/galeri hatas\u0131:", err);
        return null;
      }
    }
    window.bridgeCamera = bridgeCamera;
    document.addEventListener("click", async (e) => {
      const trigger = e.target.closest("[data-native-camera], [data-native-gallery]");
      if (!trigger) return;
      e.preventDefault();
      e.stopPropagation();
      void bridgeHaptic.light();
      const isCamera = trigger.hasAttribute("data-native-camera");
      const photo = isCamera ? await bridgeCamera.takePhoto() : await bridgeCamera.pickFromGallery();
      if (photo) {
        trigger.dispatchEvent(new CustomEvent("bridge:file:selected", {
          bubbles: true,
          detail: { file: photo.toFile(), photo }
        }));
      }
    });
    const bridgeShare = {
      async share(opts) {
        if (Share) {
          try {
            await Share.share({ title: opts.title, text: opts.text, url: opts.url, dialogTitle: "Payla\u015F" });
            return true;
          } catch (_) {
          }
        }
        if (navigator.share) {
          try {
            await navigator.share(opts);
            return true;
          } catch (_) {
          }
        }
        return false;
      },
      shareMessage(message) {
        const url = `${window.location.origin}/channel/${message.channelId}?msg=${message.id}`;
        return this.share({ title: "Bridge mesaj\u0131", text: (message.content ?? "").slice(0, 100), url });
      },
      shareInvite(inviteCode) {
        return this.share({
          title: "Bridge'e kat\u0131l",
          text: "Bridge'de benimle sohbet et!",
          url: `https://bridge.app/invite/${inviteCode}`
        });
      }
    };
    window.bridgeShare = bridgeShare;
    if (Network) {
      Network.addListener("networkStatusChange", (status) => {
        window.dispatchEvent(new CustomEvent("bridge:network", {
          detail: { connected: status.connected, type: status.connectionType }
        }));
        let banner = document.getElementById("offline-banner") ?? createOfflineBanner();
        banner.textContent = "\u26A0\uFE0F  \u0130nternet ba\u011Flant\u0131s\u0131 yok";
        banner.style.display = status.connected ? "none" : "block";
      });
    }
    if (App) {
      App.addListener("appStateChange", (state) => {
        window.dispatchEvent(new CustomEvent("bridge:appstate", { detail: { active: state.isActive } }));
        if (state.isActive) void bridgeBadge.clear();
      });
      App.addListener("backButton", () => {
        const modal = document.querySelector(".modal.active, .overlay.active, [data-modal].active");
        if (modal) {
          modal.classList.remove("active");
          void bridgeHaptic.light();
          return;
        }
        const inChannel = document.querySelector('[data-view="channel"]');
        if (inChannel) {
          window.dispatchEvent(new CustomEvent("bridge:navigate", { detail: { view: "server-list" } }));
          return;
        }
        App?.minimizeApp();
      });
    }
    window.addEventListener("load", () => {
      void setupPushNotifications();
      console.log("[Bridge Mobile] Capacitor entegrasyonu haz\u0131r \u2014", Capacitor.getPlatform());
      console.log("[Bridge Mobile] \xD6zellikler: push, badge, deep-link, biometric, camera, share");
    });
  }
  var capacitorBridgeReady = true;
})();
