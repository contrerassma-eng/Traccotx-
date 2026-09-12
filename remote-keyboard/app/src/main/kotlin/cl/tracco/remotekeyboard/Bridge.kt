package cl.tracco.remotekeyboard

import android.content.Context
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Puente entre el servidor HTTP (hilos de red) y los servicios del sistema
 * (teclado y accesibilidad), que sólo pueden usarse desde el hilo principal.
 */
object Bridge {
    const val VERSION = "1.0"

    @Volatile var appContext: Context? = null
    @Volatile var ime: RemoteInputMethodService? = null
    @Volatile var a11y: RemoteAccessibilityService? = null
    @Volatile var editorConnected: Boolean = false
    @Volatile var lastClient: String? = null
    @Volatile var lastActivityMs: Long = 0L

    private val main = Handler(Looper.getMainLooper())

    /** Nombres de tecla aceptados por la API web → keycode de Android. */
    val KEYS: Map<String, Int> = mapOf(
        "ENTER" to KeyEvent.KEYCODE_ENTER,
        "BACKSPACE" to KeyEvent.KEYCODE_DEL,
        "DELETE" to KeyEvent.KEYCODE_FORWARD_DEL,
        "SPACE" to KeyEvent.KEYCODE_SPACE,
        "TAB" to KeyEvent.KEYCODE_TAB,
        "ESC" to KeyEvent.KEYCODE_ESCAPE,
        "UP" to KeyEvent.KEYCODE_DPAD_UP,
        "DOWN" to KeyEvent.KEYCODE_DPAD_DOWN,
        "LEFT" to KeyEvent.KEYCODE_DPAD_LEFT,
        "RIGHT" to KeyEvent.KEYCODE_DPAD_RIGHT,
        "CENTER" to KeyEvent.KEYCODE_DPAD_CENTER,
        "BACK" to KeyEvent.KEYCODE_BACK,
        "HOME" to KeyEvent.KEYCODE_HOME,
        "RECENTS" to KeyEvent.KEYCODE_APP_SWITCH,
        "MENU" to KeyEvent.KEYCODE_MENU,
        "SEARCH" to KeyEvent.KEYCODE_SEARCH,
        "MOVE_HOME" to KeyEvent.KEYCODE_MOVE_HOME,
        "MOVE_END" to KeyEvent.KEYCODE_MOVE_END,
        "PAGE_UP" to KeyEvent.KEYCODE_PAGE_UP,
        "PAGE_DOWN" to KeyEvent.KEYCODE_PAGE_DOWN,
        "VOL_UP" to KeyEvent.KEYCODE_VOLUME_UP,
        "VOL_DOWN" to KeyEvent.KEYCODE_VOLUME_DOWN,
        "MUTE" to KeyEvent.KEYCODE_VOLUME_MUTE,
        "PLAY_PAUSE" to KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
        "STOP" to KeyEvent.KEYCODE_MEDIA_STOP,
        "NEXT" to KeyEvent.KEYCODE_MEDIA_NEXT,
        "PREVIOUS" to KeyEvent.KEYCODE_MEDIA_PREVIOUS,
        "REWIND" to KeyEvent.KEYCODE_MEDIA_REWIND,
        "FAST_FORWARD" to KeyEvent.KEYCODE_MEDIA_FAST_FORWARD,
    )

    /** Ejecuta [block] en el hilo principal y espera su resultado (máx. 2 s). */
    fun onMain(block: () -> Boolean): Boolean {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            return try { block() } catch (_: Throwable) { false }
        }
        val latch = CountDownLatch(1)
        var result = false
        main.post {
            try {
                result = block()
            } catch (_: Throwable) {
                result = false
            } finally {
                latch.countDown()
            }
        }
        latch.await(2, TimeUnit.SECONDS)
        return result
    }

    fun post(block: () -> Unit) {
        main.post(block)
    }

    fun touch(client: String?) {
        lastActivityMs = System.currentTimeMillis()
        if (client != null && client != lastClient) {
            lastClient = client
            post { ime?.updateStrip() }
        }
    }

    // ------------------------------------------------------------------ comandos

    fun typeText(text: String): Boolean = onMain { ime?.typeText(text) ?: false }

    fun backspace(count: Int): Boolean = onMain { ime?.backspace(count) ?: false }

    fun enter(): Boolean = onMain { ime?.enter() ?: false }

    fun clearAll(): Boolean = onMain { ime?.clearAll() ?: false }

    fun key(code: Int): Boolean = onMain {
        when (code) {
            KeyEvent.KEYCODE_ENTER -> ime?.enter() ?: false

            KeyEvent.KEYCODE_DEL -> ime?.backspace(1) ?: false

            KeyEvent.KEYCODE_VOLUME_UP -> adjustVolume(AudioManager.ADJUST_RAISE)
            KeyEvent.KEYCODE_VOLUME_DOWN -> adjustVolume(AudioManager.ADJUST_LOWER)
            KeyEvent.KEYCODE_VOLUME_MUTE -> toggleMute()

            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_STOP,
            KeyEvent.KEYCODE_MEDIA_NEXT, KeyEvent.KEYCODE_MEDIA_PREVIOUS,
            KeyEvent.KEYCODE_MEDIA_REWIND, KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> mediaKey(code)

            KeyEvent.KEYCODE_BACK -> a11y?.back() ?: ime?.sendKey(code) ?: false
            KeyEvent.KEYCODE_HOME -> a11y?.home() ?: false
            KeyEvent.KEYCODE_APP_SWITCH -> a11y?.recents() ?: false

            KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN,
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT,
            KeyEvent.KEYCODE_DPAD_CENTER -> {
                val viaIme = ime
                if (editorConnected && viaIme != null) {
                    viaIme.sendKey(code)
                } else {
                    a11y?.dpad(code) ?: viaIme?.sendKey(code) ?: false
                }
            }

            else -> ime?.sendKey(code) ?: false
        }
    }

    private fun audio(): AudioManager? =
        appContext?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

    private fun adjustVolume(direction: Int): Boolean {
        val am = audio() ?: return false
        am.adjustStreamVolume(AudioManager.STREAM_MUSIC, direction, AudioManager.FLAG_SHOW_UI)
        return true
    }

    private fun toggleMute(): Boolean {
        val am = audio() ?: return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            am.adjustStreamVolume(
                AudioManager.STREAM_MUSIC, AudioManager.ADJUST_TOGGLE_MUTE, AudioManager.FLAG_SHOW_UI
            )
        } else {
            @Suppress("DEPRECATION")
            am.setStreamMute(AudioManager.STREAM_MUSIC, !am.isStreamMute(AudioManager.STREAM_MUSIC))
        }
        return true
    }

    private fun mediaKey(code: Int): Boolean {
        val am = audio() ?: return false
        am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, code))
        am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, code))
        return true
    }

    // ------------------------------------------------------------------ estado

    fun status(ctx: Context): JSONObject {
        val ip = NetUtils.localIp(ctx)
        return JSONObject()
            .put("ok", true)
            .put("version", VERSION)
            .put("ip", ip ?: JSONObject.NULL)
            .put("port", RemoteServer.port)
            .put("imeEnabled", ImeState.isImeEnabled(ctx))
            .put("imeSelected", ImeState.isImeSelected(ctx))
            .put("imeAlive", ime != null)
            .put("editorConnected", editorConnected)
            .put("accessibility", a11y != null)
            .put("lastClient", lastClient ?: JSONObject.NULL)
    }
}
