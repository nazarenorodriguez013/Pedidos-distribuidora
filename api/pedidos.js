// API de la app de pedidos: productos (precio, promos, activo) y pedidos.
// Guarda todo en Postgres (tabla kv) si hay base; si no, en data/pedidos.json.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

let webpush = null; try { webpush = require('web-push'); } catch {}   // notificaciones push (si la librería no está, la app funciona igual sin ellas)
const FILE = process.env.PEDIDOS_FILE || path.join(__dirname, '..', 'data', 'pedidos.json');
let state = null;
let queue = Promise.resolve();

async function load(pool) {
  if (state) return state;
  if (pool) {
    await pool.query('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value JSONB NOT NULL)');
    const r = await pool.query("SELECT value FROM kv WHERE key='pedidos'");
    state = r.rows[0] ? r.rows[0].value : null;
  } else if (fs.existsSync(FILE)) state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  state = state || { seq: { p: 1, o: 1 }, productos: [], pedidos: [] };
  state.seq.u = state.seq.u || 1;
  state.usuarios = state.usuarios || [];
  state.clientes = state.clientes || [];
  state.seq.c = state.seq.c || 1;
  state.combos = state.combos || [];
  state.novedades = state.novedades || [];
  state.pushSubs = state.pushSubs || [];
  if (webpush) {   // claves VAPID: de las variables de entorno o generadas una vez y guardadas junto con los datos
    const env = process.env;
    if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) state.vapid = { publica: env.VAPID_PUBLIC_KEY, privada: env.VAPID_PRIVATE_KEY };
    else if (!state.vapid) { const k = webpush.generateVAPIDKeys(); state.vapid = { publica: k.publicKey, privada: k.privateKey }; state.vapidNueva = true; }
    webpush.setVapidDetails(env.VAPID_SUBJECT || 'mailto:admin@distribuidora.local', state.vapid.publica, state.vapid.privada);
  }
  state.seq.n = state.seq.n || 1;
  for (const c of state.combos) for (const g of c.grupos) if (!g.codigos) g.codigos = g.pids.map(pid => (state.productos.find(p => p.id === pid) || {}).codigo).filter(Boolean);
  state.seq.k = state.seq.k || 1;
  for (const c of state.combos) if (c.tipo === 'precio' && !c.precios) { c.precios = {}; for (const g of c.grupos) for (const pid of g.pids) c.precios[pid] = c.precio; delete c.precio; }
  for (const o of state.pedidos) if (o.clienteId && o.clienteCodigo === undefined) { const c = state.clientes.find(x => x.id === o.clienteId); if (c) o.clienteCodigo = c.codigo; }
  for (const c of state.clientes) if (c.apellido) { c.nombre = [c.nombre, c.apellido].filter(Boolean).join(' '); c.apellido = ''; }   // un solo campo: nombre y apellido
  for (const p of state.productos) { delete p.stock; if (p.multiplo > 1 && p.multiploSet === undefined) p.multiploSet = true; }   // ya no se maneja stock
  for (const o of state.pedidos) if (o.subtotal === undefined) {   // pedidos anteriores al redondeo: se les aplica solo
    o.subtotal = o.total; o.total = redondear(o.subtotal); o.redondeo = Math.round((o.total - o.subtotal) * 100) / 100;
  }
  if (state.vapidNueva) { delete state.vapidNueva; await save(pool); }
  if (!state.usuarios.length) {   // primer arranque: el administrador sale de APP_USER / APP_PASS
    state.usuarios.push({ id: state.seq.u++, usuario: process.env.APP_USER || 'kevin', nombre: 'Administrador', rol: 'admin', activo: true, ...hashPass(process.env.APP_PASS || 'kevin123') });
    await save(pool);
  }
  return state;
}
// Los pedidos pendientes siguen los precios y promos vigentes; al cargarlos (estado 'cargado') quedan con el precio de ese momento.
// Promo combinada = pack: solo las unidades que completan packs llevan el precio de la promo; el resto va a precio normal.
/* Grupo con límite de variedades (g.maxVar): cada pack de g.cant unidades usa como mucho maxVar productos distintos del grupo.
   Se arman los packs de a uno: arranca con la variedad que más hay y completa con la que mejor calza; devuelve cuántos packs salen y cuántas unidades de cada producto entran. */
function repartoMax(g, cant, maxPacks) {
  const q = new Map(g.pids.filter(pid => (cant.get(pid) || 0) > 0).map(pid => [pid, cant.get(pid)])), alloc = new Map();
  let packs = 0;
  while (packs < maxPacks) {
    let need = g.cant; const usado = [];
    while (need > 0 && usado.length < g.maxVar) {
      const a = [...q.entries()].filter(([pid, v]) => v > 0 && !usado.some(x => x[0] === pid)); if (!a.length) break;
      const ch = usado.length === 0 ? a.sort((x, y) => y[1] - x[1])[0] : a.filter(x => x[1] >= need).sort((x, y) => x[1] - y[1])[0] || a.sort((x, y) => y[1] - x[1])[0];
      const use = Math.min(ch[1], need); usado.push([ch[0], use]); need -= use;
    }
    if (need > 0) break;
    for (const [pid, use] of usado) { q.set(pid, q.get(pid) - use); alloc.set(pid, (alloc.get(pid) || 0) + use); }
    packs++;
  }
  return { packs, alloc };
}
const packsGrupo = (g, cant) => g.maxVar ? repartoMax(g, cant, Infinity).packs : Math.floor(g.pids.reduce((t, pid) => t + (cant.get(pid) || 0), 0) / g.cant);
function asignarPack(items) {
  for (const i of items) {
    if (i.comboId) i.cantPromo = 0;
    else if (i.promoQty) { const p = state.productos.find(x => x.id === i.pid), m = p ? promoCantDe(p) : 0; if (m > 1) i.cantPromo = Math.floor(i.cant / m) * m; else delete i.cantPromo; }   // promo por cantidad exacta: solo los múltiplos de la cantidad llevan el precio de la promo
    else delete i.cantPromo;
  }
  for (const cid of new Set(items.filter(i => i.comboId).map(i => i.comboId))) {
    const c = state.combos.find(x => x.id === cid); if (!c) continue;
    const cant = new Map(items.map(i => [i.pid, i.cant]));
    const packs = Math.min(...c.grupos.map(g => packsGrupo(g, cant)));
    for (const g of c.grupos) {
      const rep = g.maxVar ? repartoMax(g, cant, packs).alloc : null;
      let rest = packs * g.cant;
      for (const i of items) if (i.comboId === cid && g.pids.includes(i.pid) && rest > 0) { const t = rep ? rep.get(i.pid) || 0 : Math.min(i.cant, rest); i.cantPromo += t; rest -= t; }
    }
  }
}
function totalesDe(items) {
  const subtotal = Math.round(items.reduce((t, i) => t + (i.cantPromo === undefined ? i.precio * i.cant : i.precio * i.cantPromo + (i.precioLista ?? i.precio) * (i.cant - i.cantPromo)), 0) * 100) / 100, total = redondear(subtotal);
  return { subtotal, redondeo: Math.round((total - subtotal) * 100) / 100, total };
}
function repreciarPendientes() {
  for (const o of state.pedidos) {
    if (o.estado === 'cargado') continue;
    const cant = new Map(o.items.map(i => [i.pid, i.cant]));
    for (const i of o.items) {
      const p = state.productos.find(x => x.id === i.pid); if (!p) continue;
      let combo = null;
      if (i.comboId) { const c = state.combos.find(x => x.id === i.comboId); if (c && comboIncluye(c, i.pid) && comboCumple(c, cant)) combo = c; }
      const qty = !combo && !!i.promoQty && hayPromo(p) && promoCantDe(p) > 1 && i.cant >= promoCantDe(p);
      const auto = !combo && !qty && hayPromo(p) && promoCantDe(p) <= 1;
      const unit = combo ? precioComboDe(combo, p) : (qty || auto) ? precioPromoDe(p) : p.precio;
      if (!(unit > 0)) continue;   // producto sin precio: se deja el último
      Object.assign(i, { nombre: p.nombre, codigo: p.codigo, precio: unit, precioLista: p.precio, promo: (qty || auto) || undefined, promoQty: qty || undefined, comboId: combo ? combo.id : undefined, comboNombre: combo ? combo.nombre : undefined });
    }
    asignarPack(o.items);
    Object.assign(o, totalesDe(o.items));
  }
}
// Copia de seguridad automática: una por día (la del último guardado del día), se conservan las últimas 14. Sirve para recuperar datos borrados por error.
let ultimaCopia = '';
async function copiaDiaria(pool, dia, json) {
  try {
    if (pool) {
      await pool.query("INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value=$2", ['copia-' + dia, json]);
      if (ultimaCopia !== dia) await pool.query("DELETE FROM kv WHERE key LIKE 'copia-%' AND key NOT IN (SELECT key FROM kv WHERE key LIKE 'copia-%' ORDER BY key DESC LIMIT 14)");
    } else {
      const dir = path.join(path.dirname(FILE), 'copias'); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, dia + '.json'), json);
      if (ultimaCopia !== dia) for (const f of fs.readdirSync(dir).filter(x => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort().slice(0, -14)) fs.unlinkSync(path.join(dir, f));
    }
    ultimaCopia = dia;
  } catch (e) { console.error('Copia diaria:', e.message); }
}
async function listarCopias(pool) {
  if (pool) {
    const r = await pool.query("SELECT key, jsonb_array_length(COALESCE(value->'pedidos','[]'::jsonb)) AS pedidos, jsonb_array_length(COALESCE(value->'clientes','[]'::jsonb)) AS clientes, jsonb_array_length(COALESCE(value->'productos','[]'::jsonb)) AS productos FROM kv WHERE key LIKE 'copia-2%' OR key LIKE 'previa-2%' ORDER BY key DESC");
    return r.rows.map(x => ({ fecha: x.key.startsWith('copia-') ? x.key.slice(6) : x.key, pedidos: x.pedidos, clientes: x.clientes, productos: x.productos }));
  }
  const dir = path.join(path.dirname(FILE), 'copias'); if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(x => /^(\d{4}-\d{2}-\d{2}|previa-[\dTZ-]+)\.json$/.test(x)).sort().reverse().map(f => { const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return { fecha: f.slice(0, -5), pedidos: (d.pedidos || []).length, clientes: (d.clientes || []).length, productos: (d.productos || []).length }; });
}
async function leerCopia(pool, fecha) {
  if (!/^(\d{4}-\d{2}-\d{2}|previa-[\dTZ-]+)$/.test(fecha)) return null;
  if (pool) { const r = await pool.query('SELECT value FROM kv WHERE key=$1', [fecha.startsWith('previa-') ? fecha : 'copia-' + fecha]); return r.rows[0] ? r.rows[0].value : null; }
  const f = path.join(path.dirname(FILE), 'copias', fecha + '.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}
async function copiaPrevia(pool) {   // antes de restaurar se guarda lo actual, para poder volver atrás
  const marca = new Date().toISOString().replace(/[:.]/g, '-'), json = JSON.stringify(state);
  if (pool) { await pool.query('INSERT INTO kv (key, value) VALUES ($1, $2)', ['previa-' + marca, json]); await pool.query("DELETE FROM kv WHERE key LIKE 'previa-%' AND key NOT IN (SELECT key FROM kv WHERE key LIKE 'previa-%' ORDER BY key DESC LIMIT 10)"); }
  else { const dir = path.join(path.dirname(FILE), 'copias'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'previa-' + marca + '.json'), json); }
  return 'previa-' + marca;
}
function restaurarDatos(d) {   // reemplaza pedidos, clientes, productos, promos y novedades; NO toca usuarios ni contraseñas
  for (const k of ['productos', 'pedidos', 'clientes']) if (!Array.isArray(d[k])) throw { code: 400, msg: 'El archivo no es una copia válida (falta ' + k + ')' };
  if (d.pedidos.some(p => !p || !Number.isInteger(p.id) || !Array.isArray(p.items)) || d.clientes.some(c => !c || !Number.isInteger(c.id)) || d.productos.some(p => !p || !Number.isInteger(p.id))) throw { code: 400, msg: 'El archivo tiene datos dañados' };
  state.productos = d.productos; state.pedidos = d.pedidos; state.clientes = d.clientes;
  state.combos = Array.isArray(d.combos) ? d.combos : []; state.novedades = Array.isArray(d.novedades) ? d.novedades : [];
  state.configPorCodigo = d.configPorCodigo && typeof d.configPorCodigo === 'object' ? d.configPorCodigo : {};
  const mx = l => l.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
  state.seq.p = Math.max(state.seq.p || 1, mx(state.productos), (d.seq || {}).p || 1); state.seq.o = Math.max(state.seq.o || 1, mx(state.pedidos), (d.seq || {}).o || 1);
  state.seq.c = Math.max(state.seq.c || 1, mx(state.clientes), (d.seq || {}).c || 1); state.seq.k = Math.max(state.seq.k || 1, mx(state.combos), (d.seq || {}).k || 1); state.seq.n = Math.max(state.seq.n || 1, mx(state.novedades), (d.seq || {}).n || 1);
}
function save(pool) {
  repreciarPendientes();
  const json = JSON.stringify(state);
  const dia = new Date().toISOString().slice(0, 10);
  queue = queue.then(async () => {
    if (pool) await pool.query("INSERT INTO kv (key, value) VALUES ('pedidos', $1) ON CONFLICT (key) DO UPDATE SET value=$1", [json]);
    else { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, json); }
    await copiaDiaria(pool, dia, json);
  }).catch(e => console.error('Guardar:', e.message));
  return queue;
}

// Acepta 1234.5, "1.234,50", "$ 1234,5". Devuelve null si está vacío o no es número.
function parseNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  let t = String(v ?? '').replace(/[$\s]/g, '');
  if (!t) return null;
  t = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
const num = (v, d = 0) => { const n = parseNum(v); return n === null ? d : n; };
const truthy = v => /^(1|si|sí|s|true|activo|x)$/i.test(String(v).trim());

function hashPass(pass, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pass), salt, 32).toString('hex') };
}
const passOk = (u, pass) => { const h = Buffer.from(hashPass(pass, u.salt).hash), g = Buffer.from(u.hash); return h.length === g.length && crypto.timingSafeEqual(h, g); };
const pub = u => ({ id: u.id, usuario: u.usuario, nombre: u.nombre, rol: u.rol, activo: u.activo });
// Promos: precio fijo (precioPromo) o descuento % (promoPct). Con promoCant > 1 solo aplica a esa cantidad exacta (o a sus múltiplos); lo que sobra va a precio normal
// y el vendedor la acepta; con promoCant 1 se aplica siempre, sola.
const hayPromo = p => !!p.promo && (p.precioPromo > 0 || p.promoPct > 0);
const promoCantDe = p => Math.max(1, p.promoCant || 1);
const precioPromoDe = p => Math.round((p.precioPromo > 0 ? p.precioPromo : p.precio * (100 - (p.promoPct || 0)) / 100) * 100) / 100;

function cleanProducto(b, prev = {}) {
  const nombre = String(b.nombre ?? prev.nombre ?? '').trim();
  const codigo = String(b.codigo ?? prev.codigo ?? '').trim();
  if (!nombre) throw { code: 400, msg: 'Falta el nombre' };
  if (!codigo) throw { code: 400, msg: 'Falta el código' };
  const promo = b.promo === undefined ? prev.promo ?? false : !!b.promo;
  if (promo && !(num(b.precioPromo, prev.precioPromo ?? 0) > 0 || num(b.promoPct, prev.promoPct ?? 0) > 0)) throw { code: 400, msg: 'La promoción necesita un descuento % o un precio promo' };
  return {
    codigo, nombre,
    precio: num(b.precio, prev.precio ?? 0),
    multiplo: Math.max(1, Math.floor(num(b.multiplo, prev.multiplo ?? 1))),   // unidad de venta: las cantidades van de a este múltiplo (1, 5, 10…)
    multiploSet: b.multiplo !== undefined ? true : !!prev.multiploSet,        // definida a mano: las importaciones no la pisan
    activo: b.activo === undefined ? prev.activo ?? true : !!b.activo,
    promo: b.promo === undefined ? prev.promo ?? false : !!b.promo,
    precioPromo: num(b.precioPromo, prev.precioPromo ?? 0),
    promoCant: Math.max(1, Math.floor(num(b.promoCant, prev.promoCant ?? 1))),
    promoPct: Math.min(100, num(b.promoPct, prev.promoPct ?? 0)),
    usaStock: b.usaStock === undefined ? !!prev.usaStock : !!b.usaStock,   // stock opcional por producto: se descuenta con cada pedido
    stock: Math.max(0, Math.floor(num(b.stock, prev.stock ?? 0))),
  };
}

// Promos combinadas: la promo pide una cantidad por grupo de productos (un grupo puede ser un solo producto o varios "de cualquier sabor").
// Si el pedido cumple todos los grupos y el vendedor la acepta, cada unidad de los productos de la promo va con descuento % o con precio fijo.
const sumaGrupo = (g, cant) => g.pids.reduce((t, pid) => t + (cant.get(pid) || 0), 0);
const comboCumple = (c, cant) => c.activa && c.grupos.every(g => packsGrupo(g, cant) >= 1);
const comboIncluye = (c, pid) => c.grupos.some(g => g.pids.includes(pid));
const precioComboDe = (c, p) => (c.tipo === 'precio' ? (c.precios || {})[p.id] || p.precio : Math.round(p.precio * (100 - c.pct)) / 100);   // 'precio': cada producto tiene el suyo
// Las promos y la unidad de venta se guardan por CÓDIGO de producto: si un producto se borra (por ejemplo al reemplazar la lista)
// su configuración queda guardada y se vuelve a aplicar cuando aparezca otro producto con ese mismo código.
const CONFIG_PRODUCTO = ['promo', 'promoCant', 'promoPct', 'precioPromo', 'multiplo', 'multiploSet'];
const mismoCodigo = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
function quitarProductos(ids) {
  state.configPorCodigo = state.configPorCodigo || {};
  for (const p of state.productos.filter(x => ids.has(x.id))) {
    if (p.promo || p.multiploSet) { const c = {}; for (const k of CONFIG_PRODUCTO) if (p[k] !== undefined) c[k] = p[k]; state.configPorCodigo[p.codigo.toLowerCase()] = c; }
    for (const c of state.combos) {   // en las promos combinadas el producto queda reservado por su código
      for (const g of c.grupos) if (g.pids.includes(p.id)) {
        g.pids = g.pids.filter(pid => pid !== p.id);
        g.codigos = [...new Set([...(g.codigos || []), p.codigo])];
      }
      if (c.precios && c.precios[p.id] !== undefined) { c.preciosCod = { ...(c.preciosCod || {}), [p.codigo]: c.precios[p.id] }; delete c.precios[p.id]; }
    }
  }
  state.productos = state.productos.filter(x => !ids.has(x.id));
}
function restaurarProducto(p) {   // producto nuevo: recupera la promo/unidad guardadas y vuelve a sus promos combinadas
  const c = (state.configPorCodigo || {})[p.codigo.toLowerCase()];
  if (c) { Object.assign(p, c); delete state.configPorCodigo[p.codigo.toLowerCase()]; }
  for (const co of state.combos) {
    for (const g of co.grupos) if ((g.codigos || []).some(x => mismoCodigo(x, p.codigo)) && !g.pids.includes(p.id)) g.pids.push(p.id);
    const pr = co.preciosCod && Object.entries(co.preciosCod).find(([k]) => mismoCodigo(k, p.codigo));
    if (pr && co.tipo === 'precio') { co.precios = co.precios || {}; co.precios[p.id] = pr[1]; delete co.preciosCod[pr[0]]; }
  }
}
const grupoConPerdidos = (g, vivos) => ({ ...g, perdidos: (g.codigos || []).filter(cod => !vivos.some(p => mismoCodigo(p.codigo, cod))) });
function cleanCombo(b) {
  const nombre = String(b.nombre || '').trim();
  if (!nombre) throw { code: 400, msg: 'Falta el nombre de la promo' };
  const grupos = (Array.isArray(b.grupos) ? b.grupos : []).map(g => {
    const pids = [...new Set((Array.isArray(g.pids) ? g.pids : []).map(Number))];
    const cods = pids.map(pid => (state.productos.find(p => p.id === pid) || {}).codigo).filter(Boolean);
    const maxVar = Math.floor(num(g.maxVar)); return { cant: Math.floor(num(g.cant)), ...(maxVar >= 1 ? { maxVar } : {}), pids, codigos: [...new Set([...cods, ...(Array.isArray(g.perdidos) ? g.perdidos : [])])] };   // 'perdidos': códigos reservados de productos que hoy no están en la lista
  });
  if (!grupos.length) throw { code: 400, msg: 'Agregá al menos un grupo de productos' };
  for (const g of grupos) {
    if (!(g.cant >= 1)) throw { code: 400, msg: 'Cada grupo necesita una cantidad de 1 o más' };
    if (!g.codigos.length || g.pids.some(pid => !state.productos.some(p => p.id === pid))) throw { code: 400, msg: 'Cada grupo necesita al menos un producto' };
  }
  const tipo = b.tipo === 'precio' ? 'precio' : 'pct';
  const pct = Math.min(100, num(b.pct));
  if (tipo === 'pct' && !(pct > 0)) throw { code: 400, msg: 'Poné el porcentaje de descuento' };
  const precios = {};
  if (tipo === 'precio') for (const pid of new Set(grupos.flatMap(g => g.pids))) {   // cada producto lleva su precio con descuento
    const v = num((b.precios || {})[pid]);
    if (!(v > 0)) throw { code: 400, msg: `Poné el precio promo de "${state.productos.find(p => p.id === pid).nombre}"` };
    precios[pid] = v;
  }
  return { nombre, activa: b.activa === undefined ? true : !!b.activa, grupos, tipo, pct: tipo === 'pct' ? pct : 0, precios, preciosCod: b.preciosCod || {} };
}

const REDONDEO = 50;   // el total de cada pedido se redondea hacia arriba a múltiplo de 50
const redondear = x => Math.ceil(Math.round(x * 100) / (REDONDEO * 100)) * REDONDEO;
const nombreCliente = c => [c.nombre, c.apellido].filter(Boolean).join(' ');
function cleanCliente(b, prev, admin, yo) {
  const t = k => String(b[k] ?? prev?.[k] ?? '').trim();
  // nombre y apellido van juntos en un solo campo
  const o = { nombre: [String(b.nombre ?? prev?.nombre ?? '').trim(), String(b.apellido ?? '').trim()].filter(Boolean).join(' '), apellido: '', direccion: t('direccion'), telefono: t('telefono') };
  if (!o.nombre) throw { code: 400, msg: 'Falta el nombre y apellido' };
  if (admin) {
    o.codigo = t('codigo');
    if (o.codigo && state.clientes.some(c => c.id !== prev?.id && c.codigo.toLowerCase() === o.codigo.toLowerCase())) throw { code: 409, msg: 'Ya existe un cliente con ese código' };
    o.vendedorId = Number(b.vendedorId ?? prev?.vendedorId);
    if (!state.usuarios.some(u => u.id === o.vendedorId)) throw { code: 400, msg: 'Asignale un vendedor al cliente' };
  } else {   // el vendedor no pone código ni cambia el vendedor: el cliente queda a su nombre
    if (prev && b.vendedorId !== undefined && Number(b.vendedorId) !== prev.vendedorId) throw { code: 403, msg: 'Solo el administrador puede reasignar un cliente a otro vendedor' };
    o.codigo = prev ? prev.codigo : '';
    o.vendedorId = prev ? prev.vendedorId : yo.id;
  }
  return o;
}

// Stock (opcional por producto): cada pedido descuenta lo que lleva; al editarlo, eliminarlo o rechazarlo se ajusta o se repone.
const cantsStock = o => new Map(o && !o.stockRepuesto ? o.items.map(i => [i.pid, i.cant]) : []);
function ajustarStock(viejo, nuevo) {
  const a = cantsStock(viejo), b = cantsStock(nuevo);
  for (const pid of new Set([...a.keys(), ...b.keys()])) {
    const p = state.productos.find(x => x.id === pid);
    if (p && p.usaStock) p.stock = Math.max(0, (p.stock || 0) - ((b.get(pid) || 0) - (a.get(pid) || 0)));
  }
}
function reponerStock(o, reponer) {   // pedido rechazado: la mercadería vuelve al stock; si se quita el rechazo, se descuenta de nuevo
  if (reponer === !!o.stockRepuesto) return;
  if (reponer) { ajustarStock(o, { ...o, stockRepuesto: true }); o.stockRepuesto = true; }
  else { ajustarStock({ ...o, stockRepuesto: true }, { ...o, stockRepuesto: false }); o.stockRepuesto = false; }
}

// Arma un pedido nuevo/editado con las líneas y su precio.
function armarPedido(b, viejo, quien, admin) {
  // una vez cargado el pedido, el vendedor ya no puede cambiar la nota
  const nota = !admin && viejo && viejo.estado === 'cargado' ? viejo.nota || '' : String(b.nota || '').trim();
  let cli = null;
  if (b.clienteId) {
    cli = state.clientes.find(c => c.id === Number(b.clienteId));
    const huerfano = !cli && viejo && viejo.clienteId === Number(b.clienteId);   // el cliente se borró después de cargar el pedido: queda con los datos que tenía
    if (!huerfano && (!cli || (!admin && cli.vendedorId !== quien.id && !(viejo && viejo.clienteId === cli.id)))) throw { code: 400, msg: 'Cliente inexistente' };   // un vendedor solo elige entre sus clientes (en un pedido que ya era suyo puede conservar el cliente que tenía)
  } else if (!viejo || viejo.clienteId) throw { code: 400, msg: 'Elegí un cliente' };   // pedidos viejos sin cliente cargado se pueden seguir editando
  const dia = String(b.dia || '').trim(), turno = String(b.turno || '').trim();
  if (!(viejo && !viejo.dia && !dia && !turno)) {   // pedidos viejos sin día/turno se pueden editar tal cual
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia) || Number.isNaN(Date.parse(dia))) throw { code: 400, msg: 'Elegí el día' };
    if (!['manana', 'tarde'].includes(turno)) throw { code: 400, msg: 'Elegí el turno: mañana o tarde' };
  }
  const cliente = cli ? nombreCliente(cli) : viejo.cliente;
  const vend = cli && state.usuarios.find(u => u.id === cli.vendedorId);
  const viejas = new Map((viejo ? viejo.items : []).map(i => [i.pid, i]));
  const nuevas = new Map();
  for (const it of Array.isArray(b.items) ? b.items : []) {
    const cant = Math.floor(num(it.cant));
    if (cant > 0) nuevas.set(Number(it.pid), (nuevas.get(Number(it.pid)) || 0) + cant);
  }
  if (!nuevas.size) throw { code: 400, msg: 'El pedido no tiene productos' };
  const quierePromo = new Map(), quiereCombo = new Map();
  for (const it of Array.isArray(b.items) ? b.items : []) { if (it.promo) quierePromo.set(Number(it.pid), true); if (it.combo) quiereCombo.set(Number(it.pid), Number(it.combo)); }
  const items = [];
  for (const [pid, cant] of nuevas) {
    const p = state.productos.find(x => x.id === pid);
    const old = viejas.get(pid);
    if (!p) { if (old) { items.push({ ...old, cant }); continue; } throw { code: 400, msg: 'Producto inexistente' }; }   // producto borrado de la lista: la línea del pedido queda como estaba
    if (!old && !p.activo) throw { code: 409, msg: `"${p.nombre}" está desactivado` };
    const m = p.multiplo || 1;
    if (cant % m && !(old && old.cant === cant)) throw { code: 400, msg: `"${p.nombre}" tiene unidad de venta ${m}: la cantidad tiene que ser múltiplo de ${m}` };
    if (!old && !((hayPromo(p) && promoCantDe(p) <= 1 ? precioPromoDe(p) : p.precio) > 0)) throw { code: 409, msg: `"${p.nombre}" no tiene precio` };
    let aplica = hayPromo(p) && promoCantDe(p) <= 1;   // promo sin cantidad: automática
    if (quierePromo.get(pid)) {   // promo por cantidad aceptada por el vendedor
      if (!hayPromo(p) || promoCantDe(p) <= 1 || cant < promoCantDe(p)) throw { code: 409, msg: `La promo de "${p.nombre}" no aplica (hay que llevar ${promoCantDe(p)})` };
      aplica = true;
    }
    let combo = null;
    if (quiereCombo.get(pid)) {   // promo combinada aceptada por el vendedor
      combo = state.combos.find(c => c.id === quiereCombo.get(pid));
      if (!combo || !comboIncluye(combo, pid) || !comboCumple(combo, nuevas)) throw { code: 409, msg: `La promo "${combo ? combo.nombre : ''}" no aplica con las cantidades del pedido` };
      aplica = false;
    }
    const unit = combo ? precioComboDe(combo, p) : aplica ? precioPromoDe(p) : p.precio;
    // Un producto que ya estaba en el pedido conserva el precio con que se vendió, aunque después cambie el precio o las promos del producto;
    // solo se recalcula si el vendedor acepta o quita una promo (por cantidad o combinada) en esa línea.
    const qtyNow = !combo && !!quierePromo.get(pid);
    const oldQty = old ? old.promoQty ?? (!!old.promo && promoCantDe(p) > 1) : false;
    const mismo = old && viejo.estado === 'cargado' && (old.comboId || 0) === (combo ? combo.id : 0) && oldQty === qtyNow;   // los pendientes siguen el precio vigente
    items.push({ pid, codigo: p.codigo, nombre: p.nombre, precio: mismo ? old.precio : unit, precioLista: mismo ? old.precioLista ?? p.precio : p.precio, promo: aplica || undefined, promoQty: qtyNow || undefined, comboId: combo ? combo.id : undefined, comboNombre: combo ? combo.nombre : undefined, cant });
  }
  asignarPack(items);
  const antes = cantsStock(viejo);
  for (const i of items) {
    const p = state.productos.find(x => x.id === i.pid);
    if (p && p.usaStock && i.cant - (antes.get(i.pid) || 0) > (p.stock || 0)) throw { code: 409, msg: `Stock insuficiente de "${p.nombre}": quedan ${p.stock || 0}` };
  }
  // Pedido ya cargado por administración: si lo edita el vendedor queda marcado "agregar" para que el admin lo vea
  let extra = {};
  if (viejo && viejo.estado === 'cargado') {
    for (const i of items) { const o = viejas.get(i.pid); i.cantCargada = admin ? i.cant : (o ? o.cantCargada ?? o.cant : 0); }
    if (admin) extra = { agregar: false, agregadoEn: undefined, sumar: sumarDe(viejo), cargadoItems: items.map(i => ({ pid: i.pid, nombre: i.nombre, cant: i.cant })) };   // lo que edita el admin queda como cargado
    else {
      const igual = items.length === viejo.items.length && items.every(i => { const o = viejas.get(i.pid); return o && o.cant === i.cant && !!o.promo === !!i.promo && o.comboId === i.comboId; })
        && (dia || '') === (viejo.dia || '') && (turno || '') === (viejo.turno || '') && nota === (viejo.nota || '') && (cli ? cli.id : viejo.clienteId) === viejo.clienteId;
      if (!igual) extra = { agregar: true, agregadoEn: new Date().toISOString() };
    }
  }
  const { subtotal, redondeo, total } = totalesDe(items);
  return { ...extra, cliente, clienteCodigo: cli ? cli.codigo : viejo ? viejo.clienteCodigo : undefined, nota, items, subtotal, redondeo, total, clienteId: cli ? cli.id : viejo ? viejo.clienteId : undefined, dia: dia || undefined, turno: turno || undefined, vendedorId: vend && (admin || !viejo) ? vend.id : viejo ? viejo.vendedorId : quien.id, vendedor: vend && (admin || !viejo) ? vend.nombre : viejo ? viejo.vendedor : quien.nombre };   // un vendedor que edita su pedido no lo pasa a otro vendedor aunque el cliente haya sido reasignado
}

// ---- sesiones: token firmado con el usuario; el rol se lee de la base en cada pedido ----
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
// 'h' ata el token a la clave: al cambiarla, los tokens anteriores dejan de valer
const makeToken = (u, secret) => { const p = b64({ u: u.id, h: u.hash.slice(0, 12), exp: Date.now() + 30 * 864e5 }); return p + '.' + crypto.createHmac('sha256', secret).update(p).digest('hex'); };
function userFromToken(h, secret) {
  const [p, sig] = String(h || '').replace(/^Bearer /, '').split('.');
  if (!p || !sig) return null;
  const ok = crypto.createHmac('sha256', secret).update(p).digest('hex');
  if (ok.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(ok), Buffer.from(sig))) return null;
  try {
    const d = JSON.parse(Buffer.from(p, 'base64url').toString());
    const u = state.usuarios.find(x => x.id === d.u);
    return d.exp > Date.now() && u && u.activo && d.h === u.hash.slice(0, 12) ? u : null;
  } catch { return null; }
}
const fallos = new Map();   // usuario -> [timestamps] de intentos fallidos

function cleanUsuario(b, prev) {
  const usuario = String(b.usuario ?? prev?.usuario ?? '').trim().toLowerCase();
  const nombre = String(b.nombre ?? prev?.nombre ?? '').trim() || usuario;
  if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) throw { code: 400, msg: 'Usuario: 3 a 30 letras minúsculas, números, punto, guion' };
  if (state.usuarios.some(u => u.id !== prev?.id && u.usuario === usuario)) throw { code: 409, msg: 'Ese usuario ya existe' };
  const rol = b.rol === undefined ? prev?.rol || 'vendedor' : b.rol;
  if (!['admin', 'vendedor'].includes(rol)) throw { code: 400, msg: 'Rol inválido' };
  const o = { usuario, nombre, rol, activo: b.activo === undefined ? prev?.activo ?? true : !!b.activo };
  if (b.password !== undefined && b.password !== '') {
    if (String(b.password).length < 4) throw { code: 400, msg: 'La contraseña debe tener al menos 4 caracteres' };
    Object.assign(o, hashPass(String(b.password).trim()));
  } else if (!prev) throw { code: 400, msg: 'Falta la contraseña' };
  return o;
}
// al cambiar el nombre de un usuario, los pedidos y clientes que lo guardan como texto pasan al nombre nuevo
function renombrar(u, nombre) {
  if (u.nombre === nombre) return;
  for (const p of state.pedidos) { if (p.vendedorId === u.id) p.vendedor = nombre; if (p.editadoPor === u.nombre) p.editadoPor = nombre; }
  for (const c of state.clientes) if (c.editadoPor === u.nombre) c.editadoPor = nombre;
}
// lo que el vendedor agregó a un pedido ya cargado (más lo que quedó pendiente de una vuelta anterior): se guarda para que el administrador lo arme aunque ya haya vuelto a cargar el pedido
function sumarDe(o) {
  if (!o.agregar) return o.sumar;
  const m = new Map((o.sumar || []).map(x => [x.pid, { ...x }]));
  for (const i of o.items) { const d = i.cant - (i.cantCargada || 0); if (d > 0) { const x = m.get(i.pid) || { pid: i.pid, nombre: i.nombre, cant: 0 }; x.cant += d; m.set(i.pid, x); } }
  return m.size ? [...m.values()] : undefined;
}
const adminsActivos = () => state.usuarios.filter(u => u.rol === 'admin' && u.activo);

const CODIGOS_IGNORADOS = { '9999': 'redondeo', '7040': 'servicio de reparto' };
const NOMBRES_IGNORADOS = ['redondeo', 'servicio de reparto'];
const sinCeros = c => String(c ?? '').trim().replace(/^0+(?=\d)/, '');
const ignoradoPor = f => CODIGOS_IGNORADOS[sinCeros(f.codigo)] ? sinCeros(f.codigo) : NOMBRES_IGNORADOS.includes(String(f.nombre ?? '').trim().toLowerCase()) ? String(f.nombre).trim().toUpperCase() : null;   // renglones de la lista del proveedor que no son productos
function importar(b) {
  const filas = Array.isArray(b.rows) ? b.rows : [];
  const r = { creados: 0, actualizados: 0, desactivados: 0, borrados: 0, ignorados: [], nuevos: [], errores: [] };
  const vistos = new Set();
  filas.forEach((f, n) => {
    const codigo = String(f.codigo ?? '').trim();
    const fila = n + 1;
    if (!codigo) return r.errores.push(`Fila ${fila}: sin código`);
    const ign = ignoradoPor(f);
    if (ign) return r.ignorados.push(CODIGOS_IGNORADOS[ign] ? `${ign} (${CODIGOS_IGNORADOS[ign]})` : ign);   // se saltea: no se crea ni se actualiza
    const precio = f.precio === undefined || f.precio === '' ? null : parseNum(f.precio);
    if (f.precio !== undefined && f.precio !== '' && precio === null) return r.errores.push(`Fila ${fila} (${codigo}): precio inválido`);
    let p = state.productos.find(x => x.codigo.toLowerCase() === codigo.toLowerCase());
    const mult = f.multiplo === undefined || f.multiplo === '' ? null : parseNum(f.multiplo);
    if (f.multiplo !== undefined && f.multiplo !== '' && !(mult >= 1)) return r.errores.push(`Fila ${fila} (${codigo}): unidad de venta inválida`);
    const stk = f.stock === undefined || f.stock === '' ? null : parseNum(f.stock);
    if (f.stock !== undefined && f.stock !== '' && (stk === null || stk < 0)) return r.errores.push(`Fila ${fila} (${codigo}): stock inválido`);
    const sinPrecio = precio === 0;   // precio 0 = sin precio: queda desactivado
    vistos.add(codigo.toLowerCase());
    if (!p) {
      const nombre = String(f.nombre ?? '').trim();
      if (!nombre || precio === null) return r.errores.push(`Fila ${fila} (${codigo}): producto nuevo necesita nombre y precio`);
      const nuevoProd = { id: state.seq.p++, codigo, nombre, precio, multiplo: mult ? Math.floor(mult) : 1, multiploSet: !!mult, ...(stk !== null ? { usaStock: true, stock: Math.floor(stk) } : {}), activo: sinPrecio ? false : f.activo === undefined || f.activo === '' ? true : truthy(f.activo), promo: false, precioPromo: 0 };
      state.productos.push(nuevoProd); restaurarProducto(nuevoProd);
      r.nuevos.push({ codigo, nombre, precio });
      return r.creados++;
    }
    if (String(f.nombre ?? '').trim()) p.nombre = String(f.nombre).trim();
    if (precio !== null) p.precio = precio;   // precio 0: queda en 0 (y desactivado)
    if (mult && !p.multiploSet) { p.multiplo = Math.floor(mult); p.multiploSet = true; }   // la unidad de venta solo se carga si todavía no estaba definida
    if (stk !== null) { p.usaStock = true; p.stock = Math.floor(stk); }   // la planilla trae stock: el producto pasa a controlar stock
    if (sinPrecio) p.activo = false;
    else if (f.activo !== undefined && f.activo !== '') p.activo = truthy(f.activo);
    else if (precio !== null) p.activo = true;   // lista nueva: precio 0 queda desactivado y con precio queda activo
    r.actualizados++;
  });
  const viejos = new Set(state.productos.filter(p => CODIGOS_IGNORADOS[sinCeros(p.codigo)]).map(p => p.id));   // si ya habían quedado cargados de antes, se quitan
  if (viejos.size) quitarProductos(viejos);
  if (b.catalogoCompleto) for (const p of state.productos) if (p.activo && !vistos.has(p.codigo.toLowerCase())) { p.activo = false; r.desactivados++; }
  if (b.reemplazar) {   // la lista nueva reemplaza a la anterior: se borran los productos que no figuran en el archivo
    if (!vistos.size) r.errores.push('No se encontraron productos válidos en el archivo: no se borró nada');
    else {
      const ids = new Set(state.productos.filter(p => !vistos.has(p.codigo.toLowerCase())).map(p => p.id));
      quitarProductos(ids); r.borrados = ids.size;   // se borran, pero sus promos y su unidad de venta quedan guardadas por código
    }
  }
  return r;
}

function importarClientes(b, quien) {
  const marca = { editadoEn: new Date().toISOString(), editadoPor: quien.nombre };   // última edición y quién
  const filas = Array.isArray(b.rows) ? b.rows : [];
  const r = { leidas: filas.length, creados: 0, actualizados: 0, errores: [], avisos: [] };
  const porDefecto = state.usuarios.find(u => u.id === Number(b.vendedorId));
  const enEsteArchivo = new Map();   // código -> fila: no se pisa un cliente cargado en esta misma importación
  filas.forEach((f, n) => {
    const t = k => String(f[k] ?? '').trim();
    const fila = `Fila ${n + 1}${t('nombre') ? ' (' + t('nombre') + ')' : ''}`;
    if (!t('nombre')) return r.errores.push(`Fila ${n + 1}: sin nombre`);
    let vend = porDefecto;
    if (t('vendedor')) {
      const v = t('vendedor').toLowerCase();
      vend = (/^\d+$/.test(v) && state.usuarios.find(u => u.id === Number(v))) || state.usuarios.find(u => u.usuario === v || u.nombre.toLowerCase() === v);   // primero por ID
      if (!vend) return r.errores.push(`${fila}: no existe el vendedor con ID "${t('vendedor')}" (el ID está en Usuarios)`);
    }
    if (!vend) return r.errores.push(`${fila}: falta asignarle un vendedor`);
    let codigo = t('codigo');
    if (codigo && enEsteArchivo.has(codigo.toLowerCase())) {   // el código ya lo usó otra fila de este archivo: se carga igual, sin código, y se avisa
      r.avisos.push(`${fila}: el código ${codigo} ya está en la fila ${enEsteArchivo.get(codigo.toLowerCase())}; se cargó sin código (asignalo después)`);
      codigo = '';
    }
    const c = codigo && state.clientes.find(x => x.codigo.toLowerCase() === codigo.toLowerCase());
    if (codigo) enEsteArchivo.set(codigo.toLowerCase(), n + 1);
    if (c) {
      c.nombre = t('nombre'); c.apellido = '';
      if (t('direccion')) c.direccion = t('direccion');
      if (t('telefono')) c.telefono = t('telefono');
      c.vendedorId = vend.id; Object.assign(c, marca);
      for (const p of state.pedidos) if (p.clienteId === c.id) { p.cliente = nombreCliente(c); p.clienteCodigo = c.codigo; }
      r.actualizados++;
    } else {
      state.clientes.push({ ...marca, id: state.seq.c++, codigo, nombre: t('nombre'), apellido: '', direccion: t('direccion'), telefono: t('telefono'), vendedorId: vend.id });
      r.creados++;
    }
  });
  return r;
}

// Envía una notificación push a todos los dispositivos de los usuarios indicados; los dispositivos dados de baja se limpian solos.
function notificar(userIds, payload, pool) {
  if (!webpush || !state.vapid) return;
  const subs = state.pushSubs.filter(x => userIds.includes(x.u));
  if (!subs.length) return;
  Promise.allSettled(subs.map(x => webpush.sendNotification(x.sub, JSON.stringify(payload), { TTL: 86400 }).catch(e => { if (e && (e.statusCode === 404 || e.statusCode === 410)) x.muerta = true; throw e; }))).then(() => {
    if (state.pushSubs.some(x => x.muerta)) { state.pushSubs = state.pushSubs.filter(x => !x.muerta); save(pool); }
  });
}

module.exports = async function (req, res, url, body, send, pool, secret) {
  const s = await load(pool);
  const m = /^\/api\/p\/([a-z]+)(?:\/(\d+))?$/.exec(url);
  if (!m) return send(res, 404, { error: 'No encontrado' });
  const [, rec, idStr] = m;
  const id = idStr ? Number(idStr) : null;
  try {
    if (rec === 'login' && req.method === 'POST') {
      const b = await body(req, 1e4);
      const usuario = String(b.user || '').trim().toLowerCase();
      const ahora = Date.now();
      if (fallos.size > 5000) for (const [k, v] of fallos) if (!v.some(t => ahora - t < 10 * 60 * 1000)) fallos.delete(k);
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const fi = (fallos.get('ip:' + ip) || []).filter(t => ahora - t < 10 * 60 * 1000);
      const f = (fallos.get(usuario) || []).filter(t => ahora - t < 10 * 60 * 1000);
      if (f.length >= 10 || fi.length >= 40) throw { code: 429, msg: 'Demasiados intentos. Probá en unos minutos.' };
      const u = s.usuarios.find(x => x.usuario === usuario);
      const clave = String(b.pass || '');
      if (!u) hashPass(clave, 'a'.repeat(32));   // mismo costo si el usuario no existe: no se puede averiguar qué usuarios hay
      if (!u || !u.activo || !(passOk(u, clave) || passOk(u, clave.trim()))) {
        fallos.set('ip:' + ip, [...fi, ahora]);
        console.log('Login fallido:', usuario, !u ? '(el usuario no existe)' : !u.activo ? '(desactivado)' : '(contraseña)'); fallos.set(usuario, [...f, ahora]); throw { code: 401, msg: 'Usuario o contraseña incorrectos' }; }
      fallos.delete(usuario);
      return send(res, 200, { token: makeToken(u, secret), user: pub(u) });
    }
    const yo = userFromToken(req.headers.authorization, secret);
    if (!yo) throw { code: 401, msg: 'No autorizado' };
    const admin = yo.rol === 'admin';
    const soloAdmin = () => { if (!admin) throw { code: 403, msg: 'Solo el administrador puede hacer esto' }; };

    if (rec === 'yo' && req.method === 'GET') return send(res, 200, { ...pub(yo), db: !!pool });
    if (rec === 'clave' && req.method === 'PUT') {
      const b = await body(req, 1e4);
      if (!passOk(yo, b.actual || '')) throw { code: 403, msg: 'La contraseña actual no es correcta' };
      Object.assign(yo, cleanUsuario({ password: b.nueva }, yo));
      await save(pool);
      return send(res, 200, { ok: true, token: makeToken(yo, secret) });   // la sesión actual sigue valiendo con la clave nueva
    }

    if (rec === 'perfil' && req.method === 'PUT') {   // el administrador cambia su propio nombre y usuario
      soloAdmin();
      const b = await body(req, 1e4), nuevo = cleanUsuario({ nombre: b.nombre, usuario: b.usuario }, yo);
      renombrar(yo, nuevo.nombre);
      Object.assign(yo, nuevo); await save(pool);
      return send(res, 200, { user: pub(yo) });
    }

    if (rec === 'importar' && req.method === 'POST') {
      soloAdmin();
      const r = importar(await body(req, 30e6));
      await save(pool);
      return send(res, 200, r);
    }

    if (rec === 'importarclientes' && req.method === 'POST') {
      soloAdmin();
      const r = importarClientes(await body(req, 30e6), yo);
      await save(pool);
      return send(res, 200, r);
    }

    if (rec === 'usuarios') {
      soloAdmin();
      if (!id && req.method === 'GET') return send(res, 200, { usuarios: s.usuarios.map(pub) });
      if (!id && req.method === 'POST') {
        const datos = cleanUsuario(await body(req, 1e4));
        const u = { id: s.seq.u++, ...datos };
        s.usuarios.push(u); await save(pool);
        return send(res, 200, pub(u));
      }
      const u = s.usuarios.find(x => x.id === id);
      if (!u) throw { code: 404, msg: 'No existe' };
      if (req.method === 'PUT') {
        const nuevo = cleanUsuario(await body(req, 1e4), u);
        if ((nuevo.rol !== 'admin' || !nuevo.activo) && u.rol === 'admin' && u.activo && adminsActivos().length === 1) throw { code: 409, msg: 'Tiene que quedar al menos un administrador activo' };
        renombrar(u, nuevo.nombre);
        Object.assign(u, nuevo); await save(pool);
        return send(res, 200, pub(u));
      }
      if (req.method === 'DELETE') {
        if (u.id === yo.id) throw { code: 409, msg: 'No podés eliminar tu propio usuario' };
        if (s.clientes.some(c => c.vendedorId === u.id)) throw { code: 409, msg: 'Tiene clientes asignados: reasignalos antes de eliminarlo' };
        if (u.rol === 'admin' && u.activo && adminsActivos().length === 1) throw { code: 409, msg: 'Tiene que quedar al menos un administrador' };
        s.usuarios.splice(s.usuarios.indexOf(u), 1); await save(pool);
        return send(res, 200, { ok: true });
      }
      throw { code: 405, msg: 'Método no permitido' };
    }

    if (rec === 'combos') {
      if (!id && req.method === 'GET') return send(res, 200, { combos: s.combos.map(c => ({ ...c, grupos: c.grupos.map(g => grupoConPerdidos(g, s.productos)) })) });
      soloAdmin();
      if (!id && req.method === 'POST') {
        const datos = cleanCombo(await body(req, 1e5));
        const c = { id: s.seq.k++, ...datos };
        s.combos.push(c); await save(pool);
        return send(res, 200, c);
      }
      const c = s.combos.find(x => x.id === id);
      if (!c) throw { code: 404, msg: 'No existe' };
      if (req.method === 'PUT') { Object.assign(c, cleanCombo({ ...c, ...(await body(req, 1e5)) })); await save(pool); return send(res, 200, c); }
      if (req.method === 'DELETE') { s.combos.splice(s.combos.indexOf(c), 1); await save(pool); return send(res, 200, { ok: true }); }
      throw { code: 405, msg: 'Método no permitido' };
    }

    if (rec === 'clientes') {
      const vis = c => admin || c.vendedorId === yo.id;
      if (!id && req.method === 'GET') return send(res, 200, { clientes: s.clientes.filter(vis) });
      if (!id && req.method === 'POST') {
        const datos = cleanCliente(await body(req), null, admin, yo);
        const c = { id: s.seq.c++, ...datos, editadoEn: new Date().toISOString(), editadoPor: yo.nombre };
        s.clientes.push(c); await save(pool);
        return send(res, 200, c);
      }
      const c = s.clientes.find(x => x.id === id && vis(x));
      if (!c) throw { code: 404, msg: 'No existe' };
      if (req.method === 'GET') return send(res, 200, c);
      if (req.method === 'PUT') {
        Object.assign(c, cleanCliente(await body(req), c, admin, yo), { editadoEn: new Date().toISOString(), editadoPor: yo.nombre });
        for (const p of s.pedidos) if (p.clienteId === c.id) { p.cliente = nombreCliente(c); p.clienteCodigo = c.codigo; }
        await save(pool);
        return send(res, 200, c);
      }
      if (req.method === 'DELETE') {
        soloAdmin();
        s.clientes.splice(s.clientes.indexOf(c), 1); await save(pool);
        return send(res, 200, { ok: true });
      }
      throw { code: 405, msg: 'Método no permitido' };
    }

    if (rec === 'cargar' && req.method === 'PUT') {   // el administrador marca el pedido como cargado / pendiente / agregados revisados
      soloAdmin();
      const o = s.pedidos.find(x => x.id === id);
      if (!o) throw { code: 404, msg: 'No existe' };
      const { accion } = await body(req, 1e4), ahora = new Date().toISOString();
      if (accion === 'cargado') {
        if (o.estado !== 'cargado') o.cargadoEn = ahora;
        const sum = sumarDe(o); if (sum) o.sumar = sum;
        o.estado = 'cargado'; o.cargadoPor = yo.nombre; o.agregar = false;
        for (const i of o.items) i.cantCargada = i.cant;
        o.cargadoItems = o.items.map(i => ({ pid: i.pid, nombre: i.nombre, cant: i.cant }));
        delete o.agregadoEn;
      } else if (accion === 'pendiente') {
        o.estado = 'pendiente'; delete o.cargadoEn; delete o.cargadoPor; delete o.agregadoEn; delete o.cargadoItems; delete o.sumar; o.agregar = false;
        for (const i of o.items) delete i.cantCargada;
      } else if (accion === 'sumarListo') delete o.sumar;
      else throw { code: 400, msg: 'Acción inválida' };
      await save(pool);
      return send(res, 200, o);
    }

    if (rec === 'entrega' && req.method === 'PUT') {   // el administrador marca varios pedidos cargados: entregado / con devoluciones / rechazado (con motivo) / nota de crédito
      soloAdmin();
      const b = await body(req, 1e5), accion = b.accion, m = String(b.motivo || '').trim().slice(0, 300);
      const ids = new Set((id ? [id] : Array.isArray(b.ids) ? b.ids : []).map(Number));
      const lista = s.pedidos.filter(o => ids.has(o.id));
      if (!lista.length) throw { code: 404, msg: 'No existen esos pedidos' };
      const numero = String(b.numero || '').trim().slice(0, 40), monto = num(b.monto, 0), ahora = new Date().toISOString();
      if (!['reparto', 'entregado', 'devoluciones', 'rechazado', 'limpiar', 'credito', 'quitarCredito'].includes(accion)) throw { code: 400, msg: 'Acción inválida' };
      if (['reparto', 'entregado', 'devoluciones', 'rechazado', 'credito'].includes(accion) && lista.some(o => o.estado !== 'cargado')) throw { code: 400, msg: 'Solo se pueden marcar pedidos ya cargados' };
      if ((accion === 'devoluciones' || accion === 'rechazado') && !m) throw { code: 400, msg: 'Indicá el motivo' };
      if (accion === 'credito' && !numero && !(monto > 0)) throw { code: 400, msg: 'Indicá el número o el importe de la nota de crédito' };
      for (const o of lista) {
        if (accion === 'credito') o.notaCredito = { numero: numero || (o.notaCredito && o.notaCredito.numero) || '', monto: monto > 0 ? monto : undefined, por: yo.nombre, en: ahora };
        else if (accion === 'quitarCredito') delete o.notaCredito;
        else if (accion === 'limpiar') { delete o.entrega; reponerStock(o, false); }
        else { delete o.sumar; o.entrega = { estado: accion, motivo: accion === 'entregado' ? '' : m, por: yo.nombre, en: ahora }; reponerStock(o, accion === 'rechazado'); }
      }
      await save(pool);
      return send(res, 200, { ok: true, n: lista.length });
    }

    if (rec === 'copias' && req.method === 'GET') { soloAdmin(); return send(res, 200, { copias: await listarCopias(pool) }); }
    if (rec === 'restaurar' && req.method === 'POST') {   // el administrador restaura una copia (de un archivo o de las automáticas); usuarios y contraseñas no se tocan
      soloAdmin();
      const b = await body(req, 30e6);
      const datos = b.origen === 'copia' ? await leerCopia(pool, String(b.fecha || '')) : b.datos;
      if (!datos || typeof datos !== 'object') throw { code: 404, msg: 'No se encontró la copia' };
      const antes = { pedidos: s.pedidos.length, clientes: s.clientes.length, productos: s.productos.length };
      const copiaDatos = JSON.parse(JSON.stringify(datos));
      for (const k of ['productos', 'pedidos', 'clientes']) if (!Array.isArray(copiaDatos[k])) throw { code: 400, msg: 'El archivo no es una copia válida (falta ' + k + ')' };
      const respaldoPrevio = await copiaPrevia(pool);
      restaurarDatos(copiaDatos);
      await save(pool);
      return send(res, 200, { ok: true, antes, ahora: { pedidos: s.pedidos.length, clientes: s.clientes.length, productos: s.productos.length }, copiaPrevia: respaldoPrevio });
    }
    if (rec === 'respaldo' && req.method === 'GET') {   // el administrador descarga todos los datos (sin contraseñas ni claves)
      soloAdmin();
      return send(res, 200, { fecha: new Date().toISOString(), version: 1, productos: s.productos, pedidos: s.pedidos, clientes: s.clientes, combos: s.combos, novedades: s.novedades, seq: s.seq, configPorCodigo: s.configPorCodigo || {}, usuarios: s.usuarios.map(pub) });
    }
    if (rec === 'pushkey' && req.method === 'GET') return send(res, 200, { key: webpush && s.vapid ? s.vapid.publica : null });
    if (rec === 'pushsub') {   // el dispositivo se suscribe / se da de baja para recibir notificaciones
      const b = await body(req, 1e4), sub = b.subscription || {}, ep = String(b.endpoint || sub.endpoint || '');
      if (!ep) throw { code: 400, msg: 'Falta la suscripción' };
      s.pushSubs = s.pushSubs.filter(x => x.sub.endpoint !== ep);
      if (req.method === 'POST') {
        if (!sub.keys || !sub.endpoint) throw { code: 400, msg: 'Suscripción inválida' };
        s.pushSubs.push({ u: yo.id, sub: { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } }, en: new Date().toISOString() });
      } else if (req.method !== 'DELETE') throw { code: 405, msg: 'Método no permitido' };
      await save(pool);
      return send(res, 200, { ok: true });
    }
    if (rec === 'novedades' || rec === 'novedadleida') {   // novedades: las escribe el administrador y las ven los vendedores (todos o uno)
      const visibleN = n => admin || n.para === 'todos' || n.para === yo.id;
      const paraMi = n => admin ? n : { id: n.id, titulo: n.titulo, texto: n.texto, para: n.para, fija: !!n.fija, creado: n.creado, editado: n.editado, por: n.por, leida: !!(n.leidas || {})[yo.id] };
      if (rec === 'novedadleida' && req.method === 'PUT') {
        const n = s.novedades.find(x => x.id === id && visibleN(x));
        if (!n) throw { code: 404, msg: 'No existe' };
        n.leidas = { ...(n.leidas || {}), [yo.id]: new Date().toISOString() };
        await save(pool);
        return send(res, 200, { ok: true });
      }
      if (!id && req.method === 'GET') return send(res, 200, { novedades: [...s.novedades].filter(visibleN).reverse().map(paraMi) });
      soloAdmin();
      const limpiar = (b, prev) => {
        const titulo = String(b.titulo ?? prev?.titulo ?? '').trim().slice(0, 80), texto = String(b.texto ?? prev?.texto ?? '').trim().slice(0, 2000);
        if (!texto) throw { code: 400, msg: 'Escribí la novedad' };
        const para = b.para === undefined ? prev?.para ?? 'todos' : b.para === 'todos' ? 'todos' : Number(b.para);
        if (para !== 'todos' && !s.usuarios.some(u => u.id === para && u.rol === 'vendedor')) throw { code: 400, msg: 'Elegí a quién va dirigida' };
        return { titulo, texto, para, fija: b.fija === undefined ? !!prev?.fija : !!b.fija };
      };
      if (!id && req.method === 'POST') {
        const n = { id: s.seq.n++, ...limpiar(await body(req, 1e5)), creado: new Date().toISOString(), por: yo.nombre, leidas: {} };
        s.novedades.push(n); await save(pool);
        notificar(n.para === 'todos' ? s.usuarios.filter(u => u.rol === 'vendedor').map(u => u.id) : [n.para], { titulo: '📣 Novedad · Distribuidora Don Luis', cuerpo: n.texto.slice(0, 140), tag: 'novedad-' + n.id }, pool);
        return send(res, 200, n);
      }
      const n = s.novedades.find(x => x.id === id);
      if (!n) throw { code: 404, msg: 'No existe' };
      if (req.method === 'PUT') { Object.assign(n, limpiar(await body(req, 1e5), n), { editado: new Date().toISOString(), leidas: {} }); await save(pool); notificar(n.para === 'todos' ? s.usuarios.filter(u => u.rol === 'vendedor').map(u => u.id) : [n.para], { titulo: '📣 Novedad actualizada · Distribuidora Don Luis', cuerpo: n.texto.slice(0, 140), tag: 'novedad-' + n.id }, pool); return send(res, 200, n); }   // al editarla vuelve a figurar como nueva
      if (req.method === 'DELETE') { s.novedades.splice(s.novedades.indexOf(n), 1); await save(pool); return send(res, 200, { ok: true }); }
      throw { code: 405, msg: 'Método no permitido' };
    }

    if (rec !== 'productos' && rec !== 'pedidos') throw { code: 404, msg: 'No encontrado' };
    const list = s[rec];
    // el vendedor solo ve y toca sus propios pedidos
    const visible = x => rec !== 'pedidos' || admin || x.vendedorId === yo.id;
    if (!id && req.method === 'GET') {
      const l = list.filter(visible);
      return send(res, 200, { [rec]: rec === 'pedidos' ? [...l].reverse() : l });
    }
    if (rec === 'productos' && req.method !== 'GET') soloAdmin();
    if (!id && req.method === 'POST') {
      const b = await body(req);
      let obj;
      if (rec === 'productos') {
        obj = cleanProducto(b);
        if (list.some(p => p.codigo.toLowerCase() === obj.codigo.toLowerCase())) throw { code: 409, msg: 'Ya existe un producto con ese código' };
        obj.id = s.seq.p++;
      } else {
        const uid = String(b.uid || '').slice(0, 64);
        const dup = uid && list.find(x => x.uid === uid && x.vendedorId === yo.id);
        if (dup) return send(res, 200, dup);   // reenvío de un pedido que ya había llegado
        obj = armarPedido(b, null, yo, admin);
        if (uid) obj.uid = uid;
        obj.id = s.seq.o++;
        obj.estado = 'pendiente';
        obj.creado = obj.editado = new Date().toISOString();
        ajustarStock(null, obj);
      }
      list.push(obj);
      if (rec === 'productos') restaurarProducto(obj);
      await save(pool);
      return send(res, 200, obj);
    }
    const idx = list.findIndex(x => x.id === id && visible(x));
    if (idx < 0) return send(res, 404, { error: 'No existe' });
    if (req.method === 'GET') return send(res, 200, list[idx]);
    if (rec === 'pedidos' && !admin && list[idx].entrega && req.method !== 'GET') throw { code: 403, msg: 'El pedido ya fue cerrado por administración (en reparto, entregado, con devoluciones o rechazado)' };
    if (req.method === 'PUT') {
      const b = await body(req); let antesAgregado;
      if (rec === 'productos') {
        const obj = cleanProducto(b, list[idx]);
        if (list.some(p => p.id !== id && p.codigo.toLowerCase() === obj.codigo.toLowerCase())) throw { code: 409, msg: 'Ya existe un producto con ese código' };
        list[idx] = { ...list[idx], ...obj };
      } else {
        const antes = list[idx]; antesAgregado = antes.agregadoEn;
        list[idx] = { ...antes, ...armarPedido(b, antes, yo, admin), editado: new Date().toISOString() };
        ajustarStock(antes, list[idx]);
      }
      await save(pool);
      const n = list[idx];
      if (rec === 'pedidos' && !admin && n.estado === 'cargado' && n.agregar && n.agregadoEn !== antesAgregado) {   // el vendedor modificó un pedido ya cargado: se avisa a los administradores
        notificar(adminsActivos().map(u => u.id), { titulo: '⚠️ Pedido modificado · Distribuidora Don Luis', cuerpo: `${yo.nombre} modificó el pedido #${n.id} (${n.cliente}), que ya estaba cargado`, tag: 'agregar-' + n.id }, pool);
      }
      return send(res, 200, n);
    }
    if (req.method === 'DELETE') {
      if (rec === 'pedidos' && !admin && list[idx].estado === 'cargado') throw { code: 403, msg: 'El pedido ya fue cargado por administración' };
      if (rec === 'productos') quitarProductos(new Set([list[idx].id])); else { ajustarStock(list[idx], null); list.splice(idx, 1); }   // el producto se borra pero su promo queda guardada por código
      await save(pool);
      return send(res, 200, { ok: true });
    }
    send(res, 405, { error: 'Método no permitido' });
  } catch (e) {
    if (e && e.code) return send(res, e.code, { error: e.msg });
    throw e;
  }
};
