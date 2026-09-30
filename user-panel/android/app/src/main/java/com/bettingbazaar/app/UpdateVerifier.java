// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
package com.bettingbazaar.app;

import java.io.File;
import java.io.IOException;
import java.util.Locale;

/**
 * The decisions the in-app updater makes before it lets Android install
 * anything — pure functions, so they are unit-tested on the build machine
 * (app/src/test) rather than only ever exercised on a phone.
 *
 * Android verifies the APK's SIGNATURE itself and refuses an update signed with
 * a different key. What it cannot know is whether the file is the one the
 * platform published. That is this class: the download must come over TLS, and
 * its SHA-256 must equal the hash /api/app/android/update announced, or it is
 * deleted unopened.
 */
public final class UpdateVerifier {

    private UpdateVerifier() {}

    /** Only TLS. The app ships with cleartext disabled at the OS layer too. */
    public static boolean isHttps(String url) {
        return url != null && url.toLowerCase(Locale.ROOT).startsWith("https://") && url.length() > "https://".length();
    }

    /** A SHA-256 as the server sends it: 64 hex characters, either case. */
    public static boolean isSha256(String hex) {
        return hex != null && hex.matches("^[0-9a-fA-F]{64}$");
    }

    public static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format(Locale.ROOT, "%02x", b & 0xff));
        return sb.toString();
    }

    /**
     * Whether the digest of the downloaded file is the announced one. Compared
     * over the whole length regardless of where a difference is, so the time
     * taken says nothing about how much of the hash matched.
     */
    public static boolean sha256Matches(String expectedHex, byte[] digest) {
        if (!isSha256(expectedHex) || digest == null || digest.length != 32) return false;
        String actual = hex(digest);
        String expected = expectedHex.toLowerCase(Locale.ROOT);
        int diff = 0;
        for (int i = 0; i < 64; i++) diff |= actual.charAt(i) ^ expected.charAt(i);
        return diff == 0;
    }

    /**
     * Whether `file` lives inside `dir` once both are resolved — so a path
     * handed back from JavaScript cannot point the installer at anything but
     * a file this plugin downloaded.
     */
    public static boolean isInside(File dir, File file) {
        try {
            String root = dir.getCanonicalPath() + File.separator;
            return file.getCanonicalPath().startsWith(root);
        } catch (IOException e) {
            return false;
        }
    }
}
