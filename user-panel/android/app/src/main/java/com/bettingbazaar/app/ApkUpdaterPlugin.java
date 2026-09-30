// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
package com.bettingbazaar.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * ApkUpdater — the app updates itself, in the app.
 *
 * A sideloaded APK has no store behind it. Without this, every update meant the
 * player leaving the app, finding a link in a browser, downloading, finding the
 * file and installing it. Now:
 *
 *   download()  streams the published APK into this app's private cache over
 *               TLS, reporting progress, and hashes it on the way; a file whose
 *               SHA-256 is not the one the server announced is deleted unopened
 *   install()   hands the verified file to Android's own package installer
 *
 * The player taps "Update", watches a progress bar, and taps Android's
 * "Install". That last tap cannot be removed and should not be: only a device
 * owner can install silently, and a money app that could replace itself with
 * no confirmation is a worse risk than one extra tap. Android also refuses the
 * update outright if it is not signed with this app's key — the server checks
 * that before publishing, the phone checks it again here.
 *
 * On Android 8+ the first install needs the player to allow "Install unknown
 * apps" for THIS app once. install() reports that as `needs_permission` rather
 * than failing, and openInstallSettings() opens exactly that switch.
 *
 * Called from user-panel/src/services/nativeUpdater.ts. Registered in
 * MainActivity.
 */
@CapacitorPlugin(name = "ApkUpdater")
public class ApkUpdaterPlugin extends Plugin {

    private static final String APK_MIME = "application/vnd.android.package-archive";
    private static final int TIMEOUT_MS = 30_000;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean busy = new AtomicBoolean(false);

    private File updatesDir() {
        File dir = new File(getContext().getCacheDir(), "updates");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return dir;
    }

    @PluginMethod
    public void download(PluginCall call) {
        final String url = call.getString("url");
        final String sha256 = call.getString("sha256");
        final long expectedSize = call.getLong("sizeBytes", -1L);

        if (!UpdateVerifier.isHttps(url)) { call.reject("The update link is not secure (https).", "INSECURE_URL"); return; }
        if (!UpdateVerifier.isSha256(sha256)) { call.reject("The update has no checksum to verify it against.", "NO_CHECKSUM"); return; }
        if (!busy.compareAndSet(false, true)) { call.reject("An update is already downloading.", "BUSY"); return; }

        executor.execute(() -> {
            File dir = updatesDir();
            File target = new File(dir, sha256.toLowerCase() + ".apk");
            File part = new File(dir, sha256.toLowerCase() + ".part");
            HttpURLConnection conn = null;
            try {
                // Already downloaded and verified — e.g. the player went to
                // Settings to allow installs and came back. Hash it again anyway:
                // the cache is ours, but a check that costs a second is cheap.
                if (target.exists() && verifyFile(target, sha256)) { resolvePath(call, target); return; }

                // Anything else in the folder is an older or abandoned update.
                File[] stale = dir.listFiles();
                if (stale != null) for (File f : stale) //noinspection ResultOfMethodCallIgnored
                    f.delete();

                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(TIMEOUT_MS);
                conn.setReadTimeout(TIMEOUT_MS);
                conn.setInstanceFollowRedirects(true);
                int code = conn.getResponseCode();
                if (code != 200) { call.reject("The update could not be downloaded (HTTP " + code + ").", "HTTP_" + code); return; }
                // A redirect to a plaintext host would have been refused by the
                // network security config; check the final URL all the same.
                if (!UpdateVerifier.isHttps(conn.getURL().toString())) { call.reject("The update link is not secure (https).", "INSECURE_URL"); return; }

                long total = conn.getContentLengthLong() > 0 ? conn.getContentLengthLong() : expectedSize;
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                long received = 0;
                long lastReport = 0;
                try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(part)) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        out.write(buf, 0, n);
                        md.update(buf, 0, n);
                        received += n;
                        long now = System.currentTimeMillis();
                        if (now - lastReport > 200) { lastReport = now; progress(received, total); }
                    }
                }
                progress(received, total);

                if (!UpdateVerifier.sha256Matches(sha256, md.digest())) {
                    //noinspection ResultOfMethodCallIgnored
                    part.delete();
                    call.reject("The download was damaged or is not the published update. Please try again.", "CHECKSUM_MISMATCH");
                    return;
                }
                if (!part.renameTo(target)) { call.reject("Could not save the update. Free some storage and try again.", "SAVE_FAILED"); return; }
                resolvePath(call, target);
            } catch (Exception e) {
                //noinspection ResultOfMethodCallIgnored
                part.delete();
                call.reject("The update could not be downloaded. Check your connection and try again.", "NETWORK", e);
            } finally {
                if (conn != null) conn.disconnect();
                busy.set(false);
            }
        });
    }

    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("allowed", installAllowed());
        call.resolve(ret);
    }

    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try { getContext().startActivity(intent); } catch (ActivityNotFoundException ignored) { /* no such screen */ }
        }
        call.resolve();
    }

    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path");
        File file = path == null ? null : new File(path);
        if (file == null || !file.exists() || !UpdateVerifier.isInside(updatesDir(), file)) {
            call.reject("The update file is missing. Download it again.", "NO_FILE");
            return;
        }
        JSObject ret = new JSObject();
        if (!installAllowed()) {
            ret.put("status", "needs_permission");
            call.resolve(ret);
            return;
        }
        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, APK_MIME);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            ret.put("status", "started");
            call.resolve(ret);
        } catch (ActivityNotFoundException e) {
            call.reject("This phone has no package installer available.", "NO_INSTALLER", e);
        }
    }

    private boolean installAllowed() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O
            || getContext().getPackageManager().canRequestPackageInstalls();
    }

    private void progress(long received, long total) {
        JSObject p = new JSObject();
        p.put("received", received);
        p.put("total", total);
        notifyListeners("downloadProgress", p);
    }

    private void resolvePath(PluginCall call, File file) {
        JSObject ret = new JSObject();
        ret.put("path", file.getAbsolutePath());
        call.resolve(ret);
    }

    private static boolean verifyFile(File file, String sha256) {
        try (InputStream in = new java.io.FileInputStream(file)) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) md.update(buf, 0, n);
            return UpdateVerifier.sha256Matches(sha256, md.digest());
        } catch (Exception e) {
            return false;
        }
    }
}
