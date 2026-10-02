// API de la app de pedidos: productos (precio, promos, activo) y pedidos.
// Guarda todo en Postgres (tabla kv) si hay base; si no, en data/pedidos.json.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

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
  state.seq.k = state.seq.k || 1;
  for (const c of state.combos) if (c.tipo === 'precio' && !c.precios) { c.precios = {}; for (const g of c.grupos) for (const pid of g.pids) c.precios[pid] = c.precio; delete c.precio; }
  for (const o of state.pedidos) if (o.clienteId && o.clienteCodigo === undefined) { const c = state.clientes.find(x => x.id === o.clienteId); if (c) o.clienteCodigo = c.codigo; }
  for (const c of state.clientes) if (c.apellido) { c.nombre = [c.nombre, c.apellido].filter(Boolean).join(' '); c.apellido = ''; }   // un solo campo: nombre y apellido
  for (const p of state.productos) { delete p.stock; if (p.multiplo > 1 && p.multiploSet === undefined) p.multiploSet = true; }   // ya no se maneja stock
  for (const o of state.pedidos) if (o.subtotal === undefined) {   // pedidos anteriores al redondeo: se les aplica solo
    o.subtotal = o.total; o.total = redondear(o.subtotal); o.redondeo = Math.round((o.total - o.subtotal) * 100) / 100;
  }
  if (!state.usuarios.length) {   // primer arranque: el administrador sale de APP_USER / APP_PASS
    state.usuarios.push({ id: state.seq.u++, usuario: process.env.APP_USER || 'kevin', nombre: 'Administrador', rol: 'admin', activo: true, ...hashPass(process.env.APP_PASS || 'kevin123') });
    await save(pool);
  }
  return state;
}
// Los pedidos pendientes siguen los precios y promos vigentes; al cargarlos (estado 'cargado') quedan con el precio de ese momento.
function totalesDe(items) {
  const subtotal = Math.round(items.reduce((t, i) => t + i.precio * i.cant, 0) * 100) / 100, total = redondear(subtotal);
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
    Object.assign(o, totalesDe(o.items));
  }
}
function save(pool) {
  repreciarPendientes();
  const json = JSON.stringify(state);
  queue = queue.then(async () => {
    if (pool) await pool.query("INSERT INTO kv (key, value) VALUES ('pedidos', $1) ON CONFLICT (key) DO UPDATE SET value=$1", [json]);
    else { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, json); }
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
// Promos: precio fijo (precioPromo) o descuento % (promoPct). Con promoCant > 1 solo aplica comprando esa cantidad o más
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
  };
}

// Promos combinadas: la promo pide una cantidad por grupo de productos (un grupo puede ser un solo producto o varios "de cualquier sabor").
// Si el pedido cumple todos los grupos y el vendedor la acepta, cada unidad de los productos de la promo va con descuento % o con precio fijo.
const sumaGrupo = (g, cant) => g.pids.reduce((t, pid) => t + (cant.get(pid) || 0), 0);
const comboCumple = (c, cant) => c.activa && c.grupos.every(g => sumaGrupo(g, cant) >= g.cant);
const comboIncluye = (c, pid) => c.grupos.some(g => g.pids.includes(pid));
const precioComboDe = (c, p) => (c.tipo === 'precio' ? (c.precios || {})[p.id] || p.precio : Math.round(p.precio * (100 - c.pct)) / 100);   // 'precio': cada producto tiene el suyo
function cleanCombo(b) {
  const nombre = String(b.nombre || '').trim();
  if (!nombre) throw { code: 400, msg: 'Falta el nombre de la promo' };
  const grupos = (Array.isArray(b.grupos) ? b.grupos : []).map(g => ({ cant: Math.floor(num(g.cant)), pids: [...new Set((Array.isArray(g.pids) ? g.pids : []).map(Number))] }));
  if (!grupos.length) throw { code: 400, msg: 'Agregá al menos un grupo de productos' };
  for (const g of grupos) {
    if (!(g.cant >= 1)) throw { code: 400, msg: 'Cada grupo necesita una cantidad de 1 o más' };
    if (!g.pids.length || g.pids.some(pid => !state.productos.some(p => p.id === pid))) throw { code: 400, msg: 'Cada grupo necesita al menos un producto' };
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
  return { nombre, activa: b.activa === undefined ? true : !!b.activa, grupos, tipo, pct: tipo === 'pct' ? pct : 0, precios };
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
    o.codigo = prev ? prev.codigo : '';
    o.vendedorId = prev ? prev.vendedorId : yo.id;
  }
  return o;
}

// Arma un pedido nuevo/editado con las líneas y su precio.
function armarPedido(b, viejo, quien, admin) {
  // una vez cargado el pedido, el vendedor ya no puede cambiar la nota
  const nota = !admin && viejo && viejo.estado === 'cargado' ? viejo.nota || '' : String(b.nota || '').trim();
  let cli = null;
  if (b.clienteId) {
    cli = state.clientes.find(c => c.id === Number(b.clienteId));
    if (!cli || (!admin && cli.vendedorId !== quien.id)) throw { code: 400, msg: 'Cliente inexistente' };
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
    if (!p) throw { code: 400, msg: 'Producto inexistente' };
    if (!old && !p.activo) throw { code: 409, msg: `"${p.nombre}" está desactivado` };
    const m = p.multiplo || 1;
    if (cant % m && !(old && old.cant === cant)) throw { code: 400, msg: `"${p.nombre}" tiene unidad de venta ${m}: la cantidad tiene que ser múltiplo de ${m}` };
    if (!old && !((hayPromo(p) && promoCantDe(p) <= 1 ? precioPromoDe(p) : p.precio) > 0)) throw { code: 409, msg: `"${p.nombre}" no tiene precio` };
    let aplica = hayPromo(p) && promoCantDe(p) <= 1;   // promo sin cantidad: automática
    if (quierePromo.get(pid)) {   // promo por cantidad aceptada por el vendedor
      if (!hayPromo(p) || promoCantDe(p) <= 1 || cant < promoCantDe(p)) throw { code: 409, msg: `La promo de "${p.nombre}" no aplica (hay que llevar ${promoCantDe(p)} o más)` };
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
  // Pedido ya cargado por administración: si lo edita el vendedor queda marcado "agregar" para que el admin lo vea
  let extra = {};
  if (viejo && viejo.estado === 'cargado') {
    for (const i of items) { const o = viejas.get(i.pid); i.cantCargada = admin ? i.cant : (o ? o.cantCargada ?? o.cant : 0); }
    if (admin) extra = { agregar: false, agregadoEn: undefined, cargadoItems: items.map(i => ({ pid: i.pid, nombre: i.nombre, cant: i.cant })) };   // lo que edita el admin queda como cargado
    else {
      const igual = items.length === viejo.items.length && items.every(i => { const o = viejas.get(i.pid); return o && o.cant === i.cant && !!o.promo === !!i.promo && o.comboId === i.comboId; })
        && (dia || '') === (viejo.dia || '') && (turno || '') === (viejo.turno || '') && nota === (viejo.nota || '') && (cli ? cli.id : undefined) === viejo.clienteId;
      if (!igual) extra = { agregar: true, agregadoEn: new Date().toISOString() };
    }
  }
  const { subtotal, redondeo, total } = totalesDe(items);
  return { ...extra, cliente, clienteCodigo: cli ? cli.codigo : viejo ? viejo.clienteCodigo : undefined, nota, items, subtotal, redondeo, total, clienteId: cli ? cli.id : undefined, dia: dia || undefined, turno: turno || undefined, vendedorId: vend ? vend.id : viejo ? viejo.vendedorId : quien.id, vendedor: vend ? vend.nombre : viejo ? viejo.vendedor : quien.nombre };
}

// ---- sesiones: token firmado con el usuario; el rol se lee de la base en cada pedido ----
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const makeToken = (u, secret) => { const p = b64({ u: u.id, exp: Date.now() + 30 * 864e5 }); return p + '.' + crypto.createHmac('sha256', secret).update(p).digest('hex'); };
function userFromToken(h, secret) {
  const [p, sig] = String(h || '').replace(/^Bearer /, '').split('.');
  if (!p || !sig) return null;
  const ok = crypto.createHmac('sha256', secret).update(p).digest('hex');
  if (ok.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(ok), Buffer.from(sig))) return null;
  try {
    const d = JSON.parse(Buffer.from(p, 'base64url').toString());
    const u = state.usuarios.find(x => x.id === d.u);
    return d.exp > Date.now() && u && u.activo ? u : null;
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
const adminsActivos = () => state.usuarios.filter(u => u.rol === 'admin' && u.activo);

function importar(b) {
  const filas = Array.isArray(b.rows) ? b.rows : [];
  const r = { creados: 0, actualizados: 0, desactivados: 0, errores: [] };
  const vistos = new Set();
  filas.forEach((f, n) => {
    const codigo = String(f.codigo ?? '').trim();
    const fila = n + 1;
    if (!codigo) return r.errores.push(`Fila ${fila}: sin código`);
    const precio = f.precio === undefined || f.precio === '' ? null : parseNum(f.precio);
    if (f.precio !== undefined && f.precio !== '' && precio === null) return r.errores.push(`Fila ${fila} (${codigo}): precio inválido`);
    let p = state.productos.find(x => x.codigo.toLowerCase() === codigo.toLowerCase());
    const mult = f.multiplo === undefined || f.multiplo === '' ? null : parseNum(f.multiplo);
    if (f.multiplo !== undefined && f.multiplo !== '' && !(mult >= 1)) return r.errores.push(`Fila ${fila} (${codigo}): unidad de venta inválida`);
    const sinPrecio = precio === 0 && (f.activo === undefined || f.activo === '');   // precio 0 = sin precio: queda desactivado
    vistos.add(codigo.toLowerCase());
    if (!p) {
      const nombre = String(f.nombre ?? '').trim();
      if (!nombre || precio === null) return r.errores.push(`Fila ${fila} (${codigo}): producto nuevo necesita nombre y precio`);
      state.productos.push({ id: state.seq.p++, codigo, nombre, precio, multiplo: mult ? Math.floor(mult) : 1, multiploSet: !!mult, activo: f.activo === undefined || f.activo === '' ? !sinPrecio : truthy(f.activo), promo: false, precioPromo: 0 });
      return r.creados++;
    }
    if (String(f.nombre ?? '').trim()) p.nombre = String(f.nombre).trim();
    if (precio !== null && !sinPrecio) p.precio = precio;
    if (mult && !p.multiploSet) { p.multiplo = Math.floor(mult); p.multiploSet = true; }   // la unidad de venta solo se carga si todavía no estaba definida
    if (sinPrecio) p.activo = false;
    if (f.activo !== undefined && f.activo !== '') p.activo = truthy(f.activo);
    else if (b.catalogoCompleto && !sinPrecio) p.activo = true;
    r.actualizados++;
  });
  if (b.catalogoCompleto) for (const p of state.productos) if (p.activo && !vistos.has(p.codigo.toLowerCase())) { p.activo = false; r.desactivados++; }
  return r;
}

function importarClientes(b, quien) {
  const marca = { editadoEn: new Date().toISOString(), editadoPor: quien.nombre };   // última edición y quién
  const r = { creados: 0, actualizados: 0, errores: [] };
  const porDefecto = state.usuarios.find(u => u.id === Number(b.vendedorId));
  (Array.isArray(b.rows) ? b.rows : []).forEach((f, n) => {
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
    const codigo = t('codigo');
    const c = codigo && state.clientes.find(x => x.codigo.toLowerCase() === codigo.toLowerCase());
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
      const f = (fallos.get(usuario) || []).filter(t => ahora - t < 10 * 60 * 1000);
      if (f.length >= 10) throw { code: 429, msg: 'Demasiados intentos. Probá en unos minutos.' };
      const u = s.usuarios.find(x => x.usuario === usuario);
      const clave = String(b.pass || '');
      if (!u || !u.activo || !(passOk(u, clave) || passOk(u, clave.trim()))) {
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
      return send(res, 200, { ok: true });
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
      if (!id && req.method === 'GET') return send(res, 200, { combos: s.combos });
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
        o.estado = 'cargado'; o.cargadoPor = yo.nombre; o.agregar = false;
        for (const i of o.items) i.cantCargada = i.cant;
        o.cargadoItems = o.items.map(i => ({ pid: i.pid, nombre: i.nombre, cant: i.cant }));
        delete o.agregadoEn;
      } else if (accion === 'pendiente') {
        o.estado = 'pendiente'; delete o.cargadoEn; delete o.cargadoPor; delete o.agregadoEn; delete o.cargadoItems; o.agregar = false;
        for (const i of o.items) delete i.cantCargada;
      } else throw { code: 400, msg: 'Acción inválida' };
      await save(pool);
      return send(res, 200, o);
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
      }
      list.push(obj);
      await save(pool);
      return send(res, 200, obj);
    }
    const idx = list.findIndex(x => x.id === id && visible(x));
    if (idx < 0) return send(res, 404, { error: 'No existe' });
    if (req.method === 'GET') return send(res, 200, list[idx]);
    if (req.method === 'PUT') {
      const b = await body(req);
      if (rec === 'productos') {
        const obj = cleanProducto(b, list[idx]);
        if (list.some(p => p.id !== id && p.codigo.toLowerCase() === obj.codigo.toLowerCase())) throw { code: 409, msg: 'Ya existe un producto con ese código' };
        list[idx] = { ...list[idx], ...obj };
      } else {
        list[idx] = { ...list[idx], ...armarPedido(b, list[idx], yo, admin), editado: new Date().toISOString() };
      }
      await save(pool);
      return send(res, 200, list[idx]);
    }
    if (req.method === 'DELETE') {
      if (rec === 'pedidos' && !admin && list[idx].estado === 'cargado') throw { code: 403, msg: 'El pedido ya fue cargado por administración' };
      list.splice(idx, 1);
      await save(pool);
      return send(res, 200, { ok: true });
    }
    send(res, 405, { error: 'Método no permitido' });
  } catch (e) {
    if (e && e.code) return send(res, e.code, { error: e.msg });
    throw e;
  }
};
