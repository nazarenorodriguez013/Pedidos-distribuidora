// API de la app de pedidos: productos (precio, stock, promos, activo) y pedidos.
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
  if (!state.usuarios.length) {   // primer arranque: el administrador sale de APP_USER / APP_PASS
    state.usuarios.push({ id: state.seq.u++, usuario: process.env.APP_USER || 'kevin', nombre: 'Administrador', rol: 'admin', activo: true, ...hashPass(process.env.APP_PASS || 'kevin123') });
    await save(pool);
  }
  return state;
}
function save(pool) {
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
const precioDe = p => (p.promo && p.precioPromo > 0 ? p.precioPromo : p.precio);

function cleanProducto(b, prev = {}) {
  const nombre = String(b.nombre ?? prev.nombre ?? '').trim();
  const codigo = String(b.codigo ?? prev.codigo ?? '').trim();
  if (!nombre) throw { code: 400, msg: 'Falta el nombre' };
  if (!codigo) throw { code: 400, msg: 'Falta el código' };
  return {
    codigo, nombre,
    precio: num(b.precio, prev.precio ?? 0),
    stock: Math.floor(num(b.stock, prev.stock ?? 0)),
    activo: b.activo === undefined ? prev.activo ?? true : !!b.activo,
    promo: b.promo === undefined ? prev.promo ?? false : !!b.promo,
    precioPromo: num(b.precioPromo, prev.precioPromo ?? 0),
  };
}

// Aplica un pedido nuevo/editado: valida stock y arma las líneas con su precio.
function armarPedido(b, viejo, quien) {
  const cliente = String(b.cliente || '').trim();
  if (!cliente) throw { code: 400, msg: 'Falta el cliente' };
  const viejas = new Map((viejo ? viejo.items : []).map(i => [i.pid, i]));
  const nuevas = new Map();
  for (const it of Array.isArray(b.items) ? b.items : []) {
    const cant = Math.floor(num(it.cant));
    if (cant > 0) nuevas.set(Number(it.pid), (nuevas.get(Number(it.pid)) || 0) + cant);
  }
  if (!nuevas.size) throw { code: 400, msg: 'El pedido no tiene productos' };
  const items = [];
  const deltas = [];
  for (const [pid, cant] of nuevas) {
    const p = state.productos.find(x => x.id === pid);
    const old = viejas.get(pid);
    if (!p) throw { code: 400, msg: 'Producto inexistente' };
    if (!old && !p.activo) throw { code: 409, msg: `"${p.nombre}" está desactivado` };
    const delta = cant - (old ? old.cant : 0);
    if (delta > p.stock) throw { code: 409, msg: `Stock insuficiente de "${p.nombre}" (hay ${p.stock + (old ? old.cant : 0)})` };
    deltas.push([p, delta]);
    items.push({ pid, codigo: p.codigo, nombre: p.nombre, precio: old ? old.precio : precioDe(p), cant });
  }
  for (const [pid, old] of viejas) if (!nuevas.has(pid)) { const p = state.productos.find(x => x.id === pid); if (p) deltas.push([p, -old.cant]); }
  for (const [p, d] of deltas) p.stock -= d;
  const total = Math.round(items.reduce((s, i) => s + i.precio * i.cant, 0) * 100) / 100;
  return { cliente, nota: String(b.nota || '').trim(), items, total, vendedorId: viejo ? viejo.vendedorId : quien.id, vendedor: viejo ? viejo.vendedor : quien.nombre };
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
    Object.assign(o, hashPass(b.password));
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
    const stock = f.stock === undefined || f.stock === '' ? null : parseNum(f.stock);
    if (f.precio !== undefined && f.precio !== '' && precio === null) return r.errores.push(`Fila ${fila} (${codigo}): precio inválido`);
    if (f.stock !== undefined && f.stock !== '' && stock === null) return r.errores.push(`Fila ${fila} (${codigo}): stock inválido`);
    let p = state.productos.find(x => x.codigo.toLowerCase() === codigo.toLowerCase());
    vistos.add(codigo.toLowerCase());
    if (!p) {
      const nombre = String(f.nombre ?? '').trim();
      if (!nombre || precio === null) return r.errores.push(`Fila ${fila} (${codigo}): producto nuevo necesita nombre y precio`);
      state.productos.push({ id: state.seq.p++, codigo, nombre, precio, stock: Math.floor(stock ?? 0), activo: true, promo: false, precioPromo: 0 });
      return r.creados++;
    }
    if (String(f.nombre ?? '').trim()) p.nombre = String(f.nombre).trim();
    if (precio !== null) p.precio = precio;
    if (stock !== null) p.stock = Math.floor(stock);
    if (f.activo !== undefined && f.activo !== '') p.activo = truthy(f.activo);
    else if (b.catalogoCompleto) p.activo = true;
    r.actualizados++;
  });
  if (b.catalogoCompleto) for (const p of state.productos) if (p.activo && !vistos.has(p.codigo.toLowerCase())) { p.activo = false; r.desactivados++; }
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
      if (!u || !u.activo || !passOk(u, b.pass || '')) { fallos.set(usuario, [...f, ahora]); throw { code: 401, msg: 'Usuario o contraseña incorrectos' }; }
      fallos.delete(usuario);
      return send(res, 200, { token: makeToken(u, secret), user: pub(u) });
    }
    const yo = userFromToken(req.headers.authorization, secret);
    if (!yo) throw { code: 401, msg: 'No autorizado' };
    const admin = yo.rol === 'admin';
    const soloAdmin = () => { if (!admin) throw { code: 403, msg: 'Solo el administrador puede hacer esto' }; };

    if (rec === 'yo' && req.method === 'GET') return send(res, 200, pub(yo));
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

    if (rec === 'usuarios') {
      soloAdmin();
      if (!id && req.method === 'GET') return send(res, 200, { usuarios: s.usuarios.map(pub) });
      if (!id && req.method === 'POST') {
        const u = { id: s.seq.u++, ...cleanUsuario(await body(req, 1e4)) };
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
        if (u.rol === 'admin' && u.activo && adminsActivos().length === 1) throw { code: 409, msg: 'Tiene que quedar al menos un administrador' };
        s.usuarios.splice(s.usuarios.indexOf(u), 1); await save(pool);
        return send(res, 200, { ok: true });
      }
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
        obj = armarPedido(b, null, yo);
        obj.id = s.seq.o++;
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
        list[idx] = { ...list[idx], ...armarPedido(b, list[idx], yo), editado: new Date().toISOString() };
      }
      await save(pool);
      return send(res, 200, list[idx]);
    }
    if (req.method === 'DELETE') {
      if (rec === 'pedidos') for (const i of list[idx].items) { const p = s.productos.find(x => x.id === i.pid); if (p) p.stock += i.cant; }
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
