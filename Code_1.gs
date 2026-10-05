/**
 * COTIZADOR — Servidor (Google Apps Script + Google Sheets)
 * ---------------------------------------------------------
 * Guarda los datos compartidos del cotizador en la hoja "Cotizador - Base de datos".
 * Acceso libre: no pide usuario ni contraseña. Cualquiera con el enlace de la app puede trabajar.
 * Instalación: abre la hoja → Extensiones → Apps Script → pega este archivo → Implementar →
 * Nueva implementación → Aplicación web → Ejecutar como: Yo · Acceso: Cualquier usuario.
 * Copia la URL que termina en /exec: esa es la dirección del servidor.
 */
const SHEET_ID = '1TmAVJI_eCoM8JkgvA6iz2tPSwxwVNohASNTCkukKKkE'; // respaldo si el script no está vinculado a la hoja
const CHUNK = 45000; // una celda admite 50.000 caracteres

const SHEETS = {
  clientes:     ['id','rif','nombre','contacto','telefono','email','direccion','condicion'],
  productos:    ['id','codigo','descripcion','categoria','unidad','precio','ivaTipo'],
  cotizaciones: ['id','numero','fecha','vence','clienteRif','clienteNombre','total','totalBs','tasa','estado','usuario','usuarioId','creado','modificado','json']
};
const NUMERIC = { precio:1, total:1, totalBs:1, tasa:1 };

/* ---------------- Entrada ---------------- */
function doGet(e){
  const p = (e && e.parameter) || {};
  if(!p.action) return ContentService.createTextOutput('Servidor del cotizador activo.');
  return handle(p);
}
function doPost(e){
  let p;
  try{ p = JSON.parse(e.postData.contents); }catch(err){ return out({ ok:false, error:'Solicitud inválida' }); }
  return handle(p);
}
function out(o){ return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function handle(p){
  try{
    const a = p.action;
    const u = { id:String(p.device || ''), nombre:String(p.vendedor || 'Vendedor').slice(0, 80), rol:'admin' };
    switch(a){
      case 'ping':    return out({ ok:true });
      case 'all':     { const rev = getRev(); if(p.rev && p.rev === rev) return out({ ok:true, same:true, rev:rev }); return out({ ok:true, rev:rev, data:all() }); }
      case 'init':    return out(withLock(() => init(p.config, p.logo)));
      case 'put':     return out(withLock(() => put(u, p.col, p.rec, p.nuevo)));
      case 'del':     return out(withLock(() => del(u, p.col, p.id)));
      case 'bulk':    return out(withLock(() => bulk(u, p.col, p.recs)));
      case 'config':  return out(withLock(() => setConfig(u, p.config, p.logo)));
      case 'tasa':    return out(withLock(() => setTasa(u, p.tasa)));
      case 'restore': return out(withLock(() => restore(u, p.data)));
    }
    return out({ ok:false, error:'Acción desconocida: ' + a });
  }catch(err){
    return out({ ok:false, error: String(err && err.message || err) });
  }
}
function withLock(fn){
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try{ const r = fn(); bumpRev(); return r; } finally { lock.releaseLock(); }
}
/* Versión de los datos: permite que los teléfonos solo descarguen cuando algo cambió */
function getRev(){ return PropertiesService.getScriptProperties().getProperty('rev') || '0'; }
function bumpRev(){ PropertiesService.getScriptProperties().setProperty('rev', Date.now().toString(36) + Math.random().toString(36).slice(2, 6)); }

/* ---------------- Primer uso ---------------- */
function init(cfg, logo){
  const cur = getConfig(false);
  if(cur && cur.empresa && cur.empresa.nombre) return { ok:true, config:getConfig(true), created:false };
  cfg = JSON.parse(JSON.stringify(cfg || {}));
  if(cfg.empresa) delete cfg.empresa.logo;
  saveConfigRow('config', JSON.stringify(Object.assign({}, cur, cfg)));
  if(logo) saveConfigRow('logo', String(logo));
  return { ok:true, config:getConfig(true), created:true };
}

/* ---------------- Datos ---------------- */
function all(){
  return {
    config: getConfig(true),
    clientes: rows('clientes'),
    productos: rows('productos'),
    cotizaciones: rows('cotizaciones')
  };
}
function isAdmin(u){ return u.rol === 'admin'; }
function need(cond, msg){ if(!cond) throw new Error(msg || 'No tienes permiso para esta acción'); }

function put(u, col, rec, nuevo){
  need(SHEETS[col], 'Colección inválida');
  need(rec && typeof rec === 'object', 'Datos inválidos');
  rec = JSON.parse(JSON.stringify(rec));
  if(col === 'productos') need(isAdmin(u), 'Solo el administrador modifica productos');
  need(col !== 'usuarios', 'Colección inválida');
  if(col === 'cotizaciones'){
    if(nuevo || !rec.id){
      const cfg = getConfig(false);
      let n = Number(cfg.siguiente) || 1;
      const usados = {}; rows('cotizaciones').forEach(q => usados[q.numero] = 1);
      while(usados[numero(cfg, n)]) n++;
      rec.id = newId(); rec.numero = numero(cfg, n); rec.creado = new Date().toISOString();
      rec.usuario = rec.usuario || u.nombre; rec.usuarioId = u.id;
      cfg.siguiente = n + 1; saveConfigRow('config', JSON.stringify(cfg));
    } else {
      const ex = rows('cotizaciones').find(x => x.id === rec.id);
      need(ex, 'La cotización ya no existe');
      rec.numero = ex.numero; rec.creado = ex.creado; rec.usuarioId = ex.usuarioId;
      rec.modificado = new Date().toISOString();
    }
    const c = rec.cliente || {};
    rec.clienteRif = c.rif || ''; rec.clienteNombre = c.nombre || '';
  }
  if(col === 'clientes'){
    need(rec.nombre, 'El cliente necesita un nombre');
    rec.rif = String(rec.rif || '').toUpperCase();
    if(rec.rif) need(!rows('clientes').some(x => String(x.rif).toUpperCase() === rec.rif && x.id !== rec.id), 'Ya existe un cliente con ese RIF');
  }
  if(col === 'productos'){
    need(rec.codigo, 'El producto necesita un código');
    need(!rows('productos').some(x => String(x.codigo).toLowerCase() === String(rec.codigo).toLowerCase() && x.id !== rec.id), 'Ya existe un producto con ese código');
  }
  if(!rec.id) rec.id = newId();
  upsert(col, rec);
  return { ok:true, rec:rec };
}
function del(u, col, id){
  need(SHEETS[col], 'Colección inválida');
  if(col === 'cotizaciones'){
    // sin restricciones: acceso libre
  } else {
    need(col !== 'usuarios', 'Colección inválida');
  }
  removeRow(col, id);
  return { ok:true };
}
function bulk(u, col, recs){
  need(col === 'clientes' || col === 'productos', 'Importación no permitida');
  if(col === 'productos') need(isAdmin(u), 'Solo el administrador importa productos');
  need(Array.isArray(recs), 'Datos inválidos');
  const list = rows(col), key = col === 'productos' ? 'codigo' : 'rif';
  const idx = {}; list.forEach((x,i) => idx[String(x[key]).toUpperCase()] = i);
  let nuevos = 0, act = 0;
  recs.forEach(r => {
    const k = String(r[key] || '').trim().toUpperCase();
    if(col === 'clientes'){ r.rif = k; if(!r.nombre && !k) return; }
    if(col === 'productos' && !k) return;
    if(k && idx[k] !== undefined){ const i = idx[k]; list[i] = Object.assign({}, list[i], r, { id:list[i].id }); act++; }
    else { const o = Object.assign({}, r, { id:newId() }); list.push(o); if(k) idx[k] = list.length - 1; nuevos++; }
  });
  writeAll(col, list);
  return { ok:true, nuevos:nuevos, actualizados:act, data:rows(col) };
}
function setConfig(u, cfg, logo){
  need(isAdmin(u), 'Solo el administrador cambia la configuración');
  if(cfg){
    const cur = getConfig(false);
    cfg = Object.assign({}, cur, cfg);
    if(cfg.empresa) delete cfg.empresa.logo;
    saveConfigRow('config', JSON.stringify(cfg));
  }
  if(logo !== undefined && logo !== null) saveConfigRow('logo', String(logo));
  return { ok:true, config:getConfig(true) };
}
function setTasa(u, tasa){
  const v = Number(tasa && tasa.valor);
  need(v > 0, 'Tasa inválida');
  const cfg = getConfig(false);
  cfg.tasa = { valor:v, fecha:String(tasa.fecha || ''), fuente:String(tasa.fuente || u.nombre) };
  saveConfigRow('config', JSON.stringify(cfg));
  return { ok:true, tasa:cfg.tasa };
}
function restore(u, d){
  need(isAdmin(u), 'Solo el administrador restaura respaldos');
  need(d && typeof d === 'object', 'Respaldo inválido');
  ['clientes','productos','cotizaciones'].forEach(col => {
    const list = (d[col] || []).map(r => {
      const o = JSON.parse(JSON.stringify(r)); if(!o.id) o.id = newId();
      if(col === 'cotizaciones'){ const c = o.cliente || {}; o.clienteRif = c.rif || ''; o.clienteNombre = c.nombre || ''; }
      return o;
    });
    writeAll(col, list);
  });
  if(d.config){
    const cfg = JSON.parse(JSON.stringify(d.config));
    const logo = cfg.empresa && cfg.empresa.logo; if(cfg.empresa) delete cfg.empresa.logo;
    saveConfigRow('config', JSON.stringify(cfg));
    saveConfigRow('logo', logo || '');
  }
  return { ok:true, data:all() };
}

/* ---------------- Configuración ---------------- */
function getConfig(withLogo){
  const s = sheet('config'), n = s.getLastRow();
  const map = {};
  if(n >= 1){
    const w = Math.max(2, s.getLastColumn());
    s.getRange(1, 1, n, w).getValues().forEach(r => { if(r[0]) map[r[0]] = r.slice(1).join(''); });
  }
  let cfg = {};
  try{ cfg = map.config ? JSON.parse(map.config) : {}; }catch(e){ cfg = {}; }
  if(withLogo){ cfg.empresa = cfg.empresa || {}; cfg.empresa.logo = map.logo || ''; }
  return cfg;
}
function publicEmpresa(){
  const c = getConfig(true), e = c.empresa || {};
  return { nombre:e.nombre || '', logo:e.logo || '', color:e.color || '' };
}
function saveConfigRow(key, str){
  const s = sheet('config'), n = s.getLastRow();
  let r = 0;
  if(n >= 1){ const keys = s.getRange(1, 1, n, 1).getValues(); for(let i = 0; i < keys.length; i++) if(keys[i][0] === key){ r = i + 1; break; } }
  if(!r) r = n + 1;
  const row = [key].concat(chunks(str));
  const lc = s.getLastColumn();
  if(lc > row.length) s.getRange(r, row.length + 1, 1, lc - row.length).clearContent();
  const rg = s.getRange(r, 1, 1, row.length); rg.setNumberFormat('@'); rg.setValues([row]);
}
function numero(cfg, n){ return String(cfg.prefijo == null ? 'COT-' : cfg.prefijo) + String(n).padStart(Number(cfg.digitos) || 5, '0'); }

/* ---------------- Hoja de cálculo ---------------- */
function book(){
  let ss = null;
  try{ ss = SpreadsheetApp.getActiveSpreadsheet(); }catch(e){}
  return ss || SpreadsheetApp.openById(SHEET_ID);
}
function sheet(name){
  const ss = book();
  let s = ss.getSheetByName(name);
  if(!s){
    s = ss.insertSheet(name);
    if(SHEETS[name]){
      s.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]).setFontWeight('bold');
      s.setFrozenRows(1);
    }
  }
  return s;
}
function rows(name){
  const s = sheet(name), cols = SHEETS[name], n = s.getLastRow() - 1;
  if(n < 1) return [];
  const w = Math.max(s.getLastColumn(), cols.length);
  return s.getRange(2, 1, n, w).getValues().filter(r => r[0] !== '' && r[0] !== null).map(r => toObj(name, r));
}
function toObj(name, r){
  const cols = SHEETS[name], o = {};
  cols.forEach((c, i) => { if(c !== 'json') o[c] = norm(c, r[i]); });
  const ji = cols.indexOf('json');
  if(ji >= 0){
    const str = r.slice(ji).join('');
    if(str){ try{ const j = JSON.parse(str); Object.keys(j).forEach(k => o[k] = j[k]); }catch(e){} }
  }
  o.id = String(o.id);
  return o;
}
function norm(c, v){
  if(v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  if(NUMERIC[c]){ if(typeof v === 'number') return v; let t = String(v || '').trim(); if(t.indexOf(',') >= 0 && t.indexOf('.') >= 0) t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g,'').replace(',', '.') : t.replace(/,/g,''); else t = t.replace(',', '.'); const n = Number(t); return isNaN(n) ? 0 : n; }
  return v === null || v === undefined ? '' : String(v);
}
function toRow(name, o){
  const cols = SHEETS[name], row = [];
  cols.forEach(c => { if(c !== 'json') row.push(o[c] === undefined || o[c] === null ? '' : (typeof o[c] === 'object' ? JSON.stringify(o[c]) : o[c])); });
  if(cols.indexOf('json') >= 0) chunks(JSON.stringify(o)).forEach(x => row.push(x));
  return row;
}
function chunks(str){ const a = []; str = String(str || ''); for(let i = 0; i < str.length; i += CHUNK) a.push(str.slice(i, i + CHUNK)); if(!a.length) a.push(''); return a; }
function idList(s){ const n = s.getLastRow() - 1; return n < 1 ? [] : s.getRange(2, 1, n, 1).getValues().map(r => String(r[0])); }
function upsert(name, o){
  const s = sheet(name), ids = idList(s), row = toRow(name, o);
  const i = ids.indexOf(String(o.id)), r = i >= 0 ? i + 2 : s.getLastRow() + 1;
  const lc = s.getLastColumn();
  if(i >= 0 && lc > row.length) s.getRange(r, row.length + 1, 1, lc - row.length).clearContent();
  const rg = s.getRange(r, 1, 1, row.length); rg.setNumberFormat('@'); rg.setValues([row]);
}
function removeRow(name, id){
  const s = sheet(name), i = idList(s).indexOf(String(id));
  if(i >= 0) s.deleteRow(i + 2);
}
function writeAll(name, list){
  const s = sheet(name), n = s.getLastRow() - 1;
  if(n > 0) s.getRange(2, 1, n, Math.max(1, s.getLastColumn())).clearContent();
  if(!list.length) return;
  const data = list.map(o => toRow(name, o));
  const w = Math.max.apply(null, data.map(r => r.length));
  data.forEach(r => { while(r.length < w) r.push(''); });
  const rg = s.getRange(2, 1, data.length, w); rg.setNumberFormat('@'); rg.setValues(data);
}
function newId(){ return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
