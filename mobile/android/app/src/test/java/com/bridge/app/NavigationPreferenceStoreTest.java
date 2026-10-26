package com.bridge.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/** #490: a navigation preference is acknowledged only after a durable commit. */
public class NavigationPreferenceStoreTest {
    private static final String SERVER_KEY = "bridge:last-navigation:v1:server:u1";
    private static final String CHANNEL_KEY = "bridge:last-navigation:v1:channel:u1:s1";

    /**
     * A "disk" that only changes on a successful commit, plus an in-memory
     * view that mimics SharedPreferences: apply()-style state is NOT durable.
     */
    static final class FakeDisk implements NavigationPreferenceStore.Backend {
        final Map<String, String> durable = new HashMap<>();
        boolean failCommits;
        int commits;
        final List<String> commitThreads = new ArrayList<>();

        @Override
        public Map<String, ?> all() {
            return new HashMap<>(durable);
        }

        @Override
        public boolean commit(Map<String, String> puts, Iterable<String> removes) {
            commits++;
            commitThreads.add(Thread.currentThread().getName());
            if (failCommits) return false;
            for (String key : removes) durable.remove(key);
            durable.putAll(puts);
            return true;
        }

        /** A fresh process sees only what reached the disk. */
        NavigationPreferenceStore reopen() {
            FakeDisk next = new FakeDisk();
            next.durable.putAll(durable);
            return new NavigationPreferenceStore(next, () -> false);
        }
    }

    private static NavigationPreferenceStore store(FakeDisk disk) {
        return new NavigationPreferenceStore(disk, () -> false);
    }

    private static String failureCode(Runnable action) {
        try {
            action.run();
        } catch (RuntimeException wrapped) {
            if (wrapped.getCause() instanceof NavigationPreferenceStore.Failure) {
                return ((NavigationPreferenceStore.Failure) wrapped.getCause()).code;
            }
            throw wrapped;
        }
        fail("expected a failure");
        return null;
    }

    private interface Op {
        void run() throws NavigationPreferenceStore.Failure;
    }

    private static Runnable wrap(Op op) {
        return () -> {
            try {
                op.run();
            } catch (NavigationPreferenceStore.Failure failure) {
                throw new RuntimeException(failure);
            }
        };
    }

    @Test
    public void acknowledgedWriteIsReadableAfterCommitAndInAFreshProcess() throws Exception {
        FakeDisk disk = new FakeDisk();
        NavigationPreferenceStore store = store(disk);
        store.write(CHANNEL_KEY, "c2");
        assertEquals(1, disk.commits);
        assertEquals("c2", store.readAll().get(CHANNEL_KEY));
        assertEquals("c2", disk.reopen().readAll().get(CHANNEL_KEY));
    }

    @Test
    public void failedCommitIsReportedAndNeverAcknowledged() throws Exception {
        FakeDisk disk = new FakeDisk();
        NavigationPreferenceStore store = store(disk);
        store.write(CHANNEL_KEY, "c1");
        disk.failCommits = true;
        assertEquals("commit_failed", failureCode(wrap(() -> store.write(CHANNEL_KEY, "c2"))));
        // The previous durable value stays; the failed one is not visible.
        assertEquals("c1", disk.reopen().readAll().get(CHANNEL_KEY));
    }

    @Test
    public void refusesDiskWorkOnTheMainThread() {
        FakeDisk disk = new FakeDisk();
        NavigationPreferenceStore onMain = new NavigationPreferenceStore(disk, () -> true);
        assertEquals("main_thread", failureCode(wrap(() -> onMain.write(CHANNEL_KEY, "c1"))));
        assertEquals("main_thread", failureCode(wrap(onMain::readAll)));
        assertEquals("main_thread", failureCode(wrap(() -> onMain.forgetOwner("u1"))));
        assertEquals(0, disk.commits);
    }

    @Test
    public void rapidConsecutiveSelectionsOnOneExecutorKeepTheLastOne() throws Exception {
        FakeDisk disk = new FakeDisk();
        NavigationPreferenceStore store = store(disk);
        ExecutorService io = Executors.newSingleThreadExecutor(r -> new Thread(r, "nav-io"));
        CountDownLatch done = new CountDownLatch(50);
        List<String> acknowledged = Collections.synchronizedList(new ArrayList<>());
        for (int i = 0; i < 50; i++) {
            String value = "c" + i;
            io.execute(() -> {
                try {
                    store.write(CHANNEL_KEY, value);
                    acknowledged.add(value);
                } catch (NavigationPreferenceStore.Failure failure) {
                    acknowledged.add("FAILED");
                } finally {
                    done.countDown();
                }
            });
        }
        assertTrue(done.await(10, TimeUnit.SECONDS));
        io.shutdown();
        assertEquals(50, acknowledged.size());
        for (int i = 0; i < 50; i++) assertEquals("c" + i, acknowledged.get(i));
        assertEquals("c49", disk.reopen().readAll().get(CHANNEL_KEY));
        for (String thread : disk.commitThreads) assertEquals("nav-io", thread);
    }

    @Test
    public void ownersAndServersStayIsolatedAndForgetRemovesOnlyOneOwner() throws Exception {
        FakeDisk disk = new FakeDisk();
        NavigationPreferenceStore store = store(disk);
        store.write(SERVER_KEY, "s1");
        store.write(CHANNEL_KEY, "c1");
        store.write("bridge:last-navigation:v1:channel:u1:s2", "c9");
        store.write("bridge:last-navigation:v1:server:u10", "s3");
        store.write("bridge:last-navigation:v1:channel:u10:s1", "c7");
        assertEquals(3, store.forgetOwner("u1"));
        Map<String, String> left = disk.reopen().readAll();
        assertEquals(2, left.size());
        assertEquals("s3", left.get("bridge:last-navigation:v1:server:u10"));
        assertEquals("c7", left.get("bridge:last-navigation:v1:channel:u10:s1"));
        assertEquals(0, store.forgetOwner("u1"));
    }

    @Test
    public void removalIsAcknowledgedOnlyAfterCommit() throws Exception {
        FakeDisk disk = new FakeDisk();
        NavigationPreferenceStore store = store(disk);
        store.write(CHANNEL_KEY, "c1");
        store.write(CHANNEL_KEY, null);
        assertFalse(disk.reopen().readAll().containsKey(CHANNEL_KEY));
    }

    @Test
    public void rejectsMalformedOversizedAndForeignInputWithoutTouchingDisk() {
        FakeDisk disk = new FakeDisk();
        NavigationPreferenceStore store = store(disk);
        String[] badKeys = {
            null, "", "token", "bridge:last-navigation:v1:server:", "bridge:last-navigation:v1:secret:u1",
            "bridge:last-navigation:v1:server:u1:extra", "bridge:last-navigation:v1:channel:u1",
            "bridge:last-navigation:v1:server:" + repeat('u', 129),
            "bridge:last-navigation:v1:channel:u1:" + repeat('s', 257),
            "bridge:last-navigation:v1:server:u 1", "bridge:last-navigation:v1:server:u1\n",
            // Ambiguous: could be owner "u1" + server "a:b" or a colon owner.
            "bridge:last-navigation:v1:channel:u1:a:b",
        };
        for (String key : badKeys) {
            assertEquals("invalid_key", failureCode(wrap(() -> store.write(key, "c1"))));
        }
        for (String value : new String[] {"", repeat('c', 257), "c 1", "cç", "c\n"}) {
            assertEquals("invalid_value", failureCode(wrap(() -> store.write(CHANNEL_KEY, value))));
        }
        assertEquals("invalid_owner", failureCode(wrap(() -> store.forgetOwner("u:1"))));
        assertEquals("invalid_owner", failureCode(wrap(() -> store.forgetOwner(null))));
        assertEquals(0, disk.commits);
    }

    @Test
    public void readNeverReturnsMalformedEntriesWrittenOutsideTheStore() throws Exception {
        FakeDisk disk = new FakeDisk();
        disk.durable.put(CHANNEL_KEY, "c1");
        disk.durable.put("access_token", "secret");
        disk.durable.put(SERVER_KEY, repeat('s', 300));
        Map<String, String> read = store(disk).readAll();
        assertEquals(1, read.size());
        assertEquals("c1", read.get(CHANNEL_KEY));
    }

    @Test
    public void boundedCapacityRejectsNewKeysButAllowsUpdates() throws Exception {
        FakeDisk disk = new FakeDisk();
        for (int i = 0; i < NavigationPreferenceStore.MAX_ENTRIES; i++) {
            disk.durable.put("bridge:last-navigation:v1:server:u" + i, "s");
        }
        NavigationPreferenceStore store = store(disk);
        assertEquals("capacity", failureCode(wrap(() -> store.write("bridge:last-navigation:v1:server:new", "s"))));
        store.write("bridge:last-navigation:v1:server:u0", "s2");
        assertEquals("s2", disk.durable.get("bridge:last-navigation:v1:server:u0"));
    }

    @Test
    public void diagnosticKindNeverEchoesIdentifiers() {
        assertEquals("channel", NavigationPreferenceStore.kindOf(CHANNEL_KEY));
        assertEquals("server", NavigationPreferenceStore.kindOf(SERVER_KEY));
        assertEquals("invalid", NavigationPreferenceStore.kindOf("u1"));
        assertEquals("invalid", NavigationPreferenceStore.kindOf(null));
    }

    private static String repeat(char c, int n) {
        StringBuilder out = new StringBuilder(n);
        for (int i = 0; i < n; i++) out.append(c);
        return out.toString();
    }
}
