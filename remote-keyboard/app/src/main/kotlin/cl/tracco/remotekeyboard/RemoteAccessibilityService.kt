package cl.tracco.remotekeyboard

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.view.KeyEvent
import android.view.View
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Servicio de accesibilidad opcional: botones globales (Volver, Inicio, Recientes)
 * y movimiento de foco cuando no hay ningún campo de texto seleccionado.
 */
class RemoteAccessibilityService : AccessibilityService() {

    override fun onServiceConnected() {
        super.onServiceConnected()
        Bridge.a11y = this
        RemoteServer.acquire(applicationContext, "a11y")
    }

    override fun onUnbind(intent: Intent?): Boolean {
        cleanup()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        cleanup()
        super.onDestroy()
    }

    private fun cleanup() {
        if (Bridge.a11y === this) Bridge.a11y = null
        RemoteServer.release("a11y")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // No necesitamos reaccionar a eventos; sólo ejecutar acciones bajo demanda.
    }

    override fun onInterrupt() {}

    fun back(): Boolean = performGlobalAction(GLOBAL_ACTION_BACK)
    fun home(): Boolean = performGlobalAction(GLOBAL_ACTION_HOME)
    fun recents(): Boolean = performGlobalAction(GLOBAL_ACTION_RECENTS)

    /** Navegación aproximada con las flechas cuando no hay campo de texto activo. */
    fun dpad(code: Int): Boolean {
        val root = rootInActiveWindow ?: return false
        val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
            ?: root.findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY)

        if (code == KeyEvent.KEYCODE_DPAD_CENTER) {
            val target = focused ?: return false
            return target.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        }

        val direction = when (code) {
            KeyEvent.KEYCODE_DPAD_UP -> View.FOCUS_UP
            KeyEvent.KEYCODE_DPAD_DOWN -> View.FOCUS_DOWN
            KeyEvent.KEYCODE_DPAD_LEFT -> View.FOCUS_LEFT
            KeyEvent.KEYCODE_DPAD_RIGHT -> View.FOCUS_RIGHT
            else -> return false
        }
        val next = focused?.focusSearch(direction) ?: firstFocusable(root) ?: return false
        return next.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
    }

    private fun firstFocusable(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        if (node == null) return null
        if (node.isFocusable && node.isVisibleToUser) return node
        for (i in 0 until node.childCount) {
            val found = firstFocusable(node.getChild(i))
            if (found != null) return found
        }
        return null
    }
}
