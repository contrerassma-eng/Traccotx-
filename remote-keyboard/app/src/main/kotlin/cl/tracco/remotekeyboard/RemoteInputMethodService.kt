package cl.tracco.remotekeyboard

import android.inputmethodservice.InputMethodService
import android.text.InputType
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.TextView

/**
 * Teclado (IME). No dibuja teclas: sólo una franja con la dirección de conexión.
 * El texto llega por la red (ver [RemoteServer]) y se inyecta en el campo con foco.
 */
class RemoteInputMethodService : InputMethodService() {

    private var strip: TextView? = null

    override fun onCreate() {
        super.onCreate()
        Bridge.ime = this
        RemoteServer.acquire(applicationContext, "ime")
    }

    override fun onDestroy() {
        if (Bridge.ime === this) {
            Bridge.ime = null
            Bridge.editorConnected = false
        }
        RemoteServer.release("ime")
        super.onDestroy()
    }

    override fun onCreateInputView(): View {
        val tv = TextView(this).apply {
            setBackgroundColor(0xFF0F172A.toInt())
            setTextColor(0xFFF1F5F9.toInt())
            textSize = 16f
            gravity = Gravity.CENTER
            val h = dp(16)
            val v = dp(12)
            setPadding(h, v, h, v)
        }
        strip = tv
        updateStrip()
        return tv
    }

    /** Nunca pasar a modo pantalla completa (importante en horizontal / proyector). */
    override fun onEvaluateFullscreenMode(): Boolean = false

    /** Mostrar siempre la franja, aunque el sistema crea que hay teclado físico. */
    override fun onEvaluateInputViewShown(): Boolean {
        super.onEvaluateInputViewShown()
        return true
    }

    override fun onStartInput(attribute: EditorInfo?, restarting: Boolean) {
        super.onStartInput(attribute, restarting)
        Bridge.editorConnected = true
        updateStrip()
    }

    override fun onStartInputView(info: EditorInfo?, restarting: Boolean) {
        super.onStartInputView(info, restarting)
        updateStrip()
    }

    override fun onFinishInput() {
        super.onFinishInput()
        Bridge.editorConnected = false
    }

    fun updateStrip() {
        val tv = strip ?: return
        val url = RemoteServer.url(this)
        val client = Bridge.lastClient
        tv.text = when {
            url == null -> getString(R.string.strip_no_network)
            client != null -> getString(R.string.strip_connected, client)
            else -> getString(R.string.strip_waiting, url)
        }
    }

    // ------------------------------------------------------------ acciones

    fun typeText(text: String): Boolean {
        val ic = currentInputConnection ?: return false
        return ic.commitText(text, 1)
    }

    fun backspace(count: Int): Boolean {
        currentInputConnection ?: return false
        repeat(count) { sendDownUpKeyEvents(KeyEvent.KEYCODE_DEL) }
        return true
    }

    fun sendKey(code: Int): Boolean {
        currentInputConnection ?: return false
        sendDownUpKeyEvents(code)
        return true
    }

    /**
     * Enter "inteligente": si el campo declara una acción (Buscar, Ir, Enviar, Listo…)
     * la ejecuta, igual que haría un teclado normal; si no, envía la tecla Enter.
     */
    fun enter(): Boolean {
        val ic = currentInputConnection ?: return false
        val ei = currentInputEditorInfo
        val options = ei?.imeOptions ?: 0
        val action = options and EditorInfo.IME_MASK_ACTION
        val noEnterAction = options and EditorInfo.IME_FLAG_NO_ENTER_ACTION != 0
        val multiline = (ei?.inputType ?: 0) and InputType.TYPE_TEXT_FLAG_MULTI_LINE != 0
        val hasAction = action != EditorInfo.IME_ACTION_NONE && action != EditorInfo.IME_ACTION_UNSPECIFIED
        return if (hasAction && !noEnterAction && !multiline) {
            ic.performEditorAction(action)
        } else {
            sendDownUpKeyEvents(KeyEvent.KEYCODE_ENTER)
            true
        }
    }

    /** Borra todo el contenido del campo con foco. */
    fun clearAll(): Boolean {
        val ic = currentInputConnection ?: return false
        val before = ic.getTextBeforeCursor(100_000, 0)
        val after = ic.getTextAfterCursor(100_000, 0)
        if (before == null || after == null) {
            ic.performContextMenuAction(android.R.id.selectAll)
            sendDownUpKeyEvents(KeyEvent.KEYCODE_DEL)
            return true
        }
        ic.beginBatchEdit()
        ic.finishComposingText()
        ic.deleteSurroundingText(before.length, after.length)
        ic.endBatchEdit()
        return true
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density + 0.5f).toInt()
}
