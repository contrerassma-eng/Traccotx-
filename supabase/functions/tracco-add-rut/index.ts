// Tracco Tx - Edge Function tracco-add-rut (Deno / Supabase)
// Agrega un RUT al perfil del usuario validando contra el SII:
//   - inicia sesion con la clave (CLAVE_SII), FUERZA seleccionar ese RUT como empresa
//     y consulta "documentos recibidos". Si el SII responde "Error al contribuyente"
//     => el usuario no representa ese RUT => error. Si responde la pagina de docs
//     => valido => se crea tx_contribuyentes + tx_usuario_rut para su correo.
// POST { rut }  (Authorization: Bearer access_token del usuario)  -> { ok, ruts, empresas }
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type, authorization, apikey" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json; charset=utf-8", ...cors } });
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

class Jar { cookies = new Map<string, string>(); add(scs: string[]) { for (const sc of scs) { const f = sc.split(";")[0]; const eq = f.indexOf("="); if (eq > 0) { const n = f.slice(0, eq).trim(); const v = f.slice(eq + 1).trim(); if (v && v !== "deleted") this.cookies.set(n, v); } } } header() { return [...this.cookies.entries()].map(([k, v]) => k + "=" + v).join("; "); } }
async function fetchJar(jar: Jar, url: string, opts: RequestInit, maxRedir = 6): Promise<Response> { let cur = url; let o: RequestInit = { ...opts }; for (let i = 0; i < maxRedir; i++) { const h = new Headers(o.headers || {}); if (jar.cookies.size) h.set("Cookie", jar.header()); const r = await fetch(cur, { ...o, headers: h, redirect: "manual" }); try { const sc = (r.headers as any).getSetCookie ? (r.headers as any).getSetCookie() : []; jar.add(sc); } catch { /* */ } if (r.status >= 300 && r.status < 400) { const loc = r.headers.get("location"); if (!loc) return r; cur = new URL(loc, cur).toString(); await r.body?.cancel(); o = { method: "GET", headers: { "User-Agent": UA } }; continue; } return r; } throw new Error("redirects"); }

async function loginClave(rutCompleto: string, clave: string, jar: Jar): Promise<string> {
  const [rut, dv] = rutCompleto.split("-");
  const body = new URLSearchParams({ rut, dv, referencia: "https://www1.sii.cl/cgi-bin/Portal001/mipeAdminDocsRcp.cgi", "411": "", rutcntr: rutCompleto, clave }).toString();
  await fetchJar(jar, "https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA, "Origin": "https://zeusr.sii.cl", "Referer": "https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi" }, body });
  return jar.cookies.get("TOKEN") || "";
}
// Fuerza seleccionar la empresa = rutCompleto (el SII valida que sea representada).
// Devuelve el nombre de la empresa si aparece en el selector.
async function seleccionarEmpresa(rutCompleto: string, jar: Jar): Promise<string> {
  const selUrl = "https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi?DESDE_DONDE_URL=OPCION%3D1%26TIPO%3D4";
  const r = await fetchJar(jar, selUrl, { method: "GET", headers: { "User-Agent": UA, "Referer": "https://www1.sii.cl/Portal001/menuFacturaElectronica.html" } });
  const html = new TextDecoder("iso-8859-1").decode(new Uint8Array(await r.arrayBuffer()));
  const form = html.match(/<form[^>]*>[\s\S]*?<\/form>/i); if (!form) return "";
  const action = (form[0].match(/action=["']?([^"'\s>]+)/i) || [])[1] || "mipeSelEmpresa.cgi";
  const actionUrl = new URL(action.replace(/&amp;/g, "&"), "https://www1.sii.cl/cgi-bin/Portal001/").toString();
  const params = new URLSearchParams();
  for (const h of form[0].matchAll(/<input[^>]*>/gi)) { const tag = h[0]; if (!/type=["']?hidden/i.test(tag) && !/type=["']?submit/i.test(tag) && /type=/i.test(tag)) continue; const n = (tag.match(/name=["']?([^"'\s>]+)/i) || [])[1]; const v = (tag.match(/value=["']?([^"'>]*)/i) || [])[1] || ""; if (n) params.set(n, v.replace(/&amp;/g, "&")); }
  const rutNum = rutCompleto.split("-")[0].replace(/\D/g, "");
  const sel = form[0].match(/<select[^>]*name=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/select>/i);
  const selName = sel ? sel[1] : "RUT_EMP";
  let nombre = "";
  if (sel) { for (const o of sel[2].matchAll(/<option[^>]*value=["']?([^"'>]*)["']?[^>]*>([^<]*)</gi)) { const val = (o[1] || "").trim(), lab = (o[2] || "").trim(); if (val.includes(rutCompleto) || val.includes(rutNum) || lab.includes(rutNum)) { nombre = lab.replace(rutCompleto, "").replace(rutNum, "").replace(/[\s.-]+$/, "").trim(); break; } } }
  params.set(selName, rutCompleto);
  const pr = await fetchJar(jar, actionUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA, "Origin": "https://www1.sii.cl", "Referer": selUrl }, body: params.toString() }); await pr.body?.cancel();
  return nombre;
}
// True si la sesion puede ver los documentos recibidos del RUT (no "Error al contribuyente").
async function tieneAcceso(jar: Jar): Promise<boolean> {
  const seedUrl = "https://www1.sii.cl/cgi-bin/Portal001/mipeAdminDocsRcp.cgi?RUT_EMI=&FOLIO=&RZN_SOC=&FEC_DESDE=&FEC_HASTA=&TPO_DOC=&ESTADO=&ORDEN=&NUM_PAG=1";
  const r = await fetchJar(jar, seedUrl, { method: "GET", headers: { "User-Agent": UA, "Referer": "https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi?DESDE_DONDE_URL=OPCION%3D1%26TIPO%3D4" } });
  const txt = new TextDecoder("iso-8859-1").decode(new Uint8Array(await r.arrayBuffer()));
  if (/Error al contribuyente|no ha seleccionado|no autorizado|no tiene perfil/i.test(txt)) return false;
  // La pagina de administracion de documentos trae el formulario de busqueda.
  return /ADMINISTRACI[OÓ]N DE DOCUMENTOS|mipeDownLoad|FEC_DESDE/i.test(txt);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Usa POST" }, 405);
  try {
    const { rut } = await req.json().catch(() => ({}));
    const rutN = String(rut || "").trim().toUpperCase().replace(/\s/g, "");
    if (!/^\d{7,8}-[\dkK]$/.test(rutN)) return json({ ok: false, error: "RUT inválido. Formato 12345678-9." }, 400);

    const URL_S = Deno.env.get("SUPABASE_URL")!, KEY_S = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const claveSII = Deno.env.get("CLAVE_SII"); if (!claveSII) return json({ ok: false, error: "Falta CLAVE_SII en el servidor" }, 500);
    const admin = createClient(URL_S, KEY_S, { auth: { persistSession: false } });

    // Identidad del usuario (de su sesion).
    const bearer = (req.headers.get("Authorization") || "").replace("Bearer ", "").trim();
    if (!bearer) return json({ ok: false, error: "Falta sesión" }, 401);
    const { data: ures } = await admin.auth.getUser(bearer);
    const email = ures?.user?.email?.toLowerCase();
    if (!email) return json({ ok: false, error: "Sesión no válida" }, 401);

    // Si ya lo tiene, no repetimos la validación.
    const { data: yaTiene } = await admin.from("tx_usuario_rut").select("rut").eq("email", email).eq("rut", rutN).maybeSingle();
    if (!yaTiene) {
      // Validar contra el SII: login -> forzar empresa = rut -> ¿ve sus documentos?
      const jar = new Jar();
      const token = await loginClave("10514666-3", claveSII, jar).catch(() => "");
      // Nota: se usa la clave del titular configurada en el servidor; selecciona la
      // empresa por RUT. (Multi-usuario con clave propia: pendiente.)
      if (!token) return json({ ok: false, error: "El SII está limitando la sesión; reintenta en un minuto." }, 502);
      const nombre = await seleccionarEmpresa(rutN, jar).catch(() => "");
      const ok = await tieneAcceso(jar).catch(() => false);
      if (!ok) return json({ ok: false, error: "Ese RUT no existe o no tienes acceso a él con la clave configurada." }, 403);

      await admin.from("tx_contribuyentes").upsert({ rut: rutN, ...(nombre ? { razon_social: nombre } : {}) }, { onConflict: "rut", ignoreDuplicates: false });
      await admin.from("tx_usuario_rut").upsert({ email, rut: rutN, rol: "cliente" }, { onConflict: "email,rut", ignoreDuplicates: true });
    }

    // Devolver la lista actualizada para el selector.
    const { data: urs } = await admin.from("tx_usuario_rut").select("rut").eq("email", email);
    const ruts = (urs || []).map((x: any) => x.rut);
    const { data: empresas } = await admin.from("tx_contribuyentes").select("rut, razon_social").in("rut", ruts.length ? ruts : ["-"]);
    return json({ ok: true, rut: rutN, ruts, empresas: empresas || [] });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});
