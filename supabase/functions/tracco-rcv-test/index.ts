// PRUEBA: ¿se puede leer el RCV (www4) usando SOLO el token de la sesion de CLAVE
// (sin certificado)? Login CAutInicio -> TOKEN/CSESSIONID -> getDetalleCompraExport.
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
const json = (o: unknown) => new Response(JSON.stringify(o, null, 2), { headers: { "Content-Type": "application/json", ...cors } });
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
class Jar { c = new Map<string,string>(); add(s:string[]){for(const x of s){const f=x.split(";")[0];const e=f.indexOf("=");if(e>0){const n=f.slice(0,e).trim(),v=f.slice(e+1).trim();if(v&&v!=="deleted")this.c.set(n,v);}}} h(){return [...this.c.entries()].map(([k,v])=>k+"="+v).join("; ");} }
async function fj(jar:Jar,url:string,o:RequestInit,mx=6):Promise<Response>{let cur=url;let op:RequestInit={...o};for(let i=0;i<mx;i++){const h=new Headers(op.headers||{});if(jar.c.size)h.set("Cookie",jar.h());const r=await fetch(cur,{...op,headers:h,redirect:"manual"});try{const sc=(r.headers as any).getSetCookie?(r.headers as any).getSetCookie():[];jar.add(sc);}catch{}if(r.status>=300&&r.status<400){const loc=r.headers.get("location");if(!loc)return r;cur=new URL(loc,cur).toString();await r.body?.cancel();op={method:"GET",headers:{"User-Agent":UA}};continue;}return r;}throw new Error("redir");}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const rut = (url.searchParams.get("rut") || "10514666-3").trim();
  const periodo = (url.searchParams.get("periodo") || "202501").replace(/\D/g,"").slice(0,6);
  const clave = Deno.env.get("CLAVE_SII");
  if (!clave) return json({ ok:false, error:"Falta CLAVE_SII" });
  const [r0, dv] = rut.split("-");
  const jar = new Jar();
  // login clave
  const body = new URLSearchParams({ rut:r0, dv, referencia:"https://www1.sii.cl/cgi-bin/Portal001/mipeAdminDocsRcp.cgi","411":"", rutcntr:rut, clave }).toString();
  await fj(jar,"https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","User-Agent":UA,"Origin":"https://zeusr.sii.cl","Referer":"https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi"},body});
  const TOKEN = jar.c.get("TOKEN") || "";
  const cookies = [...jar.c.keys()];
  // intento RCV con el token de la sesion de clave
  const reqBody = { metaData:{ namespace:"cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService/getDetalleCompraExport", conversationId: TOKEN, transactionId: crypto.randomUUID(), page:null }, data:{ rutEmisor:r0, dvEmisor:dv, ptributario:periodo, codTipoDoc:0, operacion:"COMPRA", estadoContab:"REGISTRO", accionRecaptcha:"RCV_DDETC", tokenRecaptcha:"t-o-k-e-n-web" } };
  const r = await fetch("https://www4.sii.cl/consdcvinternetui/services/data/facadeService/getDetalleCompraExport",{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json, text/plain, */*","Origin":"https://www4.sii.cl","Referer":"https://www4.sii.cl/consdcvinternetui/","Cookie": jar.h()},body:JSON.stringify(reqBody)});
  const txt = await r.text();
  let filas = -1; try { const p = JSON.parse(txt); const arr = Array.isArray(p)?p:(p?.data||null); filas = Array.isArray(arr)? arr.length-1 : -1; } catch {}
  return json({ ok:true, rut, periodo, tieneTOKEN: !!TOKEN, cookies, www4_status: r.status, filas, inicio: txt.slice(0,200).replace(/\s+/g," ") });
});
