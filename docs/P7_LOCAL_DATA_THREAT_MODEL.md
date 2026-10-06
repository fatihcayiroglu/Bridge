# P7 local data threat model

This document defines what Bridge's P7 local encryption is and is not intended
to protect. It is a design boundary, not a marketing claim.

## Assets

P7 may persist the following locally:

- message drafts;
- durable outgoing operations;
- bounded authorized message history;
- local search metadata/index material;
- sync/reconciliation metadata.

Raw attachment bytes are not part of the draft store. Existing upload/media
authorization remains server-authoritative.

## Adversaries in scope

### 1. Casual at-rest inspection

A copied IndexedDB/SQLite data file, browser storage inspector, backup artifact
or support bundle must not reveal sensitive cached plaintext by merely opening
the storage file.

**Control:** sensitive logical records are AES-256-GCM envelopes.

### 2. Cross-account reuse on the same client

Logging out of account A and signing into B must not expose A's drafts/history
through a shared local namespace.

**Controls:** stable account-scoped record ids, account-scoped encryption key,
authenticated scope (AAD), explicit account close/wipe lifecycle.

### 3. Record relocation/tampering

Moving ciphertext from one account/conversation/record to another or modifying
ciphertext must not turn into readable garbage or accepted data.

**Control:** AES-GCM authentication includes logical account + namespace + record
identity as AAD. Authentication failure is treated as local corruption.

### 4. Partial migration/corruption

An upgrade, crash or quota failure must not erase the only copy of an unsent
draft/outbox operation.

**Controls:** copy → authenticated read-back verification → delete legacy source;
bounded fallback behaviour; server remains the source of truth for confirmed
history.

## Adversaries not solved by browser local encryption

### Same-origin script execution / XSS

Code executing with Bridge origin privileges can ask the browser to use a
non-extractable CryptoKey and can read plaintext while the user is signed in.
Non-extractable means JavaScript cannot export raw key bytes; it does **not**
turn XSS into a harmless event.

Existing CSP, sanitization and dependency controls remain required.

### Compromised OS / unlocked user session

A fully compromised operating system, debugger or malware running as the user can
observe process memory/UI and may access browser profile facilities. P7 local
encryption is not claimed to defeat that attacker.

Native Desktop/Mobile must therefore keep the SQLite data key behind the platform
secure-key boundary (Keychain/Keystore/OS credential facility) rather than a
plaintext config file.

### Server compromise

Local encryption does not change server-authoritative data that Bridge must
already receive/store. E2EE is a separate cryptographic boundary and is audited
separately under P7 Trust/Safety/Privacy.

## Browser/PWA key boundary

The browser adapter stores a **non-extractable AES-GCM CryptoKey object** in a
dedicated IndexedDB database. Sensitive record payloads live in a separate
IndexedDB database as ciphertext envelopes.

This provides an at-rest boundary against straightforward storage-file/plaintext
inspection, but it is not described as hardware-backed protection.

If IndexedDB is unavailable or cannot be opened, Bridge may fall back to an
in-memory encrypted store for the active session. That fallback is explicitly
reported as **non-durable**; code must not claim reload persistence.

## Native target

The native P7 adapter will implement the same logical store contract using
SQLite for records and a platform-protected key reference/material boundary.
Before it becomes canonical, CI/device evidence must show:

- key survives normal app restart;
- another Bridge account cannot decrypt the first account's rows;
- logout/account wipe semantics are correct;
- database copy alone does not reveal plaintext;
- backup/restore behaviour is documented;
- biometric/device-lock integration, if used, has a recovery path and does not
  strand legitimate users.

## Deletion and permission revocation

An offline cache is evidence of *past authorization*, never present
authorization.

- local data cannot grant a server permission;
- reconnect revalidates server state;
- known delete/revocation produces a local purge/tombstone;
- account deletion wipes the account namespace/key after server-side deletion is
  confirmed;
- offline UI must identify stale state instead of implying current access.

## AI/search boundary

Local decrypted text may be indexed locally for offline search after legitimate
decryption. P7 does not permit sending local cache/decrypted E2EE text to a
remote AI/search provider merely to build the local index.

## Rollback principle

New storage schemas must remain recoverable. A schema migration either:

1. leaves the prior verified copy intact until the new copy is authenticated and
   readable; or
2. has an explicit roll-forward recovery path backed by server truth.

Unsent user-authored operations are never treated as disposable cache.
