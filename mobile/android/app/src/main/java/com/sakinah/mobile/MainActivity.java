package com.sakinah.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    // Must run BEFORE super.onCreate(): the bridge (and its plugin registry)
    // is built inside BridgeActivity.onCreate, so registrations after it are
    // silently dropped.
    registerPlugin(AudioBridgePlugin.class);
    super.onCreate(savedInstanceState);
  }
}
