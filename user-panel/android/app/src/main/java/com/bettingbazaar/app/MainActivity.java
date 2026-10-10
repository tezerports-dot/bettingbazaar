// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
package com.bettingbazaar.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins are registered before super.onCreate builds the bridge;
        // npm plugins are discovered by `cap sync`, these live in the app.
        registerPlugin(ApkUpdaterPlugin.class);
        registerPlugin(SecureHttpPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
