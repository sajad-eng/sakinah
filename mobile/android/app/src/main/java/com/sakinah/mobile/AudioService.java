package com.sakinah.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.core.app.NotificationCompat;

import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Foreground recitation player. Owns playback so it keeps running when the
 * screen is off / the app is in the background, exposes MediaSession controls
 * (lock screen, Bluetooth head units, media button), and auto-advances through
 * the queue without needing JavaScript awake.
 *
 * Queue lifecycle: JS "begin"s with one ayah and appends ahead items as they
 * are fetched. When the queue runs dry the service holds (notification shows
 * Paused) and asks JS for more via AudioBridgePlugin's evaluateJavascript
 * wake — so playback continues even while the screen is off. A grace timer
 * stops the service if JS never answers (e.g. activity destroyed).
 */
public class AudioService extends Service implements MediaPlayer.OnCompletionListener, AudioManager.OnAudioFocusChangeListener {

  public static final String CHANNEL_ID = "sakinah_playback";
  public static final String ACTION_PLAY = "com.sakinah.mobile.action.PLAY";
  public static final String ACTION_PAUSE = "com.sakinah.mobile.action.PAUSE";
  public static final String ACTION_RESUME = "com.sakinah.mobile.action.RESUME";
  public static final String ACTION_NEXT = "com.sakinah.mobile.action.NEXT";
  public static final String ACTION_PREV = "com.sakinah.mobile.action.PREV";
  public static final String ACTION_STOP = "com.sakinah.mobile.action.STOP";
  public static final String EXTRA_POS = "pos";

  public static class Item {
    public String path;
    public String title;
    public String artist;
    public String num = "0";
    public boolean once = false;
  }

  // shared with the JS bridge (same process)
  public static final CopyOnWriteArrayList<Item> queue = new CopyOnWriteArrayList<>();
  public static volatile int qPos = 0;
  public static volatile String reciterLabel = "Quran";
  public static volatile String reciterId = "";

  public interface StateSink { void onState(String state, int i); }
  public static volatile StateSink sink;
  public static volatile AudioService instance;

  private MediaPlayer player;
  private MediaSessionCompat session;
  private AudioManager audioMan;
  private AudioFocusRequest focusRequest;

  private volatile boolean dry = false;
  private volatile boolean silentStop = false; // stopAllSilent: suppress the final "stopped" emit
  private final android.os.Handler dryHandler = new android.os.Handler(android.os.Looper.getMainLooper());
  private static final long DRY_GRACE_MS = 120000;

  private final BroadcastReceiver noisy = new BroadcastReceiver() {
    @Override public void onReceive(Context c, Intent i) { pause(); }
  };

  @Override public void onCreate() {
    super.onCreate();
    instance = this;
    audioMan = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
    createChannel();
    session = new MediaSessionCompat(this, "SakinahMedia");
    session.setCallback(new MediaSessionCompat.Callback() {
      @Override public void onPlay() { play(); }
      @Override public void onPause() { pause(); }
      @Override public void onSkipToNext() { next(); }
      @Override public void onSkipToPrevious() { prev(); }
      @Override public void onStop() { stopAll(); }
    });
    try { session.setActive(true); } catch (Exception ignored) {}
    try { registerReceiver(noisy, new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY)); } catch (Exception ignored) {}
    startForeground(1, buildNotification("Sakinah", "Recitation", false));
  }

  private void createChannel() {
    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (Build.VERSION.SDK_INT >= 26) {
      NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Recitation", NotificationManager.IMPORTANCE_LOW);
      ch.setDescription("Quran recitation playback");
      nm.createNotificationChannel(ch);
    }
  }

  private PendingIntent svcIntent(String action, int rc) {
    Intent i = new Intent(this, AudioService.class).setAction(action);
    return PendingIntent.getService(this, rc, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  private Notification buildNotification(String title, String sub, boolean playing) {
    PendingIntent open = PendingIntent.getActivity(this, 10,
      new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_note)
      .setContentTitle(title)
      .setContentText(sub)
      .setContentIntent(open)
      .setOnlyAlertOnce(true)
      .setOngoing(true)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .addAction(android.R.drawable.ic_media_previous, "Previous", svcIntent(ACTION_PREV, 11))
      .addAction(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
        playing ? "Pause" : "Play", svcIntent(playing ? ACTION_PAUSE : ACTION_RESUME, 12))
      .addAction(android.R.drawable.ic_media_next, "Next", svcIntent(ACTION_NEXT, 13));
    try {
      androidx.media.app.NotificationCompat.MediaStyle ms = new androidx.media.app.NotificationCompat.MediaStyle();
      if (session != null) ms.setMediaSession(session.getSessionToken());
      ms.setShowActionsInCompactView(0, 1, 2);
      b.setStyle(ms);
    } catch (Exception ignored) {}
    return b.build();
  }

  private void refreshNotification(String title, String sub, boolean playing) {
    try {
      NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
      nm.notify(1, buildNotification(title, sub, playing));
    } catch (Exception ignored) {}
  }

  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    String act = (intent != null && intent.getAction() != null) ? intent.getAction() : ACTION_PLAY;
    if (ACTION_PAUSE.equals(act)) pause();
    else if (ACTION_RESUME.equals(act)) play();
    else if (ACTION_NEXT.equals(act)) next();
    else if (ACTION_PREV.equals(act)) prev();
    else if (ACTION_STOP.equals(act)) stopAll();
    else {
      if (intent != null && intent.hasExtra(EXTRA_POS)) qPos = intent.getIntExtra(EXTRA_POS, qPos);
      play();
    }
    return START_NOT_STICKY;
  }

  private Item cur() {
    if (qPos >= 0 && qPos < queue.size()) return queue.get(qPos);
    return null;
  }

  private boolean requestFocus() {
    try {
      if (Build.VERSION.SDK_INT >= 26) {
        if (focusRequest == null) {
          focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(new AudioAttributes.Builder()
              .setUsage(AudioAttributes.USAGE_MEDIA)
              .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
              .build())
            .setOnAudioFocusChangeListener(this)
            .build();
        }
        return audioMan.requestAudioFocus(focusRequest) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
      }
      return audioMan.requestAudioFocus(this, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
        == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    } catch (Exception e) {
      return true;
    }
  }

  private void abandonFocus() {
    try {
      if (Build.VERSION.SDK_INT >= 26 && focusRequest != null) audioMan.abandonAudioFocusRequest(focusRequest);
      else if (audioMan != null) audioMan.abandonAudioFocus(this);
    } catch (Exception ignored) {}
  }

  public synchronized void play() {
    if (dry) {
      dry = false;
      dryHandler.removeCallbacksAndMessages(null);
      if (qPos + 1 < queue.size()) { qPos = qPos + 1; play(); return; }
    }
    if (!requestFocus()) { emit("error", qPos); return; }
    Item it = cur();
    if (it == null) { stopAll(); return; }
    try {
      if (player == null) player = new MediaPlayer();
      if (player.isPlaying()) {
        setMeta(it, true);
        refreshNotification(it.title, "Playing", true);
        emit("playing", qPos);
        return;
      }
      player.reset();
      player.setWakeMode(this, PowerManager.PARTIAL_WAKE_LOCK);
      player.setAudioAttributes(new AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
        .build());
      player.setDataSource(it.path);
      player.setOnCompletionListener(this);
      player.setOnErrorListener((mp, w, x) -> {
        emit("error", qPos);
        return true;
      });
      player.prepare();
      player.start();
      try { if (session != null && !session.isActive()) session.setActive(true); } catch (Exception ignored) {}
      setMeta(it, true);
      refreshNotification(it.title, "Playing", true);
      emit("playing", qPos);
    } catch (Exception e) {
      emit("error", qPos);
    }
  }

  public synchronized void pause() {
    try {
      if (player != null && player.isPlaying()) player.pause();
      Item it = cur();
      setMeta(it, false);
      refreshNotification(it == null ? "Sakinah" : it.title, "Paused", false);
      emit("paused", qPos);
    } catch (Exception ignored) {}
  }

  public synchronized void next() {
    dry = false;
    dryHandler.removeCallbacksAndMessages(null);
    if (qPos + 1 < queue.size()) { qPos = qPos + 1; play(); }
    else atEnd();
  }

  public synchronized void prev() {
    dry = false;
    dryHandler.removeCallbacksAndMessages(null);
    if (qPos > 0) qPos = qPos - 1;
    try { if (player != null) player.reset(); } catch (Exception ignored) {}
    play();
  }

  @Override public void onCompletion(MediaPlayer mp) {
    if (qPos + 1 < queue.size()) { qPos = qPos + 1; play(); return; }
    Item it = cur();
    if (it != null && it.once) { atEnd(); return; }
    goDry();
  }

  private void atEnd() {
    emit("ended", Math.max(0, Math.min(qPos, Math.max(0, queue.size() - 1))));
    stopAll();
  }

  // queue ran dry: hold the service and ask JS for the next ayah. The plugin
  // pushes an evaluateJavascript call so this works even with the screen off.
  private void goDry() {
    dry = true;
    Item it = cur();
    try {
      setMeta(it, false);
      refreshNotification(it == null ? "Sakinah" : it.title, "Paused", false);
    } catch (Exception ignored) {}
    emit("dry", qPos);
    dryHandler.postDelayed(this::stopIfStillDry, DRY_GRACE_MS);
  }

  private void stopIfStillDry() {
    if (dry) stopAll();
  }

  /** plugin calls this when JS appended the next item while dry */
  public synchronized void kick() {
    if (!dry) return;
    dry = false;
    dryHandler.removeCallbacksAndMessages(null);
    if (qPos + 1 < queue.size()) { qPos = qPos + 1; play(); }
  }

  public boolean isPlayingNow() {
    try { return player != null && player.isPlaying(); } catch (Exception e) { return false; }
  }

  public void stopAll() {
    silentStop = false;
    dry = false;
    dryHandler.removeCallbacksAndMessages(null);
    try { if (player != null) { player.stop(); player.reset(); } } catch (Exception ignored) {}
    abandonFocus();
    emit("stopped", qPos);
    try { if (session != null) session.setActive(false); } catch (Exception ignored) {}
    stopForeground(true);
    stopSelf();
  }

  /** same teardown as {@link #stopAll()} but without the final "stopped"
   *  event — used when JS replaces the session with a fresh begin(); the
   *  event would arrive late and wipe the new session's UI state. */
  public void stopAllSilent() {
    silentStop = true;
    dry = false;
    dryHandler.removeCallbacksAndMessages(null);
    try { if (player != null) { player.stop(); player.reset(); } } catch (Exception ignored) {}
    abandonFocus();
    try { if (session != null) session.setActive(false); } catch (Exception ignored) {}
    stopForeground(true);
    stopSelf();
  }

  private void setMeta(Item it, boolean playing) {
    try {
      if (it != null && session != null) {
        session.setMetadata(new MediaMetadataCompat.Builder()
          .putString(MediaMetadataCompat.METADATA_KEY_TITLE, it.title)
          .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, reciterLabel)
          .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, "Quran — Sakinah")
          .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, player != null ? player.getDuration() : 0)
          .build());
      }
      PlaybackStateCompat.Builder ps = new PlaybackStateCompat.Builder()
        .setActions(PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE
          | PlaybackStateCompat.ACTION_PLAY_PAUSE | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
          | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS | PlaybackStateCompat.ACTION_STOP)
        .setState(playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
          player != null ? player.getCurrentPosition() : 0,
          playing ? 1f : 0f);
      if (session != null) session.setPlaybackState(ps.build());
    } catch (Exception ignored) {}
  }

  @Override public void onAudioFocusChange(int fc) {
    if (fc == AudioManager.AUDIOFOCUS_LOSS) { pause(); }
    else if (fc == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) { pause(); }
    else if (fc == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) { pause(); }
    else if (fc == AudioManager.AUDIOFOCUS_GAIN) { play(); }
  }

  private void emit(String state, int i) {
    StateSink s = sink;
    if (s != null) { try { s.onState(state, i); } catch (Exception ignored) {} }
  }

  @Override public void onDestroy() {
    if (instance == this) instance = null;
    try { unregisterReceiver(noisy); } catch (Exception ignored) {}
    abandonFocus();
    try { if (player != null) { player.release(); player = null; } } catch (Exception ignored) {}
    try { if (session != null) { session.release(); session = null; } } catch (Exception ignored) {}
    if (!silentStop) emit("stopped", qPos);
    super.onDestroy();
  }

  @Override public IBinder onBind(Intent intent) { return null; }
}
