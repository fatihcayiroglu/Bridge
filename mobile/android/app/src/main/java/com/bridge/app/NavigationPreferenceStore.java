package com.bridge.app;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.BooleanSupplier;
import java.util.regex.Pattern;

/**
 * #490 — ACKNOWLEDGED, DURABLE ANDROID NAVIGATION PREFERENCES.
 *
 * Two independent API 34 emulator runs showed that a WebView
 * {@code localStorage.setItem()} which had already returned, and whose value
 * was readable (even from a debugger-paused page), was rolled back after
 * {@code am force-stop}. A JavaScript return is not evidence of a disk commit.
 *
 * This store is the Android source of truth for the same user/server-scoped
 * keys that {@code client/js/core/navigation-selection.ts} writes. A write is
 * reported as committed ONLY after {@code SharedPreferences.Editor.commit()}
 * returned true (it writes the file synchronously and reports the result;
 * {@code apply()} does not). Callers run every method on one dedicated
 * background thread, which also serializes writes in request order; a call on
 * Android's main thread is refused instead of performing disk I/O there.
 *
 * Only bounded IDs are accepted. Keys and values never appear in exceptions or
 * logs: callers only see a fixed reason code.
 *
 * No Android imports: the logic is exercised by plain JVM tests.
 */
final class NavigationPreferenceStore {
    static final String PREFIX = "bridge:last-navigation:v1:";
    /** Bounded file: one key per account (server) and per account and server (channel). */
    static final int MAX_ENTRIES = 4096;

    // Key segments (user and server IDs) never contain ':' so a key always
    // parses to exactly one owner; erasing one account can never match
    // another's keys. Values (server/channel IDs) are printable ASCII.
    private static final String OWNER = "[A-Za-z0-9._~@+=-]{1,128}";
    private static final String SEGMENT = "[A-Za-z0-9._~@+=-]{1,256}";
    private static final String ID = "[\\x21-\\x7E]{1,256}";
    private static final Pattern OWNER_PATTERN = Pattern.compile(OWNER);
    private static final Pattern VALUE_PATTERN = Pattern.compile(ID);
    private static final Pattern KEY_PATTERN = Pattern.compile(
            Pattern.quote(PREFIX) + "(?:server:" + OWNER + "|channel:" + OWNER + ":" + SEGMENT + ")");

    /** Persistence boundary. The Android implementation wraps SharedPreferences. */
    interface Backend {
        Map<String, ?> all();

        /** Applies every put and remove atomically; true only after a successful durable commit. */
        boolean commit(Map<String, String> puts, Iterable<String> removes);
    }

    static final class Failure extends Exception {
        private static final long serialVersionUID = 1L;
        final String code;

        Failure(String code) {
            super(code);
            this.code = code;
        }
    }

    private final Backend backend;
    private final BooleanSupplier onMainThread;

    NavigationPreferenceStore(Backend backend, BooleanSupplier onMainThread) {
        this.backend = backend;
        this.onMainThread = onMainThread;
    }

    static boolean validKey(String key) {
        return key != null && KEY_PATTERN.matcher(key).matches();
    }

    static boolean validValue(String value) {
        return value != null && VALUE_PATTERN.matcher(value).matches();
    }

    static boolean validOwner(String owner) {
        return owner != null && OWNER_PATTERN.matcher(owner).matches();
    }

    private void requireBackgroundThread() throws Failure {
        if (onMainThread.getAsBoolean()) throw new Failure("main_thread");
    }

    /**
     * Stores (value != null) or removes (value == null) one preference.
     * Returns only after a durable commit; throws with a fixed code otherwise.
     */
    void write(String key, String value) throws Failure {
        if (!validKey(key)) throw new Failure("invalid_key");
        if (value != null && !validValue(value)) throw new Failure("invalid_value");
        requireBackgroundThread();
        Map<String, ?> current = backend.all();
        if (value != null && !current.containsKey(key) && current.size() >= MAX_ENTRIES) {
            throw new Failure("capacity");
        }
        Map<String, String> puts = value == null
                ? Collections.<String, String>emptyMap()
                : Collections.singletonMap(key, value);
        Iterable<String> removes = value == null
                ? Collections.singletonList(key)
                : Collections.<String>emptyList();
        if (!backend.commit(puts, removes)) throw new Failure("commit_failed");
    }

    /** Every valid stored preference. Malformed entries are never returned. */
    Map<String, String> readAll() throws Failure {
        requireBackgroundThread();
        Map<String, String> out = new LinkedHashMap<>();
        for (Map.Entry<String, ?> entry : backend.all().entrySet()) {
            Object value = entry.getValue();
            if (validKey(entry.getKey()) && value instanceof String && validValue((String) value)) {
                out.put(entry.getKey(), (String) value);
            }
        }
        return out;
    }

    /** Removes every preference of one account (account erasure). Returns the count removed. */
    int forgetOwner(String owner) throws Failure {
        if (!validOwner(owner)) throw new Failure("invalid_owner");
        requireBackgroundThread();
        String server = PREFIX + "server:" + owner;
        String channel = PREFIX + "channel:" + owner + ":";
        java.util.List<String> removes = new java.util.ArrayList<>();
        for (String key : backend.all().keySet()) {
            if (key.equals(server) || key.startsWith(channel)) removes.add(key);
        }
        if (removes.isEmpty()) return 0;
        if (!backend.commit(Collections.<String, String>emptyMap(), removes)) {
            throw new Failure("commit_failed");
        }
        return removes.size();
    }

    /** Coarse key kind for privacy-bounded diagnostics; never the key itself. */
    static String kindOf(String key) {
        if (key == null || !key.startsWith(PREFIX)) return "invalid";
        String rest = key.substring(PREFIX.length());
        if (rest.startsWith("server:")) return "server";
        if (rest.startsWith("channel:")) return "channel";
        return "invalid";
    }
}
