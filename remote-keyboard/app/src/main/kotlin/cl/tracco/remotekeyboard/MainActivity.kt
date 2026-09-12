package cl.tracco.remotekeyboard

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter

/** Pantalla de configuración: activa el teclado y muestra la dirección / QR para conectarse. */
class MainActivity : Activity() {

    private val handler = Handler(Looper.getMainLooper())
    private var lastQrUrl: String? = null

    private val refresher = object : Runnable {
        override fun run() {
            refresh()
            handler.postDelayed(this, 1500)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        findViewById<Button>(R.id.btn_step1).setOnClickListener {
            open(Intent(Settings.ACTION_INPUT_METHOD_SETTINGS))
        }
        findViewById<Button>(R.id.btn_step2).setOnClickListener {
            val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
            imm.showInputMethodPicker()
        }
        findViewById<Button>(R.id.btn_step3).setOnClickListener {
            open(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        findViewById<Button>(R.id.btn_refresh).setOnClickListener { refresh() }
    }

    override fun onStart() {
        super.onStart()
        // La pantalla principal también mantiene el servidor vivo para poder mostrar
        // la dirección / QR antes de completar los pasos.
        RemoteServer.acquire(this, "activity")
    }

    override fun onResume() {
        super.onResume()
        handler.post(refresher)
    }

    override fun onPause() {
        handler.removeCallbacks(refresher)
        super.onPause()
    }

    override fun onStop() {
        RemoteServer.release("activity")
        super.onStop()
    }

    private fun open(intent: Intent) {
        try {
            startActivity(intent)
        } catch (_: Throwable) {
            Toast.makeText(this, "No se pudo abrir esta pantalla de ajustes en este dispositivo.", Toast.LENGTH_LONG).show()
        }
    }

    private fun refresh() {
        val enabled = ImeState.isImeEnabled(this)
        val selected = ImeState.isImeSelected(this)
        val a11y = ImeState.isA11yEnabled(this)

        setStatus(R.id.status_step1, enabled)
        setStatus(R.id.status_step2, selected)
        findViewById<TextView>(R.id.status_step3).text =
            if (a11y) getString(R.string.status_done) else getString(R.string.status_optional)

        val urlView = findViewById<TextView>(R.id.url)
        val hintView = findViewById<TextView>(R.id.url_hint)
        val qrView = findViewById<ImageView>(R.id.qr)

        val url = RemoteServer.url(this)
        when {
            url == null -> {
                urlView.text = "—"
                hintView.text = getString(R.string.no_network)
                hintView.visibility = View.VISIBLE
                qrView.visibility = View.GONE
                lastQrUrl = null
            }
            else -> {
                urlView.text = url
                val running = RemoteServer.isRunning()
                hintView.text = when {
                    !running -> RemoteServer.lastError ?: getString(R.string.server_stopped)
                    !enabled || !selected -> getString(R.string.server_stopped)
                    else -> ""
                }
                hintView.visibility = if (hintView.text.isEmpty()) View.GONE else View.VISIBLE
                qrView.visibility = View.VISIBLE
                if (url != lastQrUrl) {
                    qrView.setImageBitmap(qr(url, 480))
                    lastQrUrl = url
                }
            }
        }
    }

    private fun setStatus(id: Int, done: Boolean) {
        findViewById<TextView>(id).text =
            if (done) getString(R.string.status_done) else getString(R.string.status_pending)
    }

    private fun qr(text: String, size: Int): Bitmap {
        val matrix = QRCodeWriter().encode(
            text, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.MARGIN to 1)
        )
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.RGB_565)
        for (y in 0 until size) {
            for (x in 0 until size) {
                bmp.setPixel(x, y, if (matrix[x, y]) Color.BLACK else Color.WHITE)
            }
        }
        return bmp
    }
}
