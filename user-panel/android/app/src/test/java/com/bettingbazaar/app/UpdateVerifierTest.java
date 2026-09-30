// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
package com.bettingbazaar.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;

import org.junit.Test;

/**
 * What the updater refuses before Android ever sees a file. Runs on the build
 * machine: `./gradlew testDebugUnitTest`.
 */
public class UpdateVerifierTest {

    private static byte[] sha(String s) throws Exception {
        return MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
    }

    @Test
    public void acceptsOnlyTls() {
        assertTrue(UpdateVerifier.isHttps("https://cdn.example.com/app.apk"));
        assertTrue(UpdateVerifier.isHttps("HTTPS://cdn.example.com/app.apk"));
        assertFalse(UpdateVerifier.isHttps("http://cdn.example.com/app.apk"));
        assertFalse(UpdateVerifier.isHttps("https://"));
        assertFalse(UpdateVerifier.isHttps("file:///sdcard/app.apk"));
        assertFalse(UpdateVerifier.isHttps(null));
    }

    @Test
    public void matchesTheAnnouncedHashInEitherCase() throws Exception {
        byte[] digest = sha("the published apk");
        String hex = UpdateVerifier.hex(digest);
        assertEquals(64, hex.length());
        assertTrue(UpdateVerifier.sha256Matches(hex, digest));
        assertTrue(UpdateVerifier.sha256Matches(hex.toUpperCase(), digest));
    }

    @Test
    public void refusesAnyOtherFile() throws Exception {
        String announced = UpdateVerifier.hex(sha("the published apk"));
        assertFalse(UpdateVerifier.sha256Matches(announced, sha("a tampered apk")));
        assertFalse(UpdateVerifier.sha256Matches("", sha("x")));
        assertFalse(UpdateVerifier.sha256Matches(announced.substring(1), sha("the published apk")));
        assertFalse(UpdateVerifier.sha256Matches(announced, new byte[16]));
        assertFalse(UpdateVerifier.sha256Matches(null, sha("x")));
    }

    @Test
    public void installsOnlyFromItsOwnFolder() throws Exception {
        File root = Files.createTempDirectory("cache").toFile();
        File updates = new File(root, "updates");
        assertTrue(updates.mkdirs());
        File inside = new File(updates, "abc.apk");
        assertTrue(inside.createNewFile());

        assertTrue(UpdateVerifier.isInside(updates, inside));
        assertFalse(UpdateVerifier.isInside(updates, new File(updates, "../evil.apk")));
        assertFalse(UpdateVerifier.isInside(updates, new File(root, "updates-evil/abc.apk")));
        assertFalse(UpdateVerifier.isInside(updates, new File("/sdcard/Download/abc.apk")));
    }
}
