// Tracco Tx - Edge Function tracco-compras (Deno / Supabase)
// Liviana: cert -> token -> baja el RCV de COMPRAS de un rango de meses (www4, con
// el token del certificado) y devuelve TODAS las filas (no solo diesel). Sirve para
// generar la muestra anual y disenar el clasificador de gastos, y como base de la
// ingesta a tx_facturas. No toca www1 (sin login con clave -> sin rate-limit duro).
//   ?desde=AAAAMM&hasta=AAAAMM   (default: ultimos 12 meses) ; ?rut= o secreto RUT_CONTRIBUYENTE
import forge from "npm:node-forge@1.3.1";

const C14N = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
const ENV = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";
const RSA_SHA1 = "http://www.w3.org/2000/09/xmldsig#rsa-sha1";
const SHA1 = "http://www.w3.org/2000/09/xmldsig#sha1";
const NS = "http://www.w3.org/2000/09/xmldsig#";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "content-type, authorization, apikey" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 2), { status: s, headers: { "Content-Type": "application/json; charset=utf-8", ...cors } });
const sha1b64 = (s: string) => { const md = forge.md.sha1.create(); md.update(s, "utf8"); return forge.util.encode64(md.digest().bytes()); };
const certB64 = (pem: string) => pem.replace(/-----BEGIN CERTIFICATE-----/g, "").replace(/-----END CERTIFICATE-----/g, "").replace(/\s+/g, "");
const entre = (t: string, tag: string) => { const m = t.match(new RegExp("<" + tag + ">([^<]*)</" + tag + ">", "i")); return m ? m[1].trim() : null; };
const desesc = (t: string) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const numCLP = (s: string) => parseInt(String(s || "0").replace(/\D/g, ""), 10) || 0;

async function leerCert(): Promise<string> {
  const base = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key) throw new Error("Faltan variables internas de Supabase");
  const lr = await fetch(base + "/storage/v1/object/list/certs", { method: "POST", headers: { Authorization: "Bearer " + key, apikey: key, "Content-Type": "application/json" }, body: JSON.stringify({ prefix: "", limit: 100, offset: 0 }) });
  const files = await lr.json();
  const pfx = (files || []).find((f: any) => /\.(pfx|p12)$/i.test(f.name)) || (files || [])[0];
  if (!pfx?.name) throw new Error("Bucket 'certs' vacio");
  const dr = await fetch(base + "/storage/v1/object/certs/" + encodeURIComponent(pfx.name), { headers: { Authorization: "Bearer " + key, apikey: key } });
  const buf = new Uint8Array(await dr.arrayBuffer());
  let bin = ""; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return bin;
}
function leerPfx(binary: string, clave: string) {
  const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(binary), false, clave);
  const kb = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag];
  const keyBag = (kb && kb[0]) || (p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || [])[0];
  const certBag = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag][0];
  return { privateKey: keyBag.key, certPem: forge.pki.certificateToPem(certBag.cert), cn: (certBag.cert.subject.getField("CN") || {}).value || "" };
}
function firmar(semilla: string, privateKey: any, certPem: string): string {
  const dv = sha1b64("<getToken><item><Semilla>" + semilla + "</Semilla></item></getToken>");
  const siDoc = '<SignedInfo><CanonicalizationMethod Algorithm="' + C14N + '"/><SignatureMethod Algorithm="' + RSA_SHA1 + '"/><Reference URI=""><Transforms><Transform Algorithm="' + ENV + '"/><Transform Algorithm="' + C14N + '"/></Transforms><DigestMethod Algorithm="' + SHA1 + '"/><DigestValue>' + dv + "</DigestValue></Reference></SignedInfo>";
  const siCanon = '<SignedInfo xmlns="' + NS + '"><CanonicalizationMethod Algorithm="' + C14N + '"></CanonicalizationMethod><SignatureMethod Algorithm="' + RSA_SHA1 + '"></SignatureMethod><Reference URI=""><Transforms><Transform Algorithm="' + ENV + '"></Transform><Transform Algorithm="' + C14N + '"></Transform></Transforms><DigestMethod Algorithm="' + SHA1 + '"></DigestMethod><DigestValue>' + dv + "</DigestValue></Reference></SignedInfo>";
  const md = forge.md.sha1.create(); md.update(siCanon, "utf8");
  const sv = forge.util.encode64(privateKey.sign(md));
  return '<?xml version="1.0" encoding="UTF-8"?><getToken><item><Semilla>' + semilla + "</Semilla></item><Signature xmlns=\"" + NS + "\">" + siDoc + "<SignatureValue>" + sv + "</SignatureValue><KeyInfo><X509Data><X509Certificate>" + certB64(certPem) + "</X509Certificate></X509Data></KeyInfo></Signature></getToken>";
}
async function getToken(privateKey: any, certPem: string): Promise<string> {
  const env1 = '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:def="http://DefaultNamespace"><soapenv:Header/><soapenv:Body><def:getSeed/></soapenv:Body></soapenv:Envelope>';
  const sr = await fetch("https://palena.sii.cl/DTEWS/CrSeed.jws", { method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": "" }, body: env1 });
  const semilla = entre(desesc(await sr.text()), "SEMILLA");
  if (!semilla) throw new Error("No se pudo leer SEMILLA");
  const env2 = '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:def="http://DefaultNamespace"><soapenv:Header/><soapenv:Body><def:getToken><pszXml><![CDATA[' + firmar(semilla, privateKey, certPem) + "]]></pszXml></def:getToken></soapenv:Body></soapenv:Envelope>";
  const tr = await fetch("https://palena.sii.cl/DTEWS/GetTokenFromSeed.jws", { method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": "" }, body: env2 });
  const token = entre(desesc(await tr.text()), "TOKEN");
  if (!token) throw new Error("No se pudo leer TOKEN");
  return token;
}
async function comprasPeriodo(token: string, rutCompleto: string, periodo: string): Promise<any[]> {
  const [rut, dv] = rutCompleto.split("-");
  const body = { metaData: { namespace: "cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService/getDetalleCompraExport", conversationId: token, transactionId: crypto.randomUUID(), page: null }, data: { rutEmisor: rut, dvEmisor: dv, ptributario: periodo, codTipoDoc: 0, operacion: "COMPRA", estadoContab: "REGISTRO", accionRecaptcha: "RCV_DDETC", tokenRecaptcha: "t-o-k-e-n-web" } };
  const r = await fetch("https://www4.sii.cl/consdcvinternetui/services/data/facadeService/getDetalleCompraExport", { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json, text/plain, */*", "Origin": "https://www4.sii.cl", "Referer": "https://www4.sii.cl/consdcvinternetui/", "Cookie": "TOKEN=" + token + "; CSESSIONID=" + token }, body: JSON.stringify(body) });
  if (r.status !== 200) return [];
  let parsed: any; try { parsed = JSON.parse(await r.text()); } catch { return []; }
  let arr: any[] | null = Array.isArray(parsed) ? parsed : null;
  if (!arr && parsed && typeof parsed === "object") for (const k of Object.keys(parsed)) if (Array.isArray(parsed[k])) { arr = parsed[k]; break; }
  if (!arr || arr.length < 2) return [];
  const header = String(arr[0]).split(";").map((h) => h.trim());
  const col = (n: string) => header.findIndex((h) => h.toLowerCase() === n.toLowerCase());
  const iRut = col("RUT Proveedor"), iRazon = col("Razon Social"), iFolio = col("Folio"), iFecha = col("Fecha Docto"), iTipo = col("Tipo Doc"), iTipoC = col("Tipo Compra"), iNeto = col("Monto Neto"), iExe = col("Monto Exento"), iIva = col("Monto IVA Recuperable"), iTot = col("Monto Total"), iCod = col("Codigo Otro Impuesto"), iVal = col("Valor Otro Impuesto");
  return arr.slice(1).map((l: any) => { const c = String(l).split(";"); const cod = iCod >= 0 ? (c[iCod] || "").trim() : ""; return { periodo, rutProveedor: c[iRut], razonSocial: c[iRazon], tipoDoc: c[iTipo], tipoCompra: iTipoC >= 0 ? c[iTipoC] : null, folio: c[iFolio], fecha: c[iFecha], neto: numCLP(c[iNeto]), exento: numCLP(c[iExe]), iva: numCLP(c[iIva]), total: numCLP(c[iTot]), codOtroImp: cod, iepd: cod === "28" ? numCLP(c[iVal]) : 0 }; }); }

function rangoMeses(desde: string, hasta: string): string[] {
  const out: string[] = []; let y = +desde.slice(0, 4), m = +desde.slice(4, 6); const yh = +hasta.slice(0, 4), mh = +hasta.slice(4, 6);
  for (let i = 0; i < 60; i++) { out.push("" + y + String(m).padStart(2, "0")); if (y === yh && m === mh) break; m++; if (m > 12) { m = 1; y++; } }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = new URL(req.url);
    const rutContrib = (url.searchParams.get("rut") || Deno.env.get("RUT_CONTRIBUYENTE") || "").trim();
    const clave = Deno.env.get("CERT_PASS");
    if (!clave) return json({ ok: false, error: "Falta CERT_PASS" });
    if (!rutContrib) return json({ ok: false, error: "Falta RUT (?rut= o secreto RUT_CONTRIBUYENTE)" });
    const hoy = new Date();
    const defHasta = "" + hoy.getFullYear() + String(hoy.getMonth() + 1).padStart(2, "0");
    const defDesde = "" + (hoy.getFullYear() - 1) + String(hoy.getMonth() + 1).padStart(2, "0");
    const desde = (url.searchParams.get("desde") || defDesde).replace(/\D/g, "").slice(0, 6);
    const hasta = (url.searchParams.get("hasta") || defHasta).replace(/\D/g, "").slice(0, 6);

    const { privateKey, certPem, cn } = leerPfx(await leerCert(), clave);
    const token = await getToken(privateKey, certPem);
    const meses = rangoMeses(desde, hasta);
    const compras: any[] = [];
    const resumen: any[] = [];
    for (const p of meses) {
      const filas = await comprasPeriodo(token, rutContrib, p);
      compras.push(...filas);
      resumen.push({ periodo: p, docs: filas.length, neto: filas.reduce((a, x) => a + x.neto, 0), iepd: filas.reduce((a, x) => a + x.iepd, 0) });
    }
    return json({ ok: true, titular: cn, rut: rutContrib, desde, hasta, meses: meses.length, totalDocs: compras.length, resumen, compras });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message });
  }
});
