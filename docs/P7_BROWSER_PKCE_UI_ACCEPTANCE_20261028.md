# Real browser PKCE consent acceptance

This separate candidate extends the existing disposable PostgreSQL 16/Redis
HTTPS job with the actual built Bridge web UI in real Chromium. No cookies,
browser storage, authorization response, login API response or page application
function is injected. Disposable user provisioning uses the real registration
endpoint; login and native consent use visible UI controls and the real form.

The per-run CA is imported into a newly created NSS shared database on the
disposable GitHub-hosted runner. Existing NSS databases cause failure rather
than being overwritten. Chromium M146+ defaults to .local/share/pki/nssdb:
[Chromium certificate documentation](https://chromium.googlesource.com/chromium/src.git/+/refs/heads/main/docs/linux/cert_management.md).
HTTPS verification and the Chromium sandbox remain enabled. No certificate
ignore flag, HTTP exception, production domain or signing identity is added.

Three mandatory cases, zero retries/skips:

1. UI password login and explicit consent produce the real 303 callback. The
   production pilot validates its state/PKCE, exchanges the code, adopts the
   correct account and restores through actual refresh rotation and /api/me.
   The real browser's refresh cookie must be Secure/HttpOnly and unavailable to
   document.cookie. A final native sign-out must be confirmed server-side.
2. Cancelling the visible consent sends no native-authorize request, exchanges
   no native code and adopts no native credential, including after web reload.
3. The same Chromium configuration must reject an untrusted loopback TLS server
   with ERR_CERT_AUTHORITY_INVALID before any HTTP request reaches that server.

The existing 18 backend cases and independent persisted-row assertions remain
required. Browser reports are retained on first failure; traces/videos carrying
network credentials are disabled. Password input errors are sanitized before
serialization, and token assertions use closed reasons without token values.

The callback is observed by the external test driver at the genuine HTTP 303;
no page script reads it. This does not exercise operating-system dispatch to a
native app. Custom Tabs, ASWebAuthenticationSession, verified App/Universal Links,
physical devices and the complete native messaging journey remain unverified.
#537 stays disabled; no owner callback domain/signing values are invented. P7
stays open. No main merge, deployment, Capacitor migration or Abuse Lab change.
