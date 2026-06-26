// Tracco Tx - Edge Function tracco-ingesta (Deno / Supabase) — CLAVE-ONLY (sin cert)
// Un solo login con la clave tributaria sirve para TODO:
//   - RCV de compras (www4, con el TOKEN de la sesion de clave) -> montos/IEPD
//   - Detalle del DTE (www1, mismo session) -> GiroEmis + items + litros
// Clasifica cada factura y la guarda en tx_facturas; recalcula tx_periodos.
//   ?rut=&periodo=AAAAMM   o   ?rut=&desde=AAAAMM&hasta=AAAAMM
// Auth: Bearer = access_token de usuario autorizado al RUT, o el service_role (cron).
import { unzipSync } from "npm:fflate@0.8.2";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "content-type, authorization, apikey" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 2), { status: s, headers: { "Content-Type": "application/json; charset=utf-8", ...cors } });
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const numCLP = (s: string) => parseInt(String(s || "0").replace(/\D/g, ""), 10) || 0;
function num(s: string): number { s = (s || "").trim(); if (s.includes(",") && s.includes(".")) s = s.replace(/\./g, "").replace(",", "."); else if (s.includes(",")) s = s.replace(",", "."); return parseFloat(s) || 0; }
function fechaISO(s: string): string | null { const m = String(s || "").match(/(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})/); if (!m) return null; return m[3] + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0"); }

class Jar { cookies = new Map<string, string>(); add(scs: string[]) { for (const sc of scs) { const f = sc.split(";")[0]; const eq = f.indexOf("="); if (eq > 0) { const n = f.slice(0, eq).trim(); const v = f.slice(eq + 1).trim(); if (v && v !== "deleted") this.cookies.set(n, v); } } } header() { return [...this.cookies.entries()].map(([k, v]) => k + "=" + v).join("; "); } }
async function fetchJar(jar: Jar, url: string, opts: RequestInit, maxRedir = 6): Promise<Response> { let cur = url; let o: RequestInit = { ...opts }; for (let i = 0; i < maxRedir; i++) { const h = new Headers(o.headers || {}); if (jar.cookies.size) h.set("Cookie", jar.header()); const r = await fetch(cur, { ...o, headers: h, redirect: "manual" }); try { const sc = (r.headers as any).getSetCookie ? (r.headers as any).getSetCookie() : []; jar.add(sc); } catch { /* */ } if (r.status >= 300 && r.status < 400) { const loc = r.headers.get("location"); if (!loc) return r; cur = new URL(loc, cur).toString(); await r.body?.cancel(); o = { method: "GET", headers: { "User-Agent": UA } }; continue; } return r; } throw new Error("redirects"); }

async function loginClave(rutCompleto: string, clave: string, jar: Jar): Promise<string> {
  const [rut, dv] = rutCompleto.split("-");
  const body = new URLSearchParams({ rut, dv, referencia: "https://www1.sii.cl/cgi-bin/Portal001/mipeAdminDocsRcp.cgi", "411": "", rutcntr: rutCompleto, clave }).toString();
  await fetchJar(jar, "https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA, "Origin": "https://zeusr.sii.cl", "Referer": "https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi" }, body });
  return jar.cookies.get("TOKEN") || "";
}
// Login con reintentos + espera creciente: cuando el SII está limitando, el login
// vuelve sin TOKEN (solo cookies de balanceador). Esperamos y reintentamos con un
// jar nuevo hasta conseguirlo, para no dejar el período vacío.
async function loginConReintentos(rutCompleto: string, clave: string, max = 3): Promise<{ token: string; jar: Jar; intentos: number }> {
  const esperas = [0, 12000, 28000, 45000];
  let jar = new Jar();
  for (let i = 0; i < max; i++) {
    if (esperas[i]) await sleep(esperas[i]);
    jar = new Jar();
    const t = await loginClave(rutCompleto, clave, jar).catch(() => "");
    if (t) return { token: t, jar, intentos: i + 1 };
  }
  return { token: "", jar, intentos: max };
}
// RCV compras del periodo usando el TOKEN de la sesion de clave (sin certificado).
async function comprasRCV(jar: Jar, token: string, rutCompleto: string, periodo: string): Promise<any[]> {
  const [rut, dv] = rutCompleto.split("-");
  const body = { metaData: { namespace: "cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService/getDetalleCompraExport", conversationId: token, transactionId: crypto.randomUUID(), page: null }, data: { rutEmisor: rut, dvEmisor: dv, ptributario: periodo, codTipoDoc: 0, operacion: "COMPRA", estadoContab: "REGISTRO", accionRecaptcha: "RCV_DDETC", tokenRecaptcha: "t-o-k-e-n-web" } };
  const r = await fetch("https://www4.sii.cl/consdcvinternetui/services/data/facadeService/getDetalleCompraExport", { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json, text/plain, */*", "Origin": "https://www4.sii.cl", "Referer": "https://www4.sii.cl/consdcvinternetui/", "Cookie": jar.header() }, body: JSON.stringify(body) });
  if (r.status !== 200) return [];
  let parsed: any; try { parsed = JSON.parse(await r.text()); } catch { return []; }
  let arr: any[] | null = Array.isArray(parsed) ? parsed : null;
  if (!arr && parsed && typeof parsed === "object") for (const k of Object.keys(parsed)) if (Array.isArray(parsed[k])) { arr = parsed[k]; break; }
  if (!arr || arr.length < 2) return [];
  const H = String(arr[0]).split(";").map((h) => h.trim()); const col = (n: string) => H.findIndex((h) => h.toLowerCase() === n.toLowerCase());
  const iR = col("RUT Proveedor"), iN = col("Razon Social"), iF = col("Folio"), iFe = col("Fecha Docto"), iFr = col("Fecha Recepcion"), iT = col("Tipo Doc"), iNeto = col("Monto Neto"), iEx = col("Monto Exento"), iIva = col("Monto IVA Recuperable"), iTot = col("Monto Total"), iCod = col("Codigo Otro Impuesto"), iVal = col("Valor Otro Impuesto");
  return arr.slice(1).map((l: any) => { const c = String(l).split(";"); const cod = iCod >= 0 ? (c[iCod] || "").trim() : ""; return { rutContraparte: c[iR], razonSocial: c[iN], tipoDte: parseInt(c[iT], 10) || null, folio: (c[iF] || "").trim(), fechaEmision: fechaISO(c[iFe]), fechaRecepcion: fechaISO(c[iFr]), neto: numCLP(c[iNeto]), exento: numCLP(c[iEx]), iva: numCLP(c[iIva]), total: numCLP(c[iTot]), codOtroImp: cod ? parseInt(cod, 10) : null, iepd: cod === "28" ? numCLP(c[iVal]) : 0 }; }); }

// Detalle del DTE: folio -> { litros, giro, items[] }.
function parseDte(xml: string, map: Record<string, { litros: number; giro: string; items: string[] }>) {
  for (const d of xml.split(/<Documento[\s>]/).slice(1)) {
    const fm = d.match(/<Folio>(\d+)<\/Folio>/); if (!fm) continue;
    const folio = fm[1];
    const giro = (d.match(/<GiroEmis>([^<]*)<\/GiroEmis>/) || ["", ""])[1].trim();
    const items: string[] = []; let litros = 0;
    for (const det of d.split(/<Detalle>/).slice(1)) {
      const body = det.split(/<\/Detalle>/)[0];
      const nombre = (body.match(/<NmbItem>([^<]*)<\/NmbItem>/) || ["", ""])[1].trim();
      const dsc = (body.match(/<DscItem>([^<]*)<\/DscItem>/) || ["", ""])[1].trim();
      const unidad = (body.match(/<UnmdItem>([^<]*)<\/UnmdItem>/) || ["", ""])[1];
      const qm = body.match(/<QtyItem>([\d.,]+)<\/QtyItem>/);
      if (nombre || dsc) items.push((nombre + " " + dsc).trim());
      const esD = /diesel|petr[oó]leo/i.test(nombre) || /diesel|petr[oó]leo/i.test(dsc);
      if (qm && (esD || /^(lt|lts|litro|litros|l)$/i.test(unidad.trim()))) litros += num(qm[1]);
      else if (/<CodImpAdic>\s*28\s*<\/CodImpAdic>/.test(body) && dsc) { const lm = dsc.match(/([\d][\d.,]*)\s*\|?\s*(?:litros?|lts?|l)\b/i); if (lm) litros += num(lm[1]); }
    }
    map[folio] = { litros: +litros.toFixed(2), giro, items: items.slice(0, 8) };
  }
}
async function descargarDte(jar: Jar, url: string): Promise<Record<string, any>> {
  const map: Record<string, any> = {};
  const r = await fetchJar(jar, url, { method: "GET", headers: { "User-Agent": UA } });
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) { try { const files = unzipSync(buf); for (const n of Object.keys(files)) if (/\.xml$/i.test(n)) parseDte(new TextDecoder().decode(files[n]), map); } catch { /* */ } return map; }
  const txt = new TextDecoder("iso-8859-1").decode(buf);
  if (!/Error al contribuyente|no ha seleccionado/i.test(txt)) parseDte(txt, map);
  return map;
}
async function seleccionarEmpresa(rutCompleto: string, jar: Jar, dbg?: any): Promise<boolean> {
  const selUrl = "https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi?DESDE_DONDE_URL=OPCION%3D1%26TIPO%3D4";
  const r = await fetchJar(jar, selUrl, { method: "GET", headers: { "User-Agent": UA, "Referer": "https://www1.sii.cl/Portal001/menuFacturaElectronica.html" } });
  const html = new TextDecoder("iso-8859-1").decode(new Uint8Array(await r.arrayBuffer()));
  if (dbg) dbg.selStatus = r.status, dbg.selBytes = html.length;
  const form = html.match(/<form[^>]*>[\s\S]*?<\/form>/i); if (!form) { if (dbg) dbg.selForm = false; return false; }
  const action = (form[0].match(/action=["']?([^"'\s>]+)/i) || [])[1] || "mipeSelEmpresa.cgi";
  const actionUrl = new URL(action.replace(/&amp;/g, "&"), "https://www1.sii.cl/cgi-bin/Portal001/").toString();
  const params = new URLSearchParams();
  for (const h of form[0].matchAll(/<input[^>]*>/gi)) { const tag = h[0]; if (!/type=["']?hidden/i.test(tag) && !/type=["']?submit/i.test(tag) && /type=/i.test(tag)) continue; const n = (tag.match(/name=["']?([^"'\s>]+)/i) || [])[1]; const v = (tag.match(/value=["']?([^"'>]*)/i) || [])[1] || ""; if (n) params.set(n, v.replace(/&amp;/g, "&")); }
  const rutNum = rutCompleto.split("-")[0].replace(/\D/g, ""); const rutDot = rutNum.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const sel = form[0].match(/<select[^>]*name=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/select>/i);
  // Nombre del campo de empresa (el selector real del SII es RUT_EMP).
  const selName = sel ? sel[1] : "RUT_EMP";
  let chosen = ""; const opts: string[] = [];
  if (sel) { for (const o of sel[2].matchAll(/<option[^>]*value=["']?([^"'>]*)["']?[^>]*>([^<]*)</gi)) { const val = (o[1] || "").trim(), lab = (o[2] || "").trim(); opts.push(val + " :: " + lab); if (val.includes(rutCompleto) || val.includes(rutNum) || lab.includes(rutNum) || lab.includes(rutDot)) { chosen = val; break; } } }
  // Forzamos la empresa = rutContrib aunque el parseo del dropdown no la haya visto
  // (el SII valida que sea una empresa representada y la acepta). El valor del SII
  // es el RUT con dígito verificador.
  const elegido = chosen || rutCompleto;
  params.set(selName, elegido);
  if (dbg) dbg.opciones = opts, dbg.elegido = elegido, dbg.match = !!chosen, dbg.selName = selName;
  const pr = await fetchJar(jar, actionUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA, "Origin": "https://www1.sii.cl", "Referer": selUrl }, body: params.toString() }); if (dbg) dbg.postStatus = pr.status; await pr.body?.cancel();
  return true;
}
// Obtiene folio -> {litros, giro, items} replicando el flujo que SI rescataba litros:
//   1) siembra la sesion www1 listando los recibidos del rango (mipeAdminDocsRcp) y
//      extrae el link real de descarga;
//   2) descarga masiva del periodo;
//   3) descarga DIRIGIDA por (mes de EMISION del documento, tipo) con ventana hasta
//      fin de periodo, para los folios de diesel que sigan sin litros (caza los DTE
//      recibidos en un mes pero emitidos en otro y el tope ~20 docs del SII).
async function obtenerDetalle(periodo: string, compras: any[], jar: Jar, dbg?: any): Promise<Record<string, any>> {
  const y = periodo.slice(0, 4), m = periodo.slice(4, 6); const last = String(new Date(+y, +m, 0).getDate()).padStart(2, "0");
  const desde = y + "-" + m + "-01", hasta = y + "-" + m + "-" + last;
  const map: Record<string, any> = {};
  const merge = (src: Record<string, any>) => { for (const k in src) { if (!map[k]) map[k] = src[k]; else if (!(map[k].litros > 0) && src[k].litros > 0) map[k] = src[k]; } };

  // 1) Sembrar la sesion y extraer el link real de descarga del rango.
  let bulkUrl = "https://www1.sii.cl/cgi-bin/Portal001/mipeDownLoad.cgi?ORIGEN=RCP&RUT_EMI=&FOLIO=&RZN_SOC=&FEC_DESDE=" + desde + "&FEC_HASTA=" + hasta + "&TPO_DOC=&ESTADO=&ORDEN=&DOWNLOAD=XML";
  try {
    const seedUrl = "https://www1.sii.cl/cgi-bin/Portal001/mipeAdminDocsRcp.cgi?RUT_EMI=&FOLIO=&RZN_SOC=&FEC_DESDE=" + desde + "&FEC_HASTA=" + hasta + "&TPO_DOC=&ESTADO=&ORDEN=&NUM_PAG=1";
    const sr = await fetchJar(jar, seedUrl, { method: "GET", headers: { "User-Agent": UA, "Referer": "https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi?DESDE_DONDE_URL=OPCION%3D1%26TIPO%3D4" } });
    const seedTxt = new TextDecoder("iso-8859-1").decode(new Uint8Array(await sr.arrayBuffer()));
    const linkMatch = seedTxt.match(/mipeDownLoad\.cgi[^"'\s>)]*/i);
    if (dbg) dbg.seedStatus = sr.status, dbg.seedBytes = seedTxt.length, dbg.seedLink = linkMatch ? linkMatch[0].slice(0, 200) : null, dbg.seedErr = /Error al contribuyente|no ha seleccionado/i.test(seedTxt);
    if (linkMatch) { const u = new URL(linkMatch[0].replace(/&amp;/g, "&"), "https://www1.sii.cl/cgi-bin/Portal001/").toString(); bulkUrl = /DOWNLOAD=/i.test(u) ? u.replace(/DOWNLOAD=[^&]*/i, "DOWNLOAD=XML") : u + "&DOWNLOAD=XML"; }
  } catch (e) { if (dbg) dbg.seedErr2 = (e as Error).message; }

  // 2) Descarga masiva del periodo.
  const bulk = await descargarDte(jar, bulkUrl); merge(bulk);
  if (dbg) dbg.bulkFolios = Object.keys(bulk), dbg.bulkConLitros = Object.values(bulk).filter((x: any) => x.litros > 0).length;

  // 3) Descarga dirigida por (mes de emision, tipo) para diesel sin litros.
  const dl = (fd: string, fh: string, tpo: string) => "https://www1.sii.cl/cgi-bin/Portal001/mipeDownLoad.cgi?ORIGEN=RCP&RUT_EMI=&FOLIO=&RZN_SOC=&FEC_DESDE=" + fd + "&FEC_HASTA=" + fh + "&TPO_DOC=" + tpo + "&ESTADO=&ORDEN=&DOWNLOAD=XML";
  const diesel = compras.filter((c) => (c.iepd || 0) > 0);
  const hechos = new Set<string>();
  for (const d of diesel) {
    if (map[d.folio]?.litros > 0) continue;
    const fp = String(d.fechaEmision || "").split("-"); // ISO yyyy-mm-dd
    if (fp.length !== 3) continue;
    const fd = fp[0] + "-" + fp[1].padStart(2, "0") + "-01";
    const tpo = String(d.tipoDte || "").replace(/\D/g, "");
    const key = fd + "|" + tpo;
    if (hechos.has(key)) continue;
    hechos.add(key);
    await sleep(800);
    merge(await descargarDte(jar, dl(fd, hasta, tpo)));
  }
  return map;
}

function clasificar(f: any, cats: { nombre: string; palabras_clave: string[] }[]): string {
  if (f.iepd > 0) return "Combustible";
  const hay = ((f.razonSocial || "") + " | " + (f.giro || "") + " | " + (f.items || []).join(" ")).toUpperCase();
  for (const c of cats) { if ((c.palabras_clave || []).some((k) => k && hay.includes(k.toUpperCase()))) return c.nombre; }
  return "Otros";
}
// RCV de VENTAS del periodo (ingresos) usando el mismo token de clave.
async function ventasRCV(jar: Jar, token: string, rutCompleto: string, periodo: string): Promise<any[]> {
  const [rut, dv] = rutCompleto.split("-");
  const body = { metaData: { namespace: "cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService/getDetalleVentaExport", conversationId: token, transactionId: crypto.randomUUID(), page: null }, data: { rutEmisor: rut, dvEmisor: dv, ptributario: periodo, codTipoDoc: 0, operacion: "VENTA", estadoContab: "REGISTRO", accionRecaptcha: "RCV_DDETC", tokenRecaptcha: "t-o-k-e-n-web" } };
  const r = await fetch("https://www4.sii.cl/consdcvinternetui/services/data/facadeService/getDetalleVentaExport", { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json, text/plain, */*", "Origin": "https://www4.sii.cl", "Referer": "https://www4.sii.cl/consdcvinternetui/", "Cookie": jar.header() }, body: JSON.stringify(body) });
  if (r.status !== 200) return [];
  let parsed: any; try { parsed = JSON.parse(await r.text()); } catch { return []; }
  let arr: any[] | null = Array.isArray(parsed) ? parsed : null;
  if (!arr && parsed && typeof parsed === "object") for (const k of Object.keys(parsed)) if (Array.isArray(parsed[k])) { arr = parsed[k]; break; }
  if (!arr || arr.length < 2) return [];
  const H = String(arr[0]).split(";").map((h) => h.trim()); const col = (...ns: string[]) => { for (const n of ns) { const i = H.findIndex((h) => h.toLowerCase() === n.toLowerCase()); if (i >= 0) return i; } return -1; };
  const iR = col("RUT cliente", "Rut cliente", "RUT Receptor"), iN = col("Razon Social"), iF = col("Folio"), iFe = col("Fecha Docto"), iT = col("Tipo Doc"), iNeto = col("Monto Neto"), iEx = col("Monto Exento"), iIva = col("Monto IVA", "Monto IVA Recuperable"), iTot = col("Monto Total");
  return arr.slice(1).map((l: any) => { const c = String(l).split(";"); return { rutContraparte: iR >= 0 ? c[iR] : null, razonSocial: iN >= 0 ? c[iN] : null, tipoDte: parseInt(c[iT], 10) || null, folio: (c[iF] || "").trim(), fechaEmision: fechaISO(c[iFe]), neto: numCLP(c[iNeto]), exento: iEx >= 0 ? numCLP(c[iEx]) : 0, iva: iIva >= 0 ? numCLP(c[iIva]) : 0, total: numCLP(c[iTot]) }; });
}
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = new URL(req.url);
    const rutContrib = (url.searchParams.get("rut") || "").trim();
    if (!rutContrib) return json({ ok: false, error: "Falta ?rut=" }, 400);
    // RUT con el que se inicia sesion (se resuelve abajo con tx_contribuyentes.login_rut).
    const loginRutParam = (url.searchParams.get("loginRut") || "").trim();
    const claveSII = Deno.env.get("CLAVE_SII"); if (!claveSII) return json({ ok: false, error: "Falta CLAVE_SII" }, 500);
    const URL_S = Deno.env.get("SUPABASE_URL")!, KEY_S = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(URL_S, KEY_S, { auth: { persistSession: false } });

    // Auth: service_role (cron) o usuario autorizado para el RUT.
    const bearer = (req.headers.get("Authorization") || "").replace("Bearer ", "").trim();
    let allowed = bearer && bearer === KEY_S;
    if (!allowed && bearer) { const { data: ures } = await admin.auth.getUser(bearer); const em = ures?.user?.email?.toLowerCase(); if (em) { const { data: link } = await admin.from("tx_usuario_rut").select("rut").eq("email", em).eq("rut", rutContrib).maybeSingle(); allowed = !!link; } }
    if (!allowed) return json({ ok: false, error: "No autorizado para este RUT" }, 403);

    // Periodos.
    const meses: string[] = [];
    const per = (url.searchParams.get("periodo") || "").replace(/\D/g, "").slice(0, 6);
    if (per) meses.push(per);
    else { const desde = (url.searchParams.get("desde") || "").replace(/\D/g, "").slice(0, 6), hasta = (url.searchParams.get("hasta") || "").replace(/\D/g, "").slice(0, 6); if (desde && hasta) { let y = +desde.slice(0, 4), m = +desde.slice(4, 6); const yh = +hasta.slice(0, 4), mh = +hasta.slice(4, 6); for (let i = 0; i < 60; i++) { meses.push("" + y + String(m).padStart(2, "0")); if (y === yh && m === mh) break; m++; if (m > 12) { m = 1; y++; } } } }
    if (!meses.length) return json({ ok: false, error: "Indica ?periodo=AAAAMM o ?desde=&hasta=" }, 400);

    const { data: contrib } = await admin.from("tx_contribuyentes").select("tramo_iepd_pct, login_rut").eq("rut", rutContrib).maybeSingle();
    const tramo = Number(contrib?.tramo_iepd_pct ?? 80);
    // RUT de login: ?loginRut= > login_rut configurado (representante) > el mismo RUT.
    const loginRut = (loginRutParam || (contrib as any)?.login_rut || rutContrib).trim();
    const { data: cats } = await admin.from("tx_categorias").select("nombre, palabras_clave").is("rut", null);
    const catsOrd = (cats || []).filter((c: any) => c.nombre !== "Otros");

    // UN solo login con clave para todo (RCV + DTE), con reintentos si el SII limita.
    const { token, jar, intentos } = await loginConReintentos(loginRut, claveSII);
    if (!token) return json({ ok: false, error: "El SII está limitando el acceso (no entregó sesión tras varios intentos). Reintenta en un minuto.", rateLimited: true }, 503);
    const debug = url.searchParams.get("debug") === "1";
    const dbgSel: any = {};
    await seleccionarEmpresa(rutContrib, jar, debug ? dbgSel : undefined).catch(() => false); // selecciona empresa = rutContrib

    const resumen: any[] = [];
    for (const periodo of meses) {
      const compras = await comprasRCV(jar, token, rutContrib, periodo);
      // Guarda: si no hay compras (p.ej. el SII limitó la sesión o el periodo
      // está vacío) no sobreescribimos un periodo ya cargado con ceros.
      if (!compras.length) { resumen.push({ periodo, compras: 0, ventas: 0, conDetalle: 0, omitido: "sin compras (no se sobreescribe)" }); continue; }
      let detalle: Record<string, any> = {};
      const dbgDet: any = {};
      // Detalle con siembra de sesion + descarga dirigida por mes de emision (rescata
      // litros aunque el DTE se haya recibido en otro mes; igual que el script viejo).
      try { detalle = await obtenerDetalle(periodo, compras, jar, debug ? dbgDet : undefined); } catch { /* sin detalle */ }

      const filas = compras.map((c) => {
        const det = detalle[c.folio] || {};
        const f = { ...c, giro: det.giro || "", items: det.items || [], litros: det.litros ?? null };
        const categoria = clasificar(f, catsOrd);
        return { rut: rutContrib, tipo: "compra", tipo_dte: c.tipoDte, folio: c.folio, rut_contraparte: c.rutContraparte, razon_social: c.razonSocial, fecha_emision: c.fechaEmision, fecha_recepcion: c.fechaRecepcion, periodo, neto: c.neto, iva: c.iva, exento: c.exento, total: c.total, iepd: c.iepd, cod_otro_impuesto: c.codOtroImp, litros: f.litros, categoria, subcategoria: det.giro || null, clasif_origen: "regla", raw: { giro: det.giro, items: det.items } };
      });
      if (filas.length) { const { error } = await admin.from("tx_facturas").upsert(filas, { onConflict: "rut,tipo,tipo_dte,folio" }); if (error) return json({ ok: false, error: "upsert tx_facturas: " + error.message, periodo }, 500); }

      // VENTAS -> ingresos del periodo.
      const ventas = await ventasRCV(jar, token, rutContrib, periodo);
      if (ventas.length) {
        const filasV = ventas.map((v) => ({ rut: rutContrib, tipo: "venta", tipo_dte: v.tipoDte, folio: v.folio, rut_contraparte: v.rutContraparte, razon_social: v.razonSocial, fecha_emision: v.fechaEmision, periodo, neto: v.neto, iva: v.iva, exento: v.exento, total: v.total, categoria: "Venta", clasif_origen: "regla" }));
        await admin.from("tx_facturas").upsert(filasV, { onConflict: "rut,tipo,tipo_dte,folio" });
      }
      const ingresos = ventas.reduce((a, x) => a + (x.neto || 0) + (x.exento || 0), 0);

      const iepdTotal = filas.reduce((a, x) => a + (x.iepd || 0), 0);
      const litrosTotal = +filas.reduce((a, x) => a + (x.litros || 0), 0).toFixed(2);
      const credito544 = Math.round(iepdTotal * tramo / 100);
      // Protección: si hay diésel (iepd>0) pero no se extrajeron litros (descarga del
      // DTE falló), NO pisar con 0 los litros ya rescatados antes.
      let litrosFinal = litrosTotal;
      if (litrosTotal === 0 && iepdTotal > 0) {
        const { data: prev } = await admin.from("tx_periodos").select("litros").eq("rut", rutContrib).eq("periodo", periodo).maybeSingle();
        const prevL = Number(prev?.litros || 0);
        if (prevL > 0) litrosFinal = prevL;
      }
      const ingresoPorLitro = litrosFinal > 0 ? +(ingresos / litrosFinal).toFixed(2) : null;
      await admin.from("tx_periodos").upsert({ rut: rutContrib, periodo, litros: litrosFinal, iepd_total: iepdTotal, credito_544: credito544, ingresos, ingreso_por_litro: ingresoPorLitro, updated_at: new Date().toISOString() }, { onConflict: "rut,periodo" });
      const porCat: Record<string, number> = {}; for (const f of filas) porCat[f.categoria] = (porCat[f.categoria] || 0) + 1;
      if (debug) { dbgDet.dieselFolios = compras.filter((c) => (c.iepd || 0) > 0).map((c) => c.folio + "@" + c.fechaEmision + "/t" + c.tipoDte); }
      resumen.push({ periodo, compras: filas.length, ventas: ventas.length, conDetalle: Object.keys(detalle).length, iepdTotal, litrosTotal, credito544, ingresos, ingresoPorLitro, porCategoria: porCat, ...(debug ? { dbg: dbgDet } : {}) });
    }
    return json({ ok: true, rut: rutContrib, loginRut, loginIntentos: intentos, via: "clave", meses: meses.length, ...(url.searchParams.get("debug") === "1" ? { dbgSel } : {}), resumen });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});
