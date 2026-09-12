package cl.tracco.remotekeyboard

import android.content.ComponentName
import android.content.Context
import android.net.wifi.WifiManager
import android.provider.Settings
import android.view.inputmethod.InputMethodManager
import java.net.Inet4Address
import java.net.NetworkInterface

/** Utilidades de red: IP local del dispositivo en la red WiFi/Ethernet. */
object NetUtils {

    fun localIp(ctx: Context): String? {
        // 1) WifiManager (funciona en la gran mayoría de proyectores / TV box).
        try {
            val wm = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            @Suppress("DEPRECATION")
            val ip = wm?.connectionInfo?.ipAddress ?: 0
            if (ip != 0) return ipToString(ip)
        } catch (_: Throwable) {
        }
        // 2) Interfaces de red (WiFi o cable).
        val candidates = mutableListOf<Pair<String, String>>()
        try {
            val ifaces = NetworkInterface.getNetworkInterfaces() ?: return null
            for (ni in ifaces) {
                if (!ni.isUp || ni.isLoopback) continue
                for (addr in ni.inetAddresses) {
                    if (addr is Inet4Address && !addr.isLoopbackAddress) {
                        val host = addr.hostAddress ?: continue
                        candidates += ni.name to host
                    }
                }
            }
        } catch (_: Throwable) {
        }
        val pick = candidates.firstOrNull { it.first.startsWith("wlan") }
            ?: candidates.firstOrNull { it.first.startsWith("eth") }
            ?: candidates.firstOrNull { !it.first.startsWith("rmnet") }
        return pick?.second
    }

    private fun ipToString(ip: Int): String =
        "${ip and 0xff}.${(ip shr 8) and 0xff}.${(ip shr 16) and 0xff}.${(ip shr 24) and 0xff}"
}

/** Estado del teclado / accesibilidad según los ajustes del sistema. */
object ImeState {

    fun imeComponent(ctx: Context): ComponentName =
        ComponentName(ctx, RemoteInputMethodService::class.java)

    fun a11yComponent(ctx: Context): ComponentName =
        ComponentName(ctx, RemoteAccessibilityService::class.java)

    /** ¿Está el teclado activado en Ajustes → Idioma y teclado? */
    fun isImeEnabled(ctx: Context): Boolean {
        return try {
            val imm = ctx.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
            imm.enabledInputMethodList.any { it.packageName == ctx.packageName }
        } catch (_: Throwable) {
            false
        }
    }

    /** ¿Es el teclado seleccionado actualmente? */
    fun isImeSelected(ctx: Context): Boolean {
        val current = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD)
            ?: return false
        val cn = ComponentName.unflattenFromString(current)
        return cn?.packageName == ctx.packageName || Bridge.ime != null && current.contains(ctx.packageName)
    }

    /** ¿Está activado el servicio de accesibilidad? */
    fun isA11yEnabled(ctx: Context): Boolean {
        if (Bridge.a11y != null) return true
        val enabled = Settings.Secure.getString(
            ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        val flat = a11yComponent(ctx).flattenToString()
        val short = a11yComponent(ctx).flattenToShortString()
        return enabled.split(':').any { it.equals(flat, true) || it.equals(short, true) }
    }
}
