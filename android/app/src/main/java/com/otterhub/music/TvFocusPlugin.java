package com.otterhub.music;

import android.app.UiModeManager;
import android.content.Context;
import android.content.res.Configuration;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * TV 设备检测插件：供 Web 端 tv-focus 引擎判断是否启用遥控器焦点导航。
 * 判定标准与 MainActivity#isTvDevice() 一致（UiModeManager 的 TV 模式）。
 */
@CapacitorPlugin(name = "TvFocus")
public class TvFocusPlugin extends Plugin {

    @PluginMethod
    public void isTv(PluginCall call) {
        boolean isTv = false;
        UiModeManager uiModeManager =
                (UiModeManager) getContext().getSystemService(Context.UI_MODE_SERVICE);
        if (uiModeManager != null) {
            isTv = uiModeManager.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION;
        }
        JSObject result = new JSObject();
        result.put("isTv", isTv);
        call.resolve(result);
    }
}
