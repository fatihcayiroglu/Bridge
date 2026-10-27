package com.bridge.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;

/**
 * Android #209: DEBUG-only installer for {@link MainThreadStallProbe}. Content
 * providers are created during bindApplication, before any Activity, so the
 * probe also covers MainActivity.onCreate and the Capacitor/WebView setup.
 * Declared only in the debug manifest; release builds contain neither class.
 * It serves no data.
 */
public final class MainThreadStallProbeProvider extends ContentProvider {
    @Override
    public boolean onCreate() {
        MainThreadStallProbe.install();
        return true;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sortOrder) {
        return null;
    }

    @Override
    public String getType(Uri uri) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] args) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] args) {
        return 0;
    }
}
