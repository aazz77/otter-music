package com.otterhub.music;

import static androidx.core.view.WindowCompat.enableEdgeToEdge;

import android.app.UiModeManager;
import android.content.Context;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {
    private Boolean isTvDeviceCache;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Android 15 enforces edge-to-edge; older versions should let the
        // system keep WebView content above the navigation bar.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            enableEdgeToEdge(getWindow());
        }
        registerPlugin(LocalMusicPlugin.class);
        registerPlugin(BilibiliProxyPlugin.class);
        registerPlugin(AudioRoutePlugin.class);
        registerPlugin(WebViewLoginPlugin.class);
        registerPlugin(TvFocusPlugin.class);
        super.onCreate(savedInstanceState);
        useTransientSystemBars();
    }

    /**
     * TV 设备检测（UiModeManager 的 UI 模式），供按键分发与 TvFocusPlugin 共用。
     */
    public boolean isTvDevice() {
        if (isTvDeviceCache == null) {
            UiModeManager uiModeManager =
                    (UiModeManager) getSystemService(Context.UI_MODE_SERVICE);
            isTvDeviceCache = uiModeManager != null
                    && uiModeManager.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION;
        }
        return isTvDeviceCache;
    }

    /**
     * TV 遥控器按键（DPAD/OK）到达时确保 WebView 持有焦点：
     * DOM 中尚无聚焦元素时，按键默认落在 Activity 上不会进入 WebView，
     * 这里提前把焦点交给 WebView，让 tv-focus 引擎能收到方向键 keydown。
     * BACK 键不处理，保持 Capacitor 既有的返回键分发逻辑。
     */
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (isTvDevice() && event.getAction() == KeyEvent.ACTION_DOWN
                && isDpadKey(event.getKeyCode())) {
            View webView = getBridge() != null ? getBridge().getWebView() : null;
            if (webView != null && !webView.hasFocus()) {
                webView.requestFocus();
            }
        }
        return super.dispatchKeyEvent(event);
    }

    private static boolean isDpadKey(int keyCode) {
        return keyCode == KeyEvent.KEYCODE_DPAD_UP
                || keyCode == KeyEvent.KEYCODE_DPAD_DOWN
                || keyCode == KeyEvent.KEYCODE_DPAD_LEFT
                || keyCode == KeyEvent.KEYCODE_DPAD_RIGHT
                || keyCode == KeyEvent.KEYCODE_DPAD_CENTER
                || keyCode == KeyEvent.KEYCODE_ENTER;
    }

    /**
     * 让被隐藏的系统栏以「瞬时」方式显示：用户从边缘下拉时系统栏只是浮层显示并在数秒后自动收回。
     * 默认的 BEHAVIOR_SHOW_BARS_BY_SWIPE 会把系统栏永久显示出来，导致横屏沉浸模式下状态栏常驻。
     */
    private void useTransientSystemBars() {
        WindowInsetsControllerCompat insetsController = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        insetsController.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }

    /**
     * 屏幕方向插件只能锁定为固定方向（"landscape" → SCREEN_ORIENTATION_LANDSCAPE），设备旋转 180° 时不会翻转。
     * 这里把固定横屏改写为「传感器横屏」，允许在两个横屏方向间跟随设备翻转，同时仍然禁止竖屏。
     */
    @Override
    public void setRequestedOrientation(int requestedOrientation) {
        if (requestedOrientation == ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE) {
            requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE;
        }
        super.setRequestedOrientation(requestedOrientation);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        int nightModeFlags = newConfig.uiMode & Configuration.UI_MODE_NIGHT_MASK;
        boolean isDarkMode = nightModeFlags == Configuration.UI_MODE_NIGHT_YES;
        PluginHandle handle = getBridge().getPlugin("LocalMusicPlugin");
        if (handle != null) {
            ((LocalMusicPlugin) handle.getInstance()).notifyDarkModeChange(isDarkMode);
        }
    }
}
