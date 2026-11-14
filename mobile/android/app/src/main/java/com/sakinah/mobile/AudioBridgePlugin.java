package com.sakinah.mobile;

import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * JS ⇄ native bridge for background recitation (Android only).
 *
 * Ayah audio arrives as base64, is written to cache files, and the foreground
 * {@link AudioService} plays the queue (auto-advance, lock-screen and Bluetooth
 * head-unit controls, screen-off survival) without JavaScript being awake.
 *
 * When the queue runs dry the service emits "dry"; this plugin pushes an
 * evaluateJavascript call into the WebView so JS — even while the screen is
 * off — fetches the next ayah (CapacitorHttp) and appends it.
 */
@CapacitorPlugin(name = "AudioBridge")
public class AudioBridgePlugin extends Plugin implements AudioService.StateSink {

  private final ExecutorService io = Executors.newSingleThreadExecutor();
  private final Handler main = new Handler(Looper.getMainLooper());

  private File audioDir() {
    File d = new File(getContext().getCacheDir(), "native_audio");
    if (!d.exists()) d.mkdirs();
    return d;
  }

  private String writeB64(String num, String b64) throws Exception {
    byte[] data = Base64.decode(b64, Base64.DEFAULT);
    File f = new File(audioDir(), sanitize(num) + ".dat");
    FileOutputStream fo = new FileOutputStream(f);
    fo.write(data);
    fo.close();
    return f.getAbsolutePath();
  }

  private static String sanitize(String s) {
    return s == null ? "0" : s.replaceAll("[^A-Za-z0-9_.-]", "_");
  }

  private AudioService.Item mkItem(String path, String title, String artist, String num, boolean once) {
    AudioService.Item it = new AudioService.Item();
    it.path = path;
    it.title = title == null || title.length() == 0 ? "Quran" : title;
    it.artist = artist == null ? "" : artist;
    it.num = num == null || num.length() == 0 ? "0" : num;
    it.once = once;
    return it;
  }

  @PluginMethod
  public void isAvailable(PluginCall call) {
    JSObject r = new JSObject();
    r.put("available", true);
    call.resolve(r);
  }

  /** start a fresh queue; the first ayah's bytes are already in hand:
   *  { b64, num, title, artist, reciter, once } */
  @PluginMethod
  public void begin(final PluginCall call) {
    final String b64 = call.getString("b64", "");
    final String num = call.getString("num", "0");
    final String title = call.getString("title", "Quran");
    final String artist = call.getString("artist", "");
    final String reciter = call.getString("reciter", "Quran");
    final String reciterId = call.getString("reciterId", "");
    final boolean once = call.getBoolean("once", false);
    io.execute(() -> {
      try {
        // tear down any running session SILENTLY (no "stopped" event — it
        // would arrive late and wipe the fresh session's JS state), then start
        AudioService svc = AudioService.instance;
        if (svc != null) svc.stopAllSilent();
        AudioService.reciterId = reciterId == null ? "" : reciterId;
        File[] old = audioDir().listFiles();
        if (old != null) for (File f : old) f.delete();
        String path = writeB64(num, b64);
        AudioService.queue.clear();
        AudioService.queue.add(mkItem(path, title, artist, num, once));
        AudioService.qPos = 0;
        AudioService.reciterLabel = reciter == null || reciter.length() == 0 ? "Quran" : reciter;
        AudioService.sink = this;
        Intent i = new Intent(getContext(), AudioService.class);
        i.setAction(AudioService.ACTION_PLAY);
        getContext().startService(i);
        call.resolve();
      } catch (Exception e) {
        call.reject("begin failed: " + e);
      }
    });
  }

  /** append one ayah to the queue: { b64, num, title, artist } */
  @PluginMethod
  public void append(final PluginCall call) {
    final String b64 = call.getString("b64", "");
    final String num = call.getString("num", "0");
    final String title = call.getString("title", "Quran");
    final String artist = call.getString("artist", "");
    io.execute(() -> {
      try {
        String path = writeB64(num, b64);
        AudioService.queue.add(mkItem(path, title, artist, num, false));
        AudioService svc = AudioService.instance;
        if (svc != null) svc.kick(); // if the service was waiting on us, continue
        call.resolve();
      } catch (Exception e) {
        call.reject("append failed: " + e);
      }
    });
  }

  @PluginMethod
  public void play(PluginCall call) {
    AudioService svc = AudioService.instance;
    if (svc == null) { call.reject("no service"); return; }
    svc.play();
    call.resolve();
  }

  @PluginMethod
  public void pause(PluginCall call) {
    AudioService svc = AudioService.instance;
    if (svc == null) { call.resolve(); return; }
    svc.pause();
    call.resolve();
  }

  @PluginMethod
  public void resume(PluginCall call) {
    AudioService svc = AudioService.instance;
    if (svc == null) { call.reject("no service"); return; }
    svc.play();
    call.resolve();
  }

  @PluginMethod
  public void next(PluginCall call) {
    AudioService svc = AudioService.instance;
    if (svc == null) { call.resolve(); return; }
    svc.next();
    call.resolve();
  }

  @PluginMethod
  public void prev(PluginCall call) {
    AudioService svc = AudioService.instance;
    if (svc == null) { call.resolve(); return; }
    svc.prev();
    call.resolve();
  }

  @PluginMethod
  public void stop(PluginCall call) {
    AudioService svc = AudioService.instance;
    if (svc != null) svc.stopAll();
    call.resolve();
  }

  @PluginMethod
  public void query(PluginCall call) {
    JSObject r = new JSObject();
    r.put("playing", false);
    r.put("pos", 0);
    r.put("count", 0);
    r.put("num", "");
    r.put("title", "");
    r.put("reciter", "");
    AudioService svc = AudioService.instance;
    if (svc == null) { call.resolve(r); return; } // no live service → nothing to adopt
    r.put("playing", svc.isPlayingNow());
    r.put("pos", AudioService.qPos);
    r.put("count", AudioService.queue.size());
    int pos = AudioService.qPos;
    if (pos >= 0 && pos < AudioService.queue.size()) {
      AudioService.Item it = AudioService.queue.get(pos);
      if (it != null) { r.put("num", it.num); r.put("title", it.title); }
    }
    r.put("reciter", AudioService.reciterId == null ? "" : AudioService.reciterId);
    call.resolve(r);
  }

  /** AudioService.StateSink — forward every state change to JS. */
  @Override
  public void onState(final String state, final int idx) {
    main.post(() -> {
      try {
        JSObject d = new JSObject();
        d.put("state", state);
        d.put("index", idx);
        String num = "";
        String title = "";
        if (idx >= 0 && idx < AudioService.queue.size()) {
          AudioService.Item it = AudioService.queue.get(idx);
          if (it != null) { num = it.num; title = it.title; }
        }
        d.put("num", num);
        d.put("title", title);
        notifyListeners("state", d);
        // wake JS even when the screen is off / WebView throttled
        if ("dry".equals(state)) {
          String js = "window.AudioNative&&AudioNative.onDry&&AudioNative.onDry(" + idx + ");";
          try { getBridge().getWebView().evaluateJavascript(js, null); } catch (Exception ignored) {}
        }
      } catch (Exception ignored) {}
    });
  }
}
