// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
package com.bettingbazaar.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins are registered before super.onCreate builds the bridge;
        // npm plugins are discovered by `cap sync`, this one lives in the app.
        registerPlugin(ApkUpdaterPlugin.class);
        // Every request the bundle makes, resolved over DNS-over-HTTPS
        // (services/secureTransport.ts routes fetch and EventSource here).
        registerPlugin(SecureHttpPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
