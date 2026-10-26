package com.bridge.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * #490 — native, acknowledged persistence for navigation preferences.
 * See {@link NavigationPreferenceStore} for the evidence and the contract.
 *
 * Threading: every disk operation runs on ONE process-wide background thread.
 * It is static on purpose: an Activity (and with it this plugin instance) can
 * be recreated while an earlier write is still queued, and a single queue
 * keeps those writes in request order. The UI thread never waits on it.
 *
 * Debug builds log a privacy-bounded lifecycle (tag BridgeNavStore):
 * requested / committed / failed / boot-read with kind, sequence, outcome and
 * duration only. Keys, IDs and values are never logged.
 */
@CapacitorPlugin(name = "BridgeNavigationStore")
public class BridgeNavigationStorePlugin extends Plugin {
    static final String FILE = "bridge_navigation_v1";
    private static final String TAG = "BridgeNavStore";

    private static final ExecutorService IO = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "BridgeNavStoreIO");
        thread.setPriority(Thread.NORM_PRIORITY - 1);
        return thread;
    });
    private static final AtomicLong SEQUENCE = new AtomicLong();
    private static final AtomicBoolean BOOT_READ_DONE = new AtomicBoolean();

    private static NavigationPreferenceStore store;
    private boolean debuggable;

    @Override
    public void load() {
        debuggable = (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    /** IO thread only: even opening the preferences file stays off the main thread. */
    private NavigationPreferenceStore store() {
        if (store == null) {
            Context context = getContext().getApplicationContext();
            SharedPreferences prefs = context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
            store = new NavigationPreferenceStore(new SharedPreferencesBackend(prefs),
                    () -> Looper.myLooper() == Looper.getMainLooper());
        }
        return store;
    }

    @PluginMethod
    public void write(PluginCall call) {
        String key = call.getString("key");
        JSONObject data = call.getData();
        Object raw = data.has("value") ? data.opt("value") : JSONObject.NULL;
        String value = raw == JSONObject.NULL ? null : raw instanceof String ? (String) raw : "";
        String kind = NavigationPreferenceStore.kindOf(key);
        long seq = SEQUENCE.incrementAndGet();
        String op = value == null ? "remove" : "put";
        debug("event=requested seq=" + seq + " kind=" + kind + " op=" + op);
        long start = SystemClock.elapsedRealtime();
        IO.execute(() -> {
            try {
                store().write(key, value);
                debug("event=committed seq=" + seq + " kind=" + kind + " op=" + op
                        + " ms=" + (SystemClock.elapsedRealtime() - start));
                JSObject result = new JSObject();
                result.put("committed", true);
                result.put("seq", seq);
                call.resolve(result);
            } catch (NavigationPreferenceStore.Failure failure) {
                debug("event=failed seq=" + seq + " kind=" + kind + " op=" + op + " code=" + failure.code);
                call.reject("navigation preference was not committed", failure.code);
            } catch (RuntimeException unexpected) {
                debug("event=failed seq=" + seq + " kind=" + kind + " op=" + op + " code=exception");
                call.reject("navigation preference was not committed", "exception");
            }
        });
    }

    @PluginMethod
    public void readAll(PluginCall call) {
        IO.execute(() -> {
            try {
                Map<String, String> entries = store().readAll();
                boolean first = BOOT_READ_DONE.compareAndSet(false, true);
                if (first) debug("event=boot-read entries=" + entries.size());
                JSObject map = new JSObject();
                for (Map.Entry<String, String> entry : entries.entrySet()) {
                    map.put(entry.getKey(), entry.getValue());
                }
                JSObject result = new JSObject();
                result.put("entries", map);
                result.put("processFirstRead", first);
                call.resolve(result);
            } catch (NavigationPreferenceStore.Failure failure) {
                debug("event=read-failed code=" + failure.code);
                call.reject("navigation preferences unavailable", failure.code);
            } catch (RuntimeException unexpected) {
                debug("event=read-failed code=exception");
                call.reject("navigation preferences unavailable", "exception");
            }
        });
    }

    @PluginMethod
    public void forgetOwner(PluginCall call) {
        String owner = call.getString("owner");
        long seq = SEQUENCE.incrementAndGet();
        debug("event=requested seq=" + seq + " kind=owner op=forget");
        IO.execute(() -> {
            try {
                int removed = store().forgetOwner(owner);
                debug("event=committed seq=" + seq + " kind=owner op=forget removed=" + removed);
                JSObject result = new JSObject();
                result.put("committed", true);
                result.put("seq", seq);
                call.resolve(result);
            } catch (NavigationPreferenceStore.Failure failure) {
                debug("event=failed seq=" + seq + " kind=owner op=forget code=" + failure.code);
                call.reject("navigation preferences were not removed", failure.code);
            } catch (RuntimeException unexpected) {
                debug("event=failed seq=" + seq + " kind=owner op=forget code=exception");
                call.reject("navigation preferences were not removed", "exception");
            }
        });
    }

    private void debug(String message) {
        if (debuggable) Log.i(TAG, message);
    }

    private static final class SharedPreferencesBackend implements NavigationPreferenceStore.Backend {
        private final SharedPreferences prefs;

        SharedPreferencesBackend(SharedPreferences prefs) {
            this.prefs = prefs;
        }

        @Override
        public Map<String, ?> all() {
            return prefs.getAll();
        }

        @Override
        public boolean commit(Map<String, String> puts, Iterable<String> removes) {
            SharedPreferences.Editor editor = prefs.edit();
            for (String key : removes) editor.remove(key);
            for (Map.Entry<String, String> entry : puts.entrySet()) {
                editor.putString(entry.getKey(), entry.getValue());
            }
            // commit(), never apply(): it returns only after the file write
            // and reports whether it succeeded.
            return editor.commit();
        }
    }
}
