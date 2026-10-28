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

The first run, 40663269198 at ad749606, passed the 18 real backend cases but
failed all three browser launches with Chromium's "No usable sandbox" fatal
error. The archive/logs are retained, SHA/CRC/head verified. Ubuntu's AppArmor
user-namespace restriction needs an allowlist for the downloaded browser.
Following [Chromium's documented per-binary policy](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md),
the CI profile permits userns only for the exact installed test executable,
with no glob attachment. The global restriction is read before/after and must
remain unchanged. The browser still launches with chromiumSandbox=true.

The second run, 40663752770 at fac7ed7f, launched the sandboxed browser and
passed the untrusted-certificate rejection control. Both UI cases reached the
actual consent dialog, then failed the cookie boundary: the server set Secure
only for NODE_ENV=production even though BASE_URL explicitly configured HTTPS.
A direct execution of the original cookie owner confirmed secure=false under
this exact configuration. The correction also sets Secure for an operator's
configured HTTPS origin in development/staging, for both set and clear. It
never trusts request forwarding headers; production stays Secure regardless,
and local HTTP development retains its existing behavior. Four Jest contracts
and the unchanged real-browser assertions qualify this stricter policy.

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
