package cl.tracco.remotekeyboard

import android.content.Context
import android.util.Log
import fi.iki.elonen.NanoHTTPD
import org.json.JSONObject
import java.io.IOException

/**
 * Servidor HTTP embebido. Sirve la página web (assets/index.html) y la API:
 *
 *   GET  /api/status                 → estado del teclado
 *   POST /api/text    {"text": "…"}  → escribe texto en el campo con foco
 *   POST /api/key     {"key": "ENTER", "count": 1}  → tecla especial (ver Bridge.KEYS)
 *   POST /api/clear                  → borra todo el contenido del campo con foco
 *
 * Se mantiene encendido mientras haya al menos un "host" (teclado, accesibilidad
 * o la pantalla principal) que lo haya pedido con [acquire].
 */
object RemoteServer {
    private const val TAG = "RemoteServer"
    const val DEFAULT_PORT = 8765

    private val hosts = HashSet<String>()

    @Volatile private var server: Server? = null
    @Volatile var port: Int = DEFAULT_PORT
        private set
    @Volatile var lastError: String? = null
        private set

    @Synchronized
    fun acquire(ctx: Context, host: String) {
        Bridge.appContext = ctx.applicationContext
        hosts += host
        start(ctx.applicationContext)
    }

    @Synchronized
    fun release(host: String) {
        hosts -= host
        if (hosts.isEmpty()) stop()
    }

    fun isRunning(): Boolean = server?.isAlive == true

    fun url(ctx: Context): String? {
        val ip = NetUtils.localIp(ctx) ?: return null
        return "http://$ip:$port"
    }

    private fun start(ctx: Context) {
        if (server?.isAlive == true) return
        for (p in DEFAULT_PORT..DEFAULT_PORT + 5) {
            try {
                val s = Server(ctx, p)
                s.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)
                server = s
                port = p
                lastError = null
                Log.i(TAG, "Servidor iniciado en el puerto $p")
                return
            } catch (e: IOException) {
                lastError = e.message
                Log.w(TAG, "No se pudo abrir el puerto $p: ${e.message}")
            }
        }
    }

    private fun stop() {
        server?.stop()
        server = null
        Log.i(TAG, "Servidor detenido")
    }

    private class Server(private val ctx: Context, port: Int) : NanoHTTPD(port) {

        override fun serve(session: IHTTPSession): Response {
            val uri = session.uri ?: "/"
            val method = session.method
            val client = session.remoteIpAddress
            return try {
                when {
                    uri == "/" || uri == "/index.html" -> asset("index.html", "text/html; charset=utf-8")

                    uri == "/api/status" -> json(Bridge.status(ctx))

                    uri == "/api/text" && method == Method.POST -> {
                        val body = readJson(session)
                        val text = body.optString("text", "")
                        Bridge.touch(client)
                        result(if (text.isEmpty()) true else Bridge.typeText(text))
                    }

                    uri == "/api/key" && method == Method.POST -> {
                        val body = readJson(session)
                        val name = body.optString("key", "").trim().uppercase()
                        val count = body.optInt("count", 1).coerceIn(1, 500)
                        Bridge.touch(client)
                        val code = Bridge.KEYS[name] ?: body.optInt("code", -1)
                        if (code < 0) {
                            error(Response.Status.BAD_REQUEST, "Tecla desconocida: $name")
                        } else {
                            var ok = true
                            repeat(count) { ok = Bridge.key(code) && ok }
                            result(ok)
                        }
                    }

                    uri == "/api/clear" && method == Method.POST -> {
                        readJson(session)
                        Bridge.touch(client)
                        result(Bridge.clearAll())
                    }

                    else -> error(Response.Status.NOT_FOUND, "No encontrado")
                }
            } catch (t: Throwable) {
                Log.e(TAG, "Error atendiendo $method $uri", t)
                error(Response.Status.INTERNAL_ERROR, t.toString())
            }
        }

        private fun readJson(session: IHTTPSession): JSONObject {
            val files = HashMap<String, String>()
            try {
                session.parseBody(files)
            } catch (e: ResponseException) {
                throw IOException(e.message)
            }
            val raw = files["postData"] ?: ""
            if (raw.isBlank()) {
                // Alternativa: parámetros en la URL o en un formulario.
                val o = JSONObject()
                for ((k, v) in session.parms) o.put(k, v)
                return o
            }
            return JSONObject(raw)
        }

        private fun asset(name: String, mime: String): Response {
            val stream = ctx.assets.open(name)
            val bytes = stream.use { it.readBytes() }
            return newFixedLengthResponse(Response.Status.OK, mime, bytes.inputStream(), bytes.size.toLong())
                .noStore()
        }

        private fun json(o: JSONObject): Response =
            newFixedLengthResponse(Response.Status.OK, "application/json; charset=utf-8", o.toString()).noStore()

        private fun result(ok: Boolean): Response = json(
            JSONObject()
                .put("ok", ok)
                .put("editorConnected", Bridge.editorConnected)
                .put("imeAlive", Bridge.ime != null)
        )

        private fun error(status: Response.Status, message: String): Response =
            newFixedLengthResponse(
                status, "application/json; charset=utf-8",
                JSONObject().put("ok", false).put("error", message).toString()
            ).noStore()

        private fun Response.noStore(): Response = apply {
            addHeader("Cache-Control", "no-store")
        }
    }
}
