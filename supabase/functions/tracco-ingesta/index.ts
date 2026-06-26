// Tracco Tx - Edge Function tracco-ingesta (Deno / Supabase)
// Ingesta por RUT + periodo(s): combina RCV de compras (www4, montos/IEPD) con el
// detalle del DTE (www1: GiroEmis + items + litros), CLASIFICA cada factura y la
// guarda en tx_facturas; luego recalcula tx_periodos (litros, IEPD, credito 544).
//   POST/GET ?rut=&periodo=AAAAMM   o   ?rut=&desde=AAAAMM&hasta=AAAAMM
// Auth: Bearer = access_token de usuario autorizado para el RUT, o el service_role
// (cron). Sin eso -> 403.
import forge from "npm:node-forge@1.3.1";
import { unzipSync } from "npm:fflate@0.8.2";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const C14N = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315", ENV = "http://www.w3.org/2000/09/xmldsig#enveloped-signature", RSA_SHA1 = "http://www.w3.org/2000/09/xmldsig#rsa-sha1", SHA1 = "http://www.w3.org/2000/09/xmldsig#sha1", NS = "http://www.w3.org/2000/09/xmldsig#";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "content-type, authorization, apikey" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 2), { status: s, headers: { "Content-Type": "application/json; charset=utf-8", ...cors } });
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha1b64 = (s: string) => { const md = forge.md.sha1.create(); md.update(s, "utf8"); return forge.util.encode64(md.digest().bytes()); };
const certB64 = (p: string) => p.replace(/-----BEGIN CERTIFICATE-----/g, "").replace(/-----END CERTIFICATE-----/g, "").replace(/\s+/g, "");
const entre = (t: string, tag: string) => { const m = t.match(new RegExp("<" + tag + ">([^<]*)</" + tag + ">", "i")); return m ? m[1].trim() : null; };
const desesc = (t: string) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const numCLP = (s: string) => parseInt(String(s || "0").replace(/\D/g, ""), 10) || 0;
function num(s: string): number { s = (s || "").trim(); if (s.includes(",") && s.includes(".")) s = s.replace(/\./g, "").replace(",", "."); else if (s.includes(",")) s = s.replace(",", "."); return parseFloat(s) || 0; }
function fechaISO(s: string): string | null { const m = String(s || "").match(/(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})/); if (!m) return null; return m[3] + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0"); }

class Jar { cookies = new Map<string, string>(); add(scs: string[]) { for (const sc of scs) { const f = sc.split(";")[0]; const eq = f.indexOf("="); if (eq > 0) { const n = f.slice(0, eq).trim(); const v = f.slice(eq + 1).trim(); if (v && v !== "deleted") this.cookies.set(n, v); } } } header() { return [...this.cookies.entries()].map(([k, v]) => k + "=" + v).join("; "); } }
async function fetchJar(jar: Jar, url: string, opts: RequestInit, maxRedir = 6): Promise<Response> { let cur = url; let o: RequestInit = { ...opts }; for (let i = 0; i < maxRedir; i++) { const h = new Headers(o.headers || {}); if (jar.cookies.size) h.set("Cookie", jar.header()); const r = await fetch(cur, { ...o, headers: h, redirect: "manual" }); try { const sc = (r.headers as any).getSetCookie ? (r.headers as any).getSetCookie() : []; jar.add(sc); } catch { /* */ } if (r.status >= 300 && r.status < 400) { const loc = r.headers.get("location"); if (!loc) return r; cur = new URL(loc, cur).toString(); await r.body?.cancel(); o = { method: "GET", headers: { "User-Agent": UA } }; continue; } return r; } throw new Error("redirects"); }

async function leerCert(): Promise<string> { const base = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"); const lr = await fetch(base + "/storage/v1/object/list/certs", { method: "POST", headers: { Authorization: "Bearer " + key, apikey: key!, "Content-Type": "application/json" }, body: JSON.stringify({ prefix: "", limit: 100, offset: 0 }) }); const files = await lr.json(); const pfx = (files || []).find((f: any) => /\.(pfx|p12)$/i.test(f.name)) || (files || [])[0]; if (!pfx?.name) throw new Error("Bucket 'certs' vacio"); const dr = await fetch(base + "/storage/v1/object/certs/" + encodeURIComponent(pfx.name), { headers: { Authorization: "Bearer " + key, apikey: key! } }); const buf = new Uint8Array(await dr.arrayBuffer()); let bin = ""; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]); return bin; }
function leerPfx(binary: string, clave: string) { const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(binary), false, clave); const kb = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]; const keyBag = (kb && kb[0]) || (p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || [])[0]; const certBag = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag][0]; return { privateKey: keyBag.key, certPem: forge.pki.certificateToPem(certBag.cert) }; }
function firmar(semilla: string, privateKey: any, certPem: string): string { const dv = sha1b64("<getToken><item><Semilla>" + semilla + "</Semilla></item></getToken>"); const siDoc = '<SignedInfo><CanonicalizationMethod Algorithm="' + C14N + '"/><SignatureMethod Algorithm="' + RSA_SHA1 + '"/><Reference URI=""><Transforms><Transform Algorithm="' + ENV + '"/><Transform Algorithm="' + C14N + '"/></Transforms><DigestMethod Algorithm="' + SHA1 + '"/><DigestValue>' + dv + "</DigestValue></Reference></SignedInfo>"; const siCanon = '<SignedInfo xmlns="' + NS + '"><CanonicalizationMethod Algorithm="' + C14N + '"></CanonicalizationMethod><SignatureMethod Algorithm="' + RSA_SHA1 + '"></SignatureMethod><Reference URI=""><Transforms><Transform Algorithm="' + ENV + '"></Transform><Transform Algorithm="' + C14N + '"></Transform></Transforms><DigestMethod Algorithm="' + SHA1 + '"></DigestMethod><DigestValue>' + dv + "</DigestValue></Reference></SignedInfo>"; const md = forge.md.sha1.create(); md.update(siCanon, "utf8"); const sv = forge.util.encode64(privateKey.sign(md)); return '<?xml version="1.0" encoding="UTF-8"?><getToken><item><Semilla>' + semilla + "</Semilla></item><Signature xmlns=\"" + NS + "\">" + siDoc + "<SignatureValue>" + sv + "</SignatureValue><KeyInfo><X509Data><X509Certificate>" + certB64(certPem) + "</X509Certificate></X509Data></KeyInfo></Signature></getToken>"; }
async function getToken(privateKey: any, certPem: string): Promise<string> { const e1 = '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:def="http://DefaultNamespace"><soapenv:Header/><soapenv:Body><def:getSeed/></soapenv:Body></soapenv:Envelope>'; const sr = await fetch("https://palena.sii.cl/DTEWS/CrSeed.jws", { method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": "" }, body: e1 }); const semilla = entre(desesc(await sr.text()), "SEMILLA"); if (!semilla) throw new Error("sin SEMILLA"); const e2 = '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:def="http://DefaultNamespace"><soapenv:Header/><soapenv:Body><def:getToken><pszXml><![CDATA[' + firmar(semilla, privateKey, certPem) + "]]></pszXml></def:getToken></soapenv:Body></soapenv:Envelope>"; const tr = await fetch("https://palena.sii.cl/DTEWS/GetTokenFromSeed.jws", { method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": "" }, body: e2 }); const token = entre(desesc(await tr.text()), "TOKEN"); if (!token) throw new Error("sin TOKEN"); return token; }

// RCV compras del periodo (todas las filas).
async function comprasRCV(token: string, rutCompleto: string, periodo: string): Promise<any[]> {
  const [rut, dv] = rutCompleto.split("-");
  const body = { metaData: { namespace: "cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService/getDetalleCompraExport", conversationId: token, transactionId: crypto.randomUUID(), page: null }, data: { rutEmisor: rut, dvEmisor: dv, ptributario: periodo, codTipoDoc: 0, operacion: "COMPRA", estadoContab: "REGISTRO", accionRecaptcha: "RCV_DDETC", tokenRecaptcha: "t-o-k-e-n-web" } };
  const r = await fetch("https://www4.sii.cl/consdcvinternetui/services/data/facadeService/getDetalleCompraExport", { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json, text/plain, */*", "Origin": "https://www4.sii.cl", "Referer": "https://www4.sii.cl/consdcvinternetui/", "Cookie": "TOKEN=" + token + "; CSESSIONID=" + token }, body: JSON.stringify(body) });
  if (r.status !== 200) return [];
  let parsed: any; try { parsed = JSON.parse(await r.text()); } catch { return []; }
  let arr: any[] | null = Array.isArray(parsed) ? parsed : null;
  if (!arr && parsed && typeof parsed === "object") for (const k of Object.keys(parsed)) if (Array.isArray(parsed[k])) { arr = parsed[k]; break; }
  if (!arr || arr.length < 2) return [];
  const H = String(arr[0]).split(";").map((h) => h.trim()); const col = (n: string) => H.findIndex((h) => h.toLowerCase() === n.toLowerCase());
  const iR = col("RUT Proveedor"), iN = col("Razon Social"), iF = col("Folio"), iFe = col("Fecha Docto"), iFr = col("Fecha Recepcion"), iT = col("Tipo Doc"), iNeto = col("Monto Neto"), iEx = col("Monto Exento"), iIva = col("Monto IVA Recuperable"), iTot = col("Monto Total"), iCod = col("Codigo Otro Impuesto"), iVal = col("Valor Otro Impuesto");
  return arr.slice(1).map((l: any) => { const c = String(l).split(";"); const cod = iCod >= 0 ? (c[iCod] || "").trim() : ""; return { rutContraparte: c[iR], razonSocial: c[iN], tipoDte: parseInt(c[iT], 10) || null, folio: (c[iF] || "").trim(), fechaEmision: fechaISO(c[iFe]), fechaRecepcion: fechaISO(c[iFr]), neto: numCLP(c[iNeto]), exento: numCLP(c[iEx]), iva: numCLP(c[iIva]), total: numCLP(c[iTot]), codOtroImp: cod ? parseInt(cod, 10) : null, iepd: cod === "28" ? numCLP(c[iVal]) : 0 }; }); }

// Detalle del DTE: folio -> { litros, giro, items[] }. Lee del respaldo XML de www1.
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
async function descargarDte(jar: Jar, url: string, map: Record<string, any>) {
  const r = await fetchJar(jar, url, { method: "GET", headers: { "User-Agent": UA } });
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) { try { const files = unzipSync(buf); for (const n of Object.keys(files)) if (/\.xml$/i.test(n)) parseDte(new TextDecoder().decode(files[n]), map); } catch { /* */ } return; }
  const txt = new TextDecoder("iso-8859-1").decode(buf);
  if (!/Error al contribuyente|no ha seleccionado/i.test(txt)) parseDte(txt, map);
}
async function loginClave(rutCompleto: string, clave: string, jar: Jar) { const [rut, dv] = rutCompleto.split("-"); const body = new URLSearchParams({ rut, dv, referencia: "https://www1.sii.cl/cgi-bin/Portal001/mipeAdminDocsRcp.cgi", "411": "", rutcntr: rutCompleto, clave }).toString(); await fetchJar(jar, "https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA, "Origin": "https://zeusr.sii.cl", "Referer": "https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi" }, body }); }
async function seleccionarEmpresa(rutCompleto: string, jar: Jar) {
  const selUrl = "https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi?DESDE_DONDE_URL=OPCION%3D1%26TIPO%3D4";
  const r = await fetchJar(jar, selUrl, { method: "GET", headers: { "User-Agent": UA, "Referer": "https://www1.sii.cl/Portal001/menuFacturaElectronica.html" } });
  const html = new TextDecoder("iso-8859-1").decode(new Uint8Array(await r.arrayBuffer()));
  const form = html.match(/<form[^>]*>[\s\S]*?<\/form>/i); if (!form) return;
  const action = (form[0].match(/action=["']?([^"'\s>]+)/i) || [])[1] || "mipeSelEmpresa.cgi";
  const actionUrl = new URL(action.replace(/&amp;/g, "&"), "https://www1.sii.cl/cgi-bin/Portal001/").toString();
  const params = new URLSearchParams();
  for (const h of form[0].matchAll(/<input[^>]*>/gi)) { const tag = h[0]; if (!/type=["']?hidden/i.test(tag) && !/type=["']?submit/i.test(tag) && /type=/i.test(tag)) continue; const n = (tag.match(/name=["']?([^"'\s>]+)/i) || [])[1]; const v = (tag.match(/value=["']?([^"'>]*)/i) || [])[1] || ""; if (n) params.set(n, v.replace(/&amp;/g, "&")); }
  const rutNum = rutCompleto.split("-")[0].replace(/\D/g, ""); const rutDot = rutNum.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const sel = form[0].match(/<select[^>]*name=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/select>/i);
  if (sel) { let chosen = "", first = ""; for (const o of sel[2].matchAll(/<option[^>]*value=["']?([^"'>]*)["']?[^>]*>([^<]*)</gi)) { const val = (o[1] || "").trim(), lab = (o[2] || "").trim(); if (!first) first = val; if (val.includes(rutCompleto) || val.includes(rutNum) || lab.includes(rutNum) || lab.includes(rutDot)) { chosen = val; break; } } params.set(sel[1], chosen || first); }
  const pr = await fetchJar(jar, actionUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA, "Origin": "https://www1.sii.cl", "Referer": selUrl }, body: params.toString() }); await pr.body?.cancel();
}
// Detalle DTE de un periodo: selecciona empresa, baja respaldo masivo + por (mes,tpo) de las facturas.
async function detalleDte(rutCompleto: string, periodo: string, tposDoc: number[], jar: Jar): Promise<Record<string, any>> {
  const y = periodo.slice(0, 4), m = periodo.slice(4, 6); const last = String(new Date(+y, +m, 0).getDate()).padStart(2, "0");
  const desde = y + "-" + m + "-01", hasta = y + "-" + m + "-" + last;
  const map: Record<string, any> = {};
  await seleccionarEmpresa(rutCompleto, jar);
  const dl = (tpo: string) => "https://www1.sii.cl/cgi-bin/Portal001/mipeDownLoad.cgi?ORIGEN=RCP&RUT_EMI=&FOLIO=&RZN_SOC=&FEC_DESDE=" + desde + "&FEC_HASTA=" + hasta + "&TPO_DOC=" + tpo + "&ESTADO=&ORDEN=&DOWNLOAD=XML";
  await descargarDte(jar, dl(""), map); // masivo
  for (const t of tposDoc) { if (!t) continue; await sleep(700); await descargarDte(jar, dl(String(t)), map); }
  return map;
}

function clasificar(f: any, cats: { nombre: string; palabras_clave: string[] }[]): string {
  if (f.iepd > 0) return "Combustible";
  const hay = ((f.razonSocial || "") + " | " + (f.giro || "") + " | " + (f.items || []).join(" ")).toUpperCase();
  for (const c of cats) { if ((c.palabras_clave || []).some((k) => k && hay.includes(k.toUpperCase()))) return c.nombre; }
  return "Otros";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = new URL(req.url);
    const rutContrib = (url.searchParams.get("rut") || "").trim();
    if (!rutContrib) return json({ ok: false, error: "Falta ?rut=" }, 400);
    const clave = Deno.env.get("CERT_PASS"); if (!clave) return json({ ok: false, error: "Falta CERT_PASS" }, 500);
    const URL_S = Deno.env.get("SUPABASE_URL")!, KEY_S = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(URL_S, KEY_S, { auth: { persistSession: false } });

    // Auth: service_role (cron) o usuario autorizado para el RUT.
    const bearer = (req.headers.get("Authorization") || "").replace("Bearer ", "").trim();
    let allowed = bearer && bearer === KEY_S;
    if (!allowed && bearer) { const { data: ures } = await admin.auth.getUser(bearer); const em = ures?.user?.email?.toLowerCase(); if (em) { const { data: link } = await admin.from("tx_usuario_rut").select("rut").eq("email", em).eq("rut", rutContrib).maybeSingle(); allowed = !!link; } }
    if (!allowed) return json({ ok: false, error: "No autorizado para este RUT" }, 403);

    // Periodos a procesar.
    const meses: string[] = [];
    const per = (url.searchParams.get("periodo") || "").replace(/\D/g, "").slice(0, 6);
    if (per) meses.push(per);
    else { const desde = (url.searchParams.get("desde") || "").replace(/\D/g, "").slice(0, 6), hasta = (url.searchParams.get("hasta") || "").replace(/\D/g, "").slice(0, 6); if (desde && hasta) { let y = +desde.slice(0, 4), m = +desde.slice(4, 6); const yh = +hasta.slice(0, 4), mh = +hasta.slice(4, 6); for (let i = 0; i < 60; i++) { meses.push("" + y + String(m).padStart(2, "0")); if (y === yh && m === mh) break; m++; if (m > 12) { m = 1; y++; } } } }
    if (!meses.length) return json({ ok: false, error: "Indica ?periodo=AAAAMM o ?desde=&hasta=" }, 400);

    const { data: contrib } = await admin.from("tx_contribuyentes").select("tramo_iepd_pct").eq("rut", rutContrib).maybeSingle();
    const tramo = Number(contrib?.tramo_iepd_pct ?? 80);
    const { data: cats } = await admin.from("tx_categorias").select("nombre, palabras_clave").is("rut", null);
    const catsOrd = (cats || []).filter((c: any) => c.nombre !== "Otros");

    const { privateKey, certPem } = leerPfx(await leerCert(), clave);
    const token = await getToken(privateKey, certPem);
    const claveSII = Deno.env.get("CLAVE_SII");

    const resumen: any[] = [];
    for (const periodo of meses) {
      const compras = await comprasRCV(token, rutContrib, periodo);
      // Detalle DTE (giro + items + litros) si hay clave SII.
      let detalle: Record<string, any> = {};
      if (claveSII && compras.length) { try { const jar = new Jar(); await loginClave(rutContrib, claveSII, jar); const tpos = [...new Set(compras.map((c) => c.tipoDte).filter(Boolean))] as number[]; detalle = await detalleDte(rutContrib, periodo, tpos, jar); } catch { /* sigue sin detalle */ } }

      const filas = compras.map((c) => {
        const det = detalle[c.folio] || {};
        const f = { ...c, giro: det.giro || "", items: det.items || [], litros: det.litros ?? null };
        const categoria = clasificar(f, catsOrd);
        return { rut: rutContrib, tipo: "compra", tipo_dte: c.tipoDte, folio: c.folio, rut_contraparte: c.rutContraparte, razon_social: c.razonSocial, fecha_emision: c.fechaEmision, fecha_recepcion: c.fechaRecepcion, periodo, neto: c.neto, iva: c.iva, exento: c.exento, total: c.total, iepd: c.iepd, cod_otro_impuesto: c.codOtroImp, litros: f.litros, categoria, subcategoria: det.giro || null, clasif_origen: "regla", raw: { giro: det.giro, items: det.items } };
      });
      if (filas.length) { const { error } = await admin.from("tx_facturas").upsert(filas, { onConflict: "rut,tipo,tipo_dte,folio" }); if (error) return json({ ok: false, error: "upsert tx_facturas: " + error.message, periodo }, 500); }

      // Recalcular periodo.
      const iepdTotal = filas.reduce((a, x) => a + (x.iepd || 0), 0);
      const litrosTotal = +filas.reduce((a, x) => a + (x.litros || 0), 0).toFixed(2);
      const credito544 = Math.round(iepdTotal * tramo / 100);
      await admin.from("tx_periodos").upsert({ rut: rutContrib, periodo, litros: litrosTotal, iepd_total: iepdTotal, credito_544: credito544, updated_at: new Date().toISOString() }, { onConflict: "rut,periodo" });
      const porCat: Record<string, number> = {}; for (const f of filas) porCat[f.categoria] = (porCat[f.categoria] || 0) + 1;
      resumen.push({ periodo, facturas: filas.length, conDetalle: Object.keys(detalle).length, iepdTotal, litrosTotal, credito544, porCategoria: porCat });
    }
    return json({ ok: true, rut: rutContrib, meses: meses.length, resumen });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});
