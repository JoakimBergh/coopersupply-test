require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const catalog = require('./catalog-data.json');

const APP_VERSION = 'ZV8.3';
const app = express();
const PORT = process.env.PORT || 3001;
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const KLARNA_ENV = String(process.env.KLARNA_ENV || 'playground').toLowerCase() === 'production' ? 'production' : 'playground';
const KLARNA_USERNAME = process.env.KLARNA_USERNAME || '';
const KLARNA_PASSWORD = process.env.KLARNA_PASSWORD || '';
const SHIPPING_CENTS = Math.max(0, Number(process.env.COOPER_SHIPPING_CENTS || 0));
const VAT_RATE = Math.max(0, Number(process.env.COOPER_VAT_RATE || 0.25));
const KLARNA_API_BASE = KLARNA_ENV === 'production' ? 'https://api.klarna.com' : 'https://api.playground.klarna.com';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_API_BASE = 'https://api.stripe.com/v1';
const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
fs.mkdirSync(DB_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(DB_DIR, 'cooper-supply.db'));
db.pragma('foreign_keys = ON');

const chassisGroups={G1:['R50','R52','R53'],G2:['R55','R56','R57'],G3:['R58','R59'],G4:['R60','R61']};
function chassisGroupForChassis(chassis){const c=String(chassis||'').toUpperCase();return Object.entries(chassisGroups).find(([,list])=>list.includes(c))?.[0]||null;}

db.exec(`
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chassis TEXT NOT NULL UNIQUE,
  model TEXT NOT NULL,
  generation TEXT,
  body_type TEXT,
  year_from INTEGER,
  year_to INTEGER,
  market TEXT NOT NULL DEFAULT 'EU'
);
CREATE TABLE IF NOT EXISTS engines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT UNIQUE,
  model TEXT,
  year_from INTEGER,
  year_to INTEGER,
  variant TEXT,
  name TEXT NOT NULL,
  engine_code TEXT,
  displacement_cc INTEGER,
  fuel TEXT,
  factory_hp INTEGER,
  transmissions_json TEXT,
  drivetrain_json TEXT,
  transmission_rules_json TEXT,
  drivetrain_rules_json TEXT,
  power_rules_json TEXT,
  market TEXT NOT NULL DEFAULT 'EU'
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  brand TEXT,
  category_id INTEGER NOT NULL,
  subcategory TEXT,
  price_cents INTEGER,
  sale_price_cents INTEGER,
  description TEXT,
  material TEXT,
  finish TEXT,
  included_items TEXT,
  installation TEXT,
  warranty TEXT,
  manufacturer_part_number TEXT,
  chassis_group TEXT,
  slug TEXT,
  status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate','verification','verified','active','discontinued','archived')),
  stock_status TEXT NOT NULL DEFAULT 'external_stock' CHECK(stock_status IN ('own_stock','external_stock','out_of_stock')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(category_id) REFERENCES categories(id)
);
CREATE TABLE IF NOT EXISTS fitments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  vehicle_id INTEGER NOT NULL,
  year_from INTEGER,
  year_to INTEGER,
  engine_id INTEGER,
  gearbox TEXT,
  drivetrain TEXT,
  facelift_rule TEXT NOT NULL DEFAULT 'all',
  facelift_year INTEGER,
  facelift_compare TEXT NOT NULL DEFAULT 'all',
  notes TEXT,
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY(vehicle_id) REFERENCES vehicles(id),
  FOREIGN KEY(engine_id) REFERENCES engines(id)
);
CREATE TABLE IF NOT EXISTS market_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  source_name TEXT NOT NULL,
  source_url TEXT,
  price_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'NOK',
  shipping_cents INTEGER,
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS product_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS sku_counters (
  prefix TEXT PRIMARY KEY,
  next_number INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  payment_provider TEXT,
  payment_status TEXT,
  provider_order_id TEXT,
  customer_json TEXT NOT NULL,
  items_json TEXT NOT NULL,
  subtotal_cents INTEGER NOT NULL,
  shipping_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'NOK',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

// Lightweight migration for the original Z1 engine table.
const fitmentColumns = db.prepare('PRAGMA table_info(fitments)').all().map(c => c.name);
const fitmentMigrations = [['facelift_rule',"TEXT NOT NULL DEFAULT 'all'"],['facelift_year','INTEGER'],['facelift_compare',"TEXT NOT NULL DEFAULT 'all'"]];
for (const [name, type] of fitmentMigrations) {
  if (!fitmentColumns.includes(name)) db.exec(`ALTER TABLE fitments ADD COLUMN ${name} ${type}`);
}

// Existing Z1/Z2 databases may have required year_from/year_to. For Z2.4.2+,
// year fields are intentionally optional when a facelift/LCI rule defines the range.
const fitmentSchema = db.prepare('PRAGMA table_info(fitments)').all();
const yearFromCol = fitmentSchema.find(c => c.name === 'year_from');
const yearToCol = fitmentSchema.find(c => c.name === 'year_to');
if ((yearFromCol && Number(yearFromCol.notnull) === 1) || (yearToCol && Number(yearToCol.notnull) === 1)) {
  db.pragma('foreign_keys = OFF');
  db.exec(`
    BEGIN;
    ALTER TABLE fitments RENAME TO fitments__old_nullable_migration;
    CREATE TABLE fitments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      vehicle_id INTEGER NOT NULL,
      year_from INTEGER,
      year_to INTEGER,
      engine_id INTEGER,
      gearbox TEXT,
      drivetrain TEXT,
      facelift_rule TEXT NOT NULL DEFAULT 'all',
      facelift_year INTEGER,
      facelift_compare TEXT NOT NULL DEFAULT 'all',
      notes TEXT,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE,
      FOREIGN KEY(vehicle_id) REFERENCES vehicles(id),
      FOREIGN KEY(engine_id) REFERENCES engines(id)
    );
    INSERT INTO fitments (id,product_id,vehicle_id,year_from,year_to,engine_id,gearbox,drivetrain,facelift_rule,facelift_year,facelift_compare,notes)
      SELECT id,product_id,vehicle_id,year_from,year_to,engine_id,gearbox,drivetrain,facelift_rule,facelift_year,facelift_compare,notes
      FROM fitments__old_nullable_migration;
    DROP TABLE fitments__old_nullable_migration;
    COMMIT;
  `);
  db.pragma('foreign_keys = ON');
}

const engineColumns = db.prepare('PRAGMA table_info(engines)').all().map(c => c.name);
const engineMigrations = [
  ['source_id', 'TEXT'], ['model', 'TEXT'], ['year_from', 'INTEGER'], ['year_to', 'INTEGER'],
  ['variant', 'TEXT'], ['transmissions_json', 'TEXT'], ['drivetrain_json', 'TEXT'],
  ['transmission_rules_json', 'TEXT'], ['drivetrain_rules_json', 'TEXT'], ['power_rules_json', 'TEXT'],
  ['market', "TEXT NOT NULL DEFAULT 'EU'"]
];
for (const [name, type] of engineMigrations) {
  if (!engineColumns.includes(name)) db.exec(`ALTER TABLE engines ADD COLUMN ${name} ${type}`);
}

// ZV1.1 migration: optional sale price.
const productColumns = db.prepare('PRAGMA table_info(products)').all().map(c => c.name);
if (!productColumns.includes('sale_price_cents')) db.exec('ALTER TABLE products ADD COLUMN sale_price_cents INTEGER');
if (!productColumns.includes('chassis_group')) db.exec('ALTER TABLE products ADD COLUMN chassis_group TEXT');
if (!productColumns.includes('slug')) db.exec('ALTER TABLE products ADD COLUMN slug TEXT');
if (!productColumns.includes('stock_status')) db.exec("ALTER TABLE products ADD COLUMN stock_status TEXT NOT NULL DEFAULT 'external_stock'");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_products_slug ON products(slug) WHERE slug IS NOT NULL");
// ZV8: normalize stock status for databases created by earlier versions.
db.prepare("UPDATE products SET stock_status='external_stock' WHERE stock_status IS NULL OR stock_status=''").run();

// ZV1.3 status migration: legacy candidate products are now treated as Under verifisering.
// Storefront visibility is intentionally restricted to verified and active only.
db.prepare("UPDATE products SET status='verification' WHERE status='candidate'").run();
// ZV2 migration: lock every existing product to its chassis group and create stable slugs.
const existingProducts=db.prepare('SELECT id,name,chassis_group,slug FROM products').all();
const firstFitment=db.prepare('SELECT v.chassis FROM fitments f JOIN vehicles v ON v.id=f.vehicle_id WHERE f.product_id=? ORDER BY f.id LIMIT 1');
for(const p of existingProducts){ const ch=firstFitment.get(p.id)?.chassis; const group=chassisGroupForChassis(ch); const slug=p.slug||productSlug(p.name,p.id); db.prepare('UPDATE products SET chassis_group=?,slug=? WHERE id=?').run(group,slug,p.id); }

// ZV2.3 status cleanup: enforce the three supported product statuses in the database.
// Legacy statuses are migrated to Under verifisering before the CHECK constraint is tightened.
db.prepare("UPDATE products SET status='verification' WHERE status IN ('candidate','discontinued','archived')").run();
if (db.pragma('user_version', { simple: true }) < 230) {
  db.pragma('foreign_keys = OFF');
  // SQLite rewrites child-table foreign keys when a referenced table is renamed.
  // Keep the old name out of those FK definitions while we rebuild products.
  db.pragma('legacy_alter_table = ON');
  const productSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='products'").get()?.sql || '';
  if (productSchema.includes("'candidate'") || productSchema.includes("'discontinued'") || productSchema.includes("'archived'")) {
    const txStatus = db.transaction(() => {
      db.exec(`ALTER TABLE products RENAME TO products_legacy_zv23;
        CREATE TABLE products (
          id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL, brand TEXT, category_id INTEGER NOT NULL, subcategory TEXT, price_cents INTEGER, sale_price_cents INTEGER, description TEXT, material TEXT, finish TEXT, included_items TEXT, installation TEXT, warranty TEXT, manufacturer_part_number TEXT, chassis_group TEXT, slug TEXT, status TEXT NOT NULL DEFAULT 'verification' CHECK(status IN ('verification','verified','active')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(category_id) REFERENCES categories(id)
        );
        INSERT INTO products (id,sku,name,brand,category_id,subcategory,price_cents,sale_price_cents,description,material,finish,included_items,installation,warranty,manufacturer_part_number,chassis_group,slug,status,created_at,updated_at)
          SELECT id,sku,name,brand,category_id,subcategory,price_cents,sale_price_cents,description,material,finish,included_items,installation,warranty,manufacturer_part_number,chassis_group,slug,CASE WHEN status IN ('verified','active') THEN status ELSE 'verification' END,created_at,updated_at FROM products_legacy_zv23;
        DROP TABLE products_legacy_zv23;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_products_slug ON products(slug) WHERE slug IS NOT NULL;`);
    });
    txStatus();
  }
  db.pragma('legacy_alter_table = OFF');
  db.pragma('foreign_keys = ON');
  db.pragma('user_version = 230');
}

// Repair databases created by the first ZV2.3 migration. That migration could
// leave child tables pointing at the temporary products_legacy_zv23 table.
// Rebuild only affected child tables, preserving their data and restoring the
// intended FK target: products.
const legacyProductFkTables = ['fitments', 'market_prices', 'product_images'].filter(table => {
  const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all();
  return rows.some(r => String(r.table) === 'products_legacy_zv23');
});
if (legacyProductFkTables.length) {
  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = ON');
  const repairLegacyProductFks = db.transaction(() => {
    if (legacyProductFkTables.includes('fitments')) {
      db.exec(`CREATE TABLE fitments__zv23_repair (
        id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, vehicle_id INTEGER NOT NULL, year_from INTEGER, year_to INTEGER, engine_id INTEGER, gearbox TEXT, drivetrain TEXT, facelift_rule TEXT NOT NULL DEFAULT 'all', facelift_year INTEGER, facelift_compare TEXT NOT NULL DEFAULT 'all', notes TEXT,
        FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE, FOREIGN KEY(vehicle_id) REFERENCES vehicles(id), FOREIGN KEY(engine_id) REFERENCES engines(id)
      );
      INSERT INTO fitments__zv23_repair SELECT * FROM fitments;
      DROP TABLE fitments;
      ALTER TABLE fitments__zv23_repair RENAME TO fitments;`);
    }
    if (legacyProductFkTables.includes('market_prices')) {
      db.exec(`CREATE TABLE market_prices__zv23_repair (
        id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, source_name TEXT NOT NULL, source_url TEXT, price_cents INTEGER, currency TEXT NOT NULL DEFAULT 'NOK', shipping_cents INTEGER, checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
      );
      INSERT INTO market_prices__zv23_repair SELECT * FROM market_prices;
      DROP TABLE market_prices;
      ALTER TABLE market_prices__zv23_repair RENAME TO market_prices;`);
    }
    if (legacyProductFkTables.includes('product_images')) {
      db.exec(`CREATE TABLE product_images__zv23_repair (
        id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, filename TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
      );
      INSERT INTO product_images__zv23_repair SELECT * FROM product_images;
      DROP TABLE product_images;
      ALTER TABLE product_images__zv23_repair RENAME TO product_images;`);
    }
  });
  repairLegacyProductFks();
  db.pragma('legacy_alter_table = OFF');
  db.pragma('foreign_keys = ON');
}

// ZV8 migration must also cover databases rebuilt by the older ZV2.3 status migration.
const finalProductColumns = db.prepare('PRAGMA table_info(products)').all().map(c => c.name);
if (!finalProductColumns.includes('stock_status')) db.exec("ALTER TABLE products ADD COLUMN stock_status TEXT NOT NULL DEFAULT 'external_stock'");
db.prepare("UPDATE products SET stock_status='external_stock' WHERE stock_status IS NULL OR stock_status=''").run();

const categories = [
  ['EX','Exhaust'],['EXT','Exterior'],['IN','Intake'],['INT','Interior'],['LT','Lighting'],['WH','Wheels'],
  ['BR','Brakes'],['SU','Suspension'],['EN','Engine'],['EL','Electrical'],['BD','Body'],['AC','Accessories']
];
const insertCat = db.prepare('INSERT OR IGNORE INTO categories(code,name) VALUES (?,?)');
for (const c of categories) insertCat.run(...c);

// Seed the same EU vehicle/engine definitions used by the current V24.3 model selector.
const insertVehicle = db.prepare(`
  INSERT INTO vehicles(chassis,model,generation,body_type,year_from,year_to,market)
  VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(chassis) DO UPDATE SET
    model=excluded.model,generation=excluded.generation,body_type=excluded.body_type,
    year_from=excluded.year_from,year_to=excluded.year_to,market=excluded.market
`);
for (const m of catalog.models) {
  insertVehicle.run(m.code, m.name, m.generation, m.bodyStyle, m.years[0], m.years[1], m.market || 'EU');
}

const insertEngine = db.prepare(`
  INSERT INTO engines(
    source_id,model,year_from,year_to,variant,name,engine_code,displacement_cc,fuel,factory_hp,
    transmissions_json,drivetrain_json,transmission_rules_json,drivetrain_rules_json,power_rules_json,market
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(source_id) DO UPDATE SET
    model=excluded.model,year_from=excluded.year_from,year_to=excluded.year_to,variant=excluded.variant,
    name=excluded.name,engine_code=excluded.engine_code,displacement_cc=excluded.displacement_cc,
    fuel=excluded.fuel,factory_hp=excluded.factory_hp,transmissions_json=excluded.transmissions_json,
    drivetrain_json=excluded.drivetrain_json,transmission_rules_json=excluded.transmission_rules_json,
    drivetrain_rules_json=excluded.drivetrain_rules_json,power_rules_json=excluded.power_rules_json,market=excluded.market
`);
for (const e of catalog.engines) {
  if (e.model === 'R60' && e.variant === 'One') continue;
  const engineParts = String(e.engine || '').split(' · ');
  const engineCode = engineParts[0] || null;
  const displacement = (engineParts[1] || '').match(/([0-9.]+)/)?.[1];
  insertEngine.run(
    e.id, e.model, e.from, e.to, e.variant, e.engine || e.variant, engineCode,
    displacement ? Math.round(Number(displacement) * 1000) : null,
    e.fuel || null, e.power ?? null,
    JSON.stringify(e.transmissions || []), JSON.stringify(e.drivetrains || []),
    JSON.stringify(e.transmissionRules || []), JSON.stringify(e.drivetrainRules || []),
    JSON.stringify(e.powerRules || []), e.market || 'EU'
  );
}

// ZV8 demo catalogue seed: materialize the synthetic catalogue into the SQLite store
// so a fresh ZV8 install has real storefront/admin products instead of relying on the
// legacy static fallback. This only runs when the products table is empty.
function seedZV8DemoProducts(){
  const count = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
  if (Number(count) !== 0) return;
  const categoryRows = db.prepare('SELECT id,code FROM categories').all();
  const categoryMap = new Map(categoryRows.map(r => [r.code, r.id]));
  const vehicleRows = db.prepare('SELECT id,chassis FROM vehicles').all();
  const vehicleMap = new Map(vehicleRows.map(r => [r.chassis, r.id]));
  const engineRows = db.prepare('SELECT id,source_id,model,variant FROM engines').all();
  const engineMap = new Map(engineRows.map(r => [String(r.source_id), r.id]));
  const insertProduct = db.prepare(`INSERT INTO products
    (sku,name,brand,category_id,subcategory,price_cents,sale_price_cents,description,material,finish,included_items,installation,warranty,manufacturer_part_number,chassis_group,slug,status,stock_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertFitment = db.prepare(`INSERT INTO fitments
    (product_id,vehicle_id,year_from,year_to,engine_id,gearbox,drivetrain,facelift_rule,facelift_year,facelift_compare,notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const slugify = value => String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  const groupFor = chassis => {
    if(['R50','R52','R53'].includes(chassis)) return 'G1';
    if(['R55','R56','R57'].includes(chassis)) return 'G2';
    if(['R58','R59'].includes(chassis)) return 'G3';
    if(['R60','R61'].includes(chassis)) return 'G4';
    return null;
  };
  const priceFor = (categoryCode, index) => {
    const base = {EX:3490,EXT:1290,IN:1790,INT:990,LT:4990,WH:7990,BR:2490,SU:3990,EN:4490,EL:1490,BD:2990,AC:590}[categoryCode] || 1990;
    return base + ((index % 4) * 500);
  };
  const tx = db.transaction(() => {
    catalog.products.forEach((p, index) => {
      const categoryId = categoryMap.get(p.category);
      if (!categoryId) return;
      const firstModel = p.fitment?.[0] || p.model || '';
      const chassisGroup = groupFor(firstModel);
      const price = priceFor(p.category, index);
      const sale = index % 10 === 0 ? Math.max(490, price - 500) : null;
      const status = index % 7 === 0 ? 'active' : 'verified';
      const slug = `${slugify(p.name)}-${p.id}`;
      const product = insertProduct.run(
        p.sku, p.name, p.brand || 'Cooper Supply Demo', categoryId, p.subcategory || 'Testprodukt',
        price, sale,
        p.fitmentEvidence || 'Syntetisk demo-produkt for testing av Cooper Supply.',
        p.material || null, p.finish || null, p.included || null, p.installation || null,
        p.warranty || 'Demo', p.manufacturerPartNumber || null, chassisGroup, slug, status, 'external_stock'
      );
      const productId = product.lastInsertRowid;
      for (const rule of (p.fitmentRules || [])) {
        const models = rule.models?.length ? rule.models : (p.fitment || []);
        const gearboxes = rule.transmissions?.length && !rule.transmissions.includes('All') ? rule.transmissions : [null];
        const drivetrains = rule.drivetrains?.length && !rule.drivetrains.includes('All') ? rule.drivetrains : [null];
        for (const chassis of models) {
          const vehicleId = vehicleMap.get(chassis);
          if (!vehicleId) continue;
          for (const gearbox of gearboxes) for (const drivetrain of drivetrains) {
            insertFitment.run(productId, vehicleId, rule.yearFrom ?? null, rule.yearTo ?? null, null, gearbox, drivetrain, 'all', null, 'all', 'Syntetisk demo-fitment — ikke et ekte produkt.');
          }
        }
      }
    });
  });
  tx();
  console.log(`ZV8.3 demo catalogue seeded: ${db.prepare('SELECT COUNT(*) AS n FROM products').get().n} products`);
}
seedZV8DemoProducts();

function verifyStripeWebhookSignature(rawBody, signatureHeader){
  if(!STRIPE_WEBHOOK_SECRET) throw new Error('Stripe webhook secret er ikke konfigurert.');
  const header=String(signatureHeader||'');
  const parts={};
  for(const part of header.split(',')){ const i=part.indexOf('='); if(i>0) parts[part.slice(0,i)]=part.slice(i+1); }
  const timestamp=Number(parts.t);
  const signature=String(parts.v1||'');
  if(!Number.isFinite(timestamp)||!signature) throw new Error('Ugyldig Stripe-signatur.');
  if(Math.abs(Date.now()/1000-timestamp)>300) throw new Error('Stripe webhook-signaturen er utløpt.');
  const signedPayload=`${timestamp}.${rawBody.toString('utf8')}`;
  const expected=crypto.createHmac('sha256',STRIPE_WEBHOOK_SECRET).update(signedPayload).digest('hex');
  const a=Buffer.from(signature,'utf8'), b=Buffer.from(expected,'utf8');
  if(a.length!==b.length || !crypto.timingSafeEqual(a,b)) throw new Error('Stripe webhook-signaturen er ugyldig.');
}

function applyStripeSessionState(session,eventType=''){
  const orderNumber=String(session?.metadata?.order_number||session?.client_reference_id||'').trim();
  if(!orderNumber) return {updated:false,reason:'missing_order_number'};
  const o=db.prepare('SELECT id,order_number,status,payment_provider,payment_status,provider_order_id,total_cents,currency FROM orders WHERE order_number=?').get(orderNumber);
  if(!o) return {updated:false,reason:'order_not_found'};
  if(o.payment_provider!=='stripe') return {updated:false,reason:'provider_mismatch'};
  if(o.provider_order_id && o.provider_order_id!==session.id) return {updated:false,reason:'session_mismatch'};
  const amount=Number(session.amount_total), currency=String(session.currency||'').toUpperCase();
  if(!Number.isFinite(amount)||amount!==Number(o.total_cents)||currency!==String(o.currency||'NOK').toUpperCase()) return {updated:false,reason:'amount_or_currency_mismatch'};
  const paymentStatus=String(session.payment_status||'').toLowerCase();
  const eventStatus=String(session.status||'').toLowerCase();
  if(eventStatus==='expired' || eventType==='checkout.session.expired' || eventType==='checkout.session.async_payment_failed'){
    if(o.status!=='authorized') db.prepare('UPDATE orders SET provider_order_id=?,status=?,payment_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(session.id,'payment_failed','expired',o.id);
    return {updated:true,status:'payment_failed'};
  }
  if(paymentStatus==='paid'){
    db.prepare('UPDATE orders SET provider_order_id=?,status=?,payment_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(session.id,'authorized','paid',o.id);
    return {updated:true,status:'authorized'};
  }
  db.prepare('UPDATE orders SET provider_order_id=?,status=?,payment_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(session.id,'payment_pending',paymentStatus||eventStatus||'unknown',o.id);
  return {updated:true,status:'payment_pending'};
}

app.post('/api/checkout/stripe/webhook', express.raw({type:'application/json',limit:'2mb'}), (req,res)=>{
  try{
    verifyStripeWebhookSignature(req.body, req.headers['stripe-signature']);
    const event=JSON.parse(req.body.toString('utf8'));
    const supported=['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired'];
    if(supported.includes(event.type)){
      const result=applyStripeSessionState(event.data?.object,event.type);
      if(!result.updated && result.reason!=='order_not_found') console.warn('Stripe webhook ignored:',result.reason);
    }
    res.json({received:true});
  }catch(err){
    console.error('Stripe webhook:',err.message||err);
    res.status(400).json({error:'Ugyldig Stripe webhook.'});
  }
});

app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(ROOT, 'public')));

function slugPart(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function chassisCode(vehicle) {
  const chassis = slugPart(vehicle?.chassis);
  const family = { R50:'R50', R52:'R50', R53:'R50', R55:'R55', R56:'R56', R57:'R56', R58:'R58', R59:'R58', R60:'R60', R61:'R60' };
  return family[chassis] || chassis || 'GEN';
}
function chassisGroupForVehicle(vehicle){return chassisGroupForChassis(vehicle?.chassis);}
function variantRank(v){const order=['One D','Cooper D','Cooper SD','One','Cooper','Cooper S','JCW','GP1','GP2'];const x=String(v||'').trim();return order.indexOf(x)>=0?order.indexOf(x):999;}
function productSlug(name,id){return `${slugPart(name).toLowerCase().replace(/-/g,'-')}-${id}`.replace(/-+/g,'-').replace(/^-|-$/g,'');}

function generateSku(vehicle, categoryCode) {
  const prefix = `CS-${chassisCode(vehicle)}-${slugPart(categoryCode)}`;
  const row = db.prepare('SELECT next_number FROM sku_counters WHERE prefix=?').get(prefix);
  const n = row ? row.next_number : 1;
  db.prepare(`INSERT INTO sku_counters(prefix,next_number) VALUES (?,?)
    ON CONFLICT(prefix) DO UPDATE SET next_number=excluded.next_number`).run(prefix, n + 1);
  return `${prefix}-${String(n).padStart(3, '0')}`;
}
function getVehicle(vehicleId) { return db.prepare('SELECT * FROM vehicles WHERE id=?').get(vehicleId); }
function parseJson(value, fallback=[]) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function parsedEngineField(engine, objectKey, jsonKey, fallback=[]) {
  if (Array.isArray(engine?.[objectKey])) return engine[objectKey];
  if (engine && typeof engine[jsonKey] === 'string') return parseJson(engine[jsonKey], fallback);
  return Array.isArray(engine?.[jsonKey]) ? engine[jsonKey] : fallback;
}
function powerForYear(engine, year) {
  const y = Number(year);
  const rules = parsedEngineField(engine, 'powerRules', 'power_rules_json', []);
  const rule = rules.find(r => y >= r.from && y <= r.to);
  return rule?.power ?? engine.factory_hp;
}
function optionsForYear(engine, kind, year) {
  const y = Number(year);
  const rulesKey = kind === 'transmission' ? 'transmissionRules' : 'drivetrainRules';
  const rulesJsonKey = kind === 'transmission' ? 'transmission_rules_json' : 'drivetrain_rules_json';
  const valuesKey = kind === 'transmission' ? 'transmissions' : 'drivetrains';
  const valuesJsonKey = kind === 'transmission' ? 'transmissions_json' : 'drivetrain_json';
  const rules = parsedEngineField(engine, rulesKey, rulesJsonKey, []);
  if (Array.isArray(rules) && rules.length) {
    const values = [];
    for (const rule of rules) {
      if (y >= Number(rule.from) && y <= Number(rule.to)) values.push(...(Array.isArray(rule.values) ? rule.values : []));
    }
    return [...new Set(values)];
  }
  return parsedEngineField(engine, valuesKey, valuesJsonKey, []);
}
function engineResponse(row, yearFrom, yearTo) {
  const e = {
    id: row.id,
    source_id: row.source_id,
    model: row.model,
    year_from: row.year_from,
    year_to: row.year_to,
    variant: row.variant,
    name: row.name,
    engine_code: row.engine_code,
    displacement_cc: row.displacement_cc,
    fuel: row.fuel,
    factory_hp: row.factory_hp,
    transmissions: parseJson(row.transmissions_json),
    drivetrains: parseJson(row.drivetrain_json),
    transmissionRules: parseJson(row.transmission_rules_json),
    drivetrainRules: parseJson(row.drivetrain_rules_json),
    powerRules: parseJson(row.power_rules_json),
    market: row.market
  };
  if (yearFrom != null && yearFrom !== '') {
    const from = Number(yearFrom);
    const to = yearTo != null && yearTo !== '' ? Number(yearTo) : from;
    const start = Math.max(from, Number(row.year_from));
    const end = Math.min(to, Number(row.year_to));
    const hpValues=[];
    const transmissions=new Set();
    const drivetrains=new Set();
    for(let y=start;y<=end;y++){
      hpValues.push(powerForYear(e,y));
      for(const value of optionsForYear(e,'transmission',y)) transmissions.add(value);
      for(const value of optionsForYear(e,'drivetrain',y)) drivetrains.add(value);
    }
    e.factory_hp_for_year = powerForYear(e, Math.max(from, Number(row.year_from)));
    e.factory_hp_for_range = [...new Set(hpValues.length?hpValues:[e.factory_hp])];
    e.transmissions_for_year = [...transmissions];
    e.drivetrains_for_year = [...drivetrains];
  }
  return e;
}

app.get('/api/health', (req,res) => res.json({ ok:true, system:'Cooper Supply', version:APP_VERSION, stripe:{configured:Boolean(STRIPE_SECRET_KEY),webhookConfigured:Boolean(STRIPE_WEBHOOK_SECRET)}, klarna:{configured:Boolean(KLARNA_USERNAME&&KLARNA_PASSWORD),environment:KLARNA_ENV} }));
const adminSessions = new Map();
const ADMIN_USER = process.env.COOPER_ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.COOPER_ADMIN_PASSWORD || '1234';
const ADMIN_SESSION_MS = 5 * 60 * 1000;
function sessionCookie(token){ return `cooper_admin=${token}; Path=/; HttpOnly; SameSite=Lax`;  }
function parseCookies(header=''){ return Object.fromEntries(header.split(';').map(v=>v.trim()).filter(Boolean).map(v=>{const i=v.indexOf('=');return i<0?[v,'']:[v.slice(0,i),decodeURIComponent(v.slice(i+1))]})); }
function getAdminSession(req){
  const token=parseCookies(req.headers.cookie||'').cooper_admin;
  if(!token)return null;
  const session=adminSessions.get(token);
  if(!session)return null;
  if(Date.now()-session.lastActive>=ADMIN_SESSION_MS){ adminSessions.delete(token); return null; }
  session.lastActive=Date.now();
  return {token,session};
}
function isAdmin(req){ return !!getAdminSession(req); }
app.post('/api/auth/login',(req,res)=>{
  const user=String(req.body?.username||''); const password=String(req.body?.password||'');
  if(user!==ADMIN_USER || password!==ADMIN_PASSWORD) return res.status(401).json({error:'Feil brukernavn eller passord.'});
  const token=crypto.randomBytes(32).toString('hex'); adminSessions.set(token,{user,created:Date.now(),lastActive:Date.now()});
  res.setHeader('Set-Cookie',sessionCookie(token)); res.json({ok:true,user});
});
app.post('/api/auth/logout',(req,res)=>{ const token=parseCookies(req.headers.cookie||'').cooper_admin; if(token)adminSessions.delete(token); res.setHeader('Set-Cookie','cooper_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'); res.json({ok:true}); });
app.get('/api/auth/me',(req,res)=>{ const auth=getAdminSession(req); if(!auth)return res.status(401).json({authenticated:false}); res.json({authenticated:true,user:auth.session.user,expires_in_ms:ADMIN_SESSION_MS-(Date.now()-auth.session.lastActive)}); });
app.use('/api',(req,res,next)=>{
  const publicApi=req.path==='/health' || req.path==='/checkout/stripe/webhook' || req.path==='/checkout/klarna/session' || req.path==='/checkout/stripe/session' || req.path.startsWith('/checkout/order/') || req.path.startsWith('/auth/') || req.path.startsWith('/storefront/') || req.path.startsWith('/products/slug/');
  if(publicApi)return next();
  if(!isAdmin(req))return res.status(401).json({error:'Innlogging kreves.'});
  next();
});

app.get('/api/categories', (req,res) => res.json(db.prepare('SELECT * FROM categories ORDER BY name').all()));
app.get('/api/vehicles', (req,res) => { const rows=db.prepare('SELECT * FROM vehicles').all(); rows.sort((a,b)=>{const ga=chassisGroupForChassis(a.chassis)||'G9',gb=chassisGroupForChassis(b.chassis)||'G9';return ga.localeCompare(gb)||a.chassis.localeCompare(b.chassis)}); res.json(rows.map(v=>({...v,chassis_group:chassisGroupForChassis(v.chassis)}))); });
app.get('/api/engines', (req,res) => {
  const vehicleId = Number(req.query.vehicle_id);
  const yearFrom = req.query.year_from !== undefined ? Number(req.query.year_from) : (req.query.year !== undefined ? Number(req.query.year) : null);
  const yearTo = req.query.year_to !== undefined ? Number(req.query.year_to) : yearFrom;
  let rows;
  if (vehicleId && yearFrom && yearTo) {
    const v = getVehicle(vehicleId);
    if (!v || yearTo < yearFrom) return res.status(400).json({error:'Invalid vehicle/year range'});
    rows = db.prepare('SELECT * FROM engines WHERE model=? AND year_from<=? AND year_to>=?').all(v.chassis, yearTo, yearFrom);
  } else if (vehicleId) {
    const v = getVehicle(vehicleId);
    rows = v ? db.prepare('SELECT * FROM engines WHERE model=?').all(v.chassis) : [];
  } else {
    rows = db.prepare('SELECT * FROM engines').all();
  }
  rows.sort((a,b)=>variantRank(a.variant)-variantRank(b.variant)||String(a.fuel||'').localeCompare(String(b.fuel||''))||Number(a.year_from)-Number(b.year_from)||Number(a.factory_hp||0)-Number(b.factory_hp||0)||a.id-b.id);
  res.json(rows.map(r => engineResponse(r, yearFrom, yearTo)));
});
app.get('/api/fitment/options', (req,res) => {
  const vehicleId = Number(req.query.vehicle_id);
  const engineId = Number(req.query.engine_id);
  const yearFrom = Number(req.query.year_from || req.query.year);
  const yearTo = Number(req.query.year_to || req.query.year || yearFrom);
  if (!vehicleId || !engineId || !yearFrom || !yearTo) return res.json({ transmissions:[], drivetrains:[] });
  const v = getVehicle(vehicleId);
  const e = db.prepare('SELECT * FROM engines WHERE id=?').get(engineId);
  if (!v || !e || e.model !== v.chassis || yearTo < yearFrom || yearTo < v.year_from || yearFrom > v.year_to) return res.status(400).json({error:'Invalid vehicle/year/engine combination'});
  const start=Math.max(yearFrom, Number(e.year_from));
  const end=Math.min(yearTo, Number(e.year_to));
  if(start>end) return res.status(400).json({error:'Valgt motor/variant overlapper ikke valgt årsperiode.'});
  const transmissions=new Set();
  const drivetrains=new Set();
  const hpValues=[];
  for(let y=start;y<=end;y++){
    hpValues.push(powerForYear(e,y));
    for(const value of optionsForYear(e,'transmission',y)) transmissions.add(value);
    for(const value of optionsForYear(e,'drivetrain',y)) drivetrains.add(value);
  }
  let drivetrainList=[...drivetrains];
  if(!drivetrainList.length) drivetrainList=['FWD'];
  res.json({
    transmissions:[...transmissions],
    drivetrains:drivetrainList,
    factory_hp:powerForYear(e,start),
    factory_hp_for_range:[...new Set(hpValues)],
    variant:e.variant,
    fuel:e.fuel,
    engine:e.name,
    available_years:[start,end]
  });
});

app.get('/api/products', (req,res) => {
  const status = req.query.status;
  const q = req.query.q;
  let sql = `SELECT p.*, c.code category_code, c.name category_name,
    p.chassis_group, p.slug,
    (SELECT v.chassis FROM fitments f JOIN vehicles v ON v.id=f.vehicle_id WHERE f.product_id=p.id ORDER BY f.id LIMIT 1) AS fitment_chassis,
    (SELECT f.year_from FROM fitments f WHERE f.product_id=p.id ORDER BY f.id LIMIT 1) AS fitment_year_from,
    (SELECT f.year_to FROM fitments f WHERE f.product_id=p.id ORDER BY f.id LIMIT 1) AS fitment_year_to,
    (SELECT COUNT(*) FROM fitments f WHERE f.product_id=p.id) AS fitment_count,
    (SELECT GROUP_CONCAT(
      v.chassis
      || CASE WHEN f.year_from IS NOT NULL THEN ' · ' || f.year_from || CASE WHEN f.year_to IS NOT NULL AND f.year_to<>f.year_from THEN '–' || f.year_to ELSE '' END ELSE '' END
      || CASE WHEN e.fuel IS NOT NULL THEN ' · ' || CASE e.fuel WHEN 'Petrol' THEN 'Bensin' WHEN 'Diesel' THEN 'Diesel' ELSE e.fuel END ELSE '' END
      || CASE WHEN e.variant IS NOT NULL THEN ' · ' || e.variant ELSE '' END
      || CASE WHEN f.gearbox IS NOT NULL AND f.gearbox<>'' THEN ' · ' || CASE f.gearbox WHEN 'Manual' THEN 'Manuell' WHEN 'Automatic' THEN 'Automat' ELSE f.gearbox END ELSE '' END
      || CASE WHEN f.drivetrain IS NOT NULL AND f.drivetrain<>'' THEN ' · ' || f.drivetrain ELSE '' END, ' + ')
      FROM fitments f JOIN vehicles v ON v.id=f.vehicle_id LEFT JOIN engines e ON e.id=f.engine_id WHERE f.product_id=p.id) AS fitment_summary,
    (SELECT filename FROM product_images i WHERE i.product_id=p.id ORDER BY i.sort_order,i.id LIMIT 1) AS primary_image,
    (SELECT ROUND(AVG(mp.price_cents)) FROM market_prices mp WHERE mp.product_id=p.id) AS market_avg_cents
    FROM products p JOIN categories c ON c.id=p.category_id WHERE p.status IN ('verification','verified','active')`;
  const params=[];
  if (status) { sql += ' AND p.status=?'; params.push(status); }
  if (q) { sql += ' AND (p.name LIKE ? OR p.sku LIKE ? OR p.brand LIKE ?)'; const x=`%${q}%`; params.push(x,x,x); }
  sql += ' ORDER BY p.updated_at DESC, p.id DESC';
  res.json(db.prepare(sql).all(...params));
});
app.get('/api/storefront/catalog', (req,res) => {
  const rows = db.prepare(`
    SELECT p.*, c.code category_code, c.name category_name
    FROM products p
    JOIN categories c ON c.id=p.category_id
    WHERE p.status IN ('verified','active')
    ORDER BY p.updated_at DESC, p.id DESC
  `).all();
  const fitmentStmt = db.prepare(`
    SELECT f.*, v.chassis, v.model vehicle_model,
      e.name engine_name, e.variant engine_variant, e.fuel engine_fuel
    FROM fitments f
    JOIN vehicles v ON v.id=f.vehicle_id
    LEFT JOIN engines e ON e.id=f.engine_id
    WHERE f.product_id=?
    ORDER BY f.id
  `);
  const products = rows.map(p => {
    const fitments = fitmentStmt.all(p.id);
    const models = [...new Set(fitments.map(f => f.chassis).filter(Boolean))];
    const rules = fitments.map(f => ({
      models: f.chassis ? [f.chassis] : [],
      yearFrom: f.year_from ?? null,
      yearTo: f.year_to ?? null,
      fuel: f.engine_fuel ? [f.engine_fuel] : [],
      variants: f.engine_variant ? [f.engine_variant] : [],
      engines: f.engine_id ? [String(f.engine_id), f.engine_name].filter(Boolean) : [],
      drivetrains: f.drivetrain ? [f.drivetrain] : [],
      transmissions: f.gearbox ? [f.gearbox] : [],
      faceliftRule: f.facelift_rule || 'all',
      notes: f.notes || ''
    }));
    return {
      id:p.id,
      sku:p.sku,
      name:p.name,
      brand:p.brand,
      category:p.category_code,
      categoryName:p.category_name,
      subcategory:p.subcategory,
      price:p.price_cents == null ? null : p.price_cents / 100,
      salePrice:p.sale_price_cents == null ? null : p.sale_price_cents / 100,
      description:p.description,
      material:p.material,
      finish:p.finish,
      included:p.included_items,
      includedItems:p.included_items,
      installation:p.installation,
      warranty:p.warranty,
      manufacturerPartNumber:p.manufacturer_part_number,
      stockStatus:p.stock_status || 'external_stock',
      modelNumber:p.manufacturer_part_number,
      candidate:p.status === 'candidate',
      status:p.status,
      chassisGroup:p.chassis_group,
      slug:p.slug,
      fitment:models,
      fitmentRules:rules,
      model:models.join(' / '),
      images:db.prepare('SELECT filename FROM product_images WHERE product_id=? ORDER BY sort_order,id').all(p.id).map(i=>`/uploads/${i.filename}`)
    };
  });
  res.json({ models:catalog.models, categories:catalog.categories, engines:catalog.engines, products, catalogMeta:catalog.catalogMeta || {}, shippingCents:SHIPPING_CENTS });
});

app.get('/api/storefront/products/slug/:slug/status',(req,res)=>{
  const p=db.prepare('SELECT id,status,slug FROM products WHERE slug=?').get(req.params.slug);
  if(!p)return res.status(404).json({error:'Product not found'});
  if(!['verified','active'].includes(p.status))return res.status(410).json({id:p.id,status:p.status});
  res.json({id:p.id,status:p.status,slug:p.slug});
});

app.get('/api/products/slug/:slug', (req,res) => {
  const p=db.prepare(`SELECT p.*, c.code category_code, c.name category_name FROM products p JOIN categories c ON c.id=p.category_id WHERE p.slug=?`).get(req.params.slug);
  if(!p || !['verified','active'].includes(p.status)) return res.status(404).json({error:'Product not found'});
  p.fitments=db.prepare(`SELECT f.*, v.chassis, v.model, v.generation, e.name engine_name, e.variant engine_variant, e.engine_code, e.factory_hp FROM fitments f JOIN vehicles v ON v.id=f.vehicle_id LEFT JOIN engines e ON e.id=f.engine_id WHERE f.product_id=? ORDER BY f.id`).all(p.id);
  p.images=db.prepare('SELECT * FROM product_images WHERE product_id=? ORDER BY sort_order,id').all(p.id);
  res.json(p);
});

app.get('/api/products/:id', (req,res) => {
  const p = db.prepare(`SELECT p.*, c.code category_code, c.name category_name FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=?`).get(req.params.id);
  // Admin endpoint: authenticated admins may edit products in any valid status.
  if (!p || !['verification','verified','active'].includes(p.status)) return res.status(404).json({error:'Product not found'});
  p.fitments = db.prepare(`SELECT f.*, v.chassis, v.model, v.generation, e.name engine_name, e.variant engine_variant, e.engine_code, e.factory_hp FROM fitments f JOIN vehicles v ON v.id=f.vehicle_id LEFT JOIN engines e ON e.id=f.engine_id WHERE f.product_id=? ORDER BY f.id`).all(p.id);
  p.images = db.prepare('SELECT * FROM product_images WHERE product_id=? ORDER BY sort_order,id').all(p.id);
  res.json(p);
});

// Storefront status endpoint: existing product pages use this to detect an unpublish without exposing unpublished products.
app.get('/api/storefront/products/:id/status', (req,res) => {
  const p = db.prepare('SELECT id,status FROM products WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({error:'Product not found'});
  if (!['verified','active'].includes(p.status)) return res.status(410).json({error:'Product no longer available', status:p.status});
  res.json({id:p.id,status:p.status});
});

const productFields = ['name','brand','subcategory','price_cents','sale_price_cents','description','material','finish','included_items','installation','warranty','manufacturer_part_number','status','stock_status'];
function validateStatus(s){ return ['verification','verified','active'].includes(s); }
function validateNewProductStatus(s){ return ['verification','verified','active'].includes(s); }
function validateStockStatus(s){ return ['own_stock','external_stock','out_of_stock'].includes(s); }
function validatePricing(price,salePrice){
  const priceValue=price==null||price===''?null:Number(price);
  const saleValue=salePrice==null||salePrice===''?null:Number(salePrice);
  if(saleValue!=null && (!Number.isFinite(saleValue)||saleValue<=0)) return {ok:false,error:'Salgspris må være større enn 0.'};
  if(saleValue!=null && (priceValue==null||!Number.isFinite(priceValue))) return {ok:false,error:'Salgspris krever en ordinær pris.'};
  if(saleValue!=null && saleValue>=priceValue) return {ok:false,error:'Salgspris må være lavere enn ordinær pris.'};
  return {ok:true};
}

const faceliftCutoffs={
  R50:2005,
  R52:null,
  R53:2005,
  R55:2010,
  R56:2010,
  R57:2011,
  R58:null,
  R59:null,
  R60:2014,
  R61:2014
};
function validateFaceliftRule(f, vehicle) {
  const rule = f?.facelift_rule || 'all';
  const cutoff = faceliftCutoffs[vehicle.chassis] ?? null;
  if (rule === 'all') return { ok:true };
  if (!cutoff) return { ok:false, error:`${vehicle.chassis} har ikke en definert separat facelift/LCI-grense.` };
  const expectedLt = `lt:${cutoff}`;
  const expectedGte = `gte:${cutoff}`;
  if (rule !== expectedLt && rule !== expectedGte) return { ok:false, error:`Gyldige facelift-regler for ${vehicle.chassis} er < ${cutoff}, ≥ ${cutoff} eller Ikke relevant.` };
  return { ok:true };
}
function effectiveFitmentRange(f, vehicle) {
  const explicitFrom = Number(f?.year_from) || null;
  const explicitTo = Number(f?.year_to) || null;
  if (explicitFrom && explicitTo) return { from: explicitFrom, to: explicitTo };
  if (explicitFrom) return { from: explicitFrom, to: Number(vehicle.year_to) };
  const rule = f?.facelift_rule || 'all';
  const m = String(rule).match(/^(lt|gte):(\d+)$/);
  if (m) {
    const cutoff = Number(m[2]);
    return m[1] === 'lt' ? { from: Number(vehicle.year_from), to: cutoff - 1 } : { from: cutoff, to: Number(vehicle.year_to) };
  }
  return { from: Number(vehicle.year_from), to: Number(vehicle.year_to) };
}
function validateFitment(f) {
  if (!f?.vehicle_id || !getVehicle(f.vehicle_id)) return { ok:false, error:'Velg et gyldig MINI chassis.' };
  const vehicle = getVehicle(f.vehicle_id);
  const faceliftCheck = validateFaceliftRule(f, vehicle); if (!faceliftCheck.ok) return faceliftCheck;
  if (f.year_from && f.year_to && Number(f.year_from) > Number(f.year_to)) return { ok:false, error:'Årsmodell fra kan ikke være senere enn årsmodell til.' };
  const range = effectiveFitmentRange(f, vehicle);
  const from = range.from;
  const to = range.to;
  if (from < vehicle.year_from || to > vehicle.year_to) return { ok:false, error:`Årsmodell må være innenfor ${vehicle.year_from}–${vehicle.year_to} for ${vehicle.chassis}.` };
  if (f.engine_id) {
    const engine = db.prepare('SELECT * FROM engines WHERE id=?').get(f.engine_id);
    if (!engine || engine.model !== vehicle.chassis) return { ok:false, error:'Motor/variant passer ikke til valgt chassis.' };
    if (to < engine.year_from || from > engine.year_to) return { ok:false, error:'Motor/variant overlapper ikke valgt årsperiode.' };
    if (f.gearbox || f.drivetrain) {
      const start = Math.max(from, engine.year_from);
      const end = Math.min(to, engine.year_to);
      const transmissions = new Set(); const drivetrains = new Set();
      for (let y=start; y<=end; y++) {
        for (const value of optionsForYear(engine,'transmission',y)) transmissions.add(value);
        for (const value of optionsForYear(engine,'drivetrain',y)) drivetrains.add(value);
      }
      if (f.gearbox && !transmissions.has(f.gearbox)) return { ok:false, error:'Valgt girkasse er ikke tilgjengelig for valgt motor og årsperiode.' };
      if (f.drivetrain && !drivetrains.has(f.drivetrain) && !(drivetrains.size===0 && f.drivetrain==='FWD')) return { ok:false, error:'Valgt drivlinje er ikke tilgjengelig for valgt motor og årsperiode.' };
    }
  }
  return { ok:true };
}
function validateChassisGroup(list, lockedGroup=null){ const groups=[...new Set(list.map(f=>chassisGroupForVehicle(getVehicle(f.vehicle_id))).filter(Boolean))]; if(groups.length!==1)return {ok:false,error:'Alle fitments på et produkt må tilhøre samme chassisgruppe (G1–G4).'}; if(lockedGroup && groups[0]!==lockedGroup)return {ok:false,error:`Chassisgruppe er låst til ${lockedGroup} og kan ikke endres på et eksisterende produkt.`}; return {ok:true,group:groups[0]}; }

function normalizeFitments(body) {
  if (Array.isArray(body.fitments)) return body.fitments;
  if (body.vehicle_id) return [{vehicle_id:body.vehicle_id,year_from:body.year_from,year_to:body.year_to,engine_id:body.engine_id,gearbox:body.gearbox,drivetrain:body.drivetrain,facelift_rule:body.facelift_rule||'all',facelift_year:body.facelift_year,facelift_compare:body.facelift_compare||'all',notes:body.fitment_notes}];
  return [];
}
function duplicateFitmentKey(f) { return [f.vehicle_id||'',f.year_from||'',f.year_to||'',f.engine_id||'',f.gearbox||'',f.drivetrain||'',f.facelift_rule||'all'].join('|'); }
function validateFitmentList(list) {
  if (!Array.isArray(list) || !list.length) return {ok:false,error:'Legg til minst ett fitment.'};
  const seen=new Set();
  for (const f of list) {
    const check=validateFitment(f); if(!check.ok)return check;
    const key=duplicateFitmentKey(f); if(seen.has(key))return {ok:false,error:'Dette produktet har et identisk fitment flere ganger.'}; seen.add(key);
  }
  return {ok:true};
}
function insertFitments(productId,list){
  const stmt=db.prepare(`INSERT INTO fitments(product_id,vehicle_id,year_from,year_to,engine_id,gearbox,drivetrain,facelift_rule,facelift_year,facelift_compare,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for(const f of list){
    const rule=f.facelift_rule||'all';
    const match=String(rule).match(/^(lt|gte):(\d+)$/);
    const faceliftYear=match?Number(match[2]):null;
    const faceliftCompare=match?match[1]:'all';
    stmt.run(productId,f.vehicle_id,f.year_from||null,f.year_to||null,f.engine_id||null,f.gearbox||null,f.drivetrain||null,rule,faceliftYear,faceliftCompare,f.notes||null);
  }
}

app.post('/api/products', (req,res) => {
  try {
    const b=req.body||{}; const fitments=normalizeFitments(b);
    const pricingCheck=validatePricing(b.price_cents,b.sale_price_cents); if(!pricingCheck.ok)return res.status(400).json({error:pricingCheck.error});
    if (!b.name || !b.category_id || !fitments.length) return res.status(400).json({error:'Produktnavn, kategori og minst ett fitment er påkrevd.'});
    const category=db.prepare('SELECT * FROM categories WHERE id=?').get(b.category_id);
    if(!category) return res.status(400).json({error:'Ugyldig kategori.'});
    const fitmentCheck=validateFitmentList(fitments); if(!fitmentCheck.ok)return res.status(400).json({error:fitmentCheck.error});
    const groupCheck=validateChassisGroup(fitments); if(!groupCheck.ok)return res.status(400).json({error:groupCheck.error});
    const firstVehicle=getVehicle(fitments[0].vehicle_id); const sku=generateSku(firstVehicle,category.code);
    const status=b.status && validateNewProductStatus(b.status) ? b.status : 'verification';
    const stockStatus=b.stock_status && validateStockStatus(b.stock_status) ? b.stock_status : 'external_stock';
    const tx=db.transaction(()=>{
      const r=db.prepare(`INSERT INTO products (sku,name,brand,category_id,subcategory,price_cents,sale_price_cents,description,material,finish,included_items,installation,warranty,manufacturer_part_number,chassis_group,status,stock_status,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`).run(sku,b.name,b.brand||null,b.category_id,b.subcategory||null,b.price_cents ?? null,b.sale_price_cents ?? null,b.description||null,b.material||null,b.finish||null,b.included_items||null,b.installation||null,b.warranty||null,b.manufacturer_part_number||null,groupCheck.group,status,stockStatus);
      db.prepare('UPDATE products SET slug=? WHERE id=?').run(productSlug(b.name,r.lastInsertRowid),r.lastInsertRowid);
      insertFitments(r.lastInsertRowid,fitments); return r.lastInsertRowid;
    });
    const id=tx(); res.status(201).json({id,sku});
  } catch (err) {
    console.error('Product create failed:', err);
    res.status(500).json({error:`Kunne ikke lagre produktet: ${err.message}`});
  }
});

app.put('/api/products/:id', (req,res) => {
  try {
    const id=Number(req.params.id); const b=req.body||{};
    const old=db.prepare('SELECT * FROM products WHERE id=?').get(id); if(!old)return res.status(404).json({error:'Product not found'});
    if(b.status && !validateStatus(b.status))return res.status(400).json({error:'Invalid status'});
    if(b.stock_status && !validateStockStatus(b.stock_status))return res.status(400).json({error:'Ugyldig lagerstatus.'});
    const pricingCheck=validatePricing(b.price_cents!==undefined?b.price_cents:old.price_cents,b.sale_price_cents!==undefined?b.sale_price_cents:old.sale_price_cents); if(!pricingCheck.ok)return res.status(400).json({error:pricingCheck.error});
    const fitments=normalizeFitments(b); const fitmentCheck=validateFitmentList(fitments); if(!fitmentCheck.ok)return res.status(400).json({error:fitmentCheck.error});
    const groupCheck=validateChassisGroup(fitments,old.chassis_group||null); if(!groupCheck.ok)return res.status(400).json({error:groupCheck.error});
    const values=productFields.map(k=>b[k]!==undefined?b[k]:old[k]);
    const tx=db.transaction(()=>{
      db.prepare(`UPDATE products SET name=?,brand=?,subcategory=?,price_cents=?,sale_price_cents=?,description=?,material=?,finish=?,included_items=?,installation=?,warranty=?,manufacturer_part_number=?,status=?,stock_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...values,id);
      db.prepare('DELETE FROM fitments WHERE product_id=?').run(id); insertFitments(id,fitments);
    });
    tx(); res.json({ok:true,id,sku:old.sku});
  } catch (err) {
    console.error('Product update failed:', err);
    res.status(500).json({error:`Kunne ikke oppdatere produktet: ${err.message}`});
  }
});

app.patch('/api/products/:id/pricing', (req,res) => {
  try {
    const id=Number(req.params.id);
    const old=db.prepare('SELECT * FROM products WHERE id=?').get(id);
    if(!old)return res.status(404).json({error:'Product not found'});
    const price=req.body?.price_cents===undefined ? old.price_cents : req.body.price_cents;
    const salePrice=req.body?.sale_price_cents===undefined ? old.sale_price_cents : req.body.sale_price_cents;
    const pricingCheck=validatePricing(price,salePrice);
    if(!pricingCheck.ok)return res.status(400).json({error:pricingCheck.error});
    db.prepare('UPDATE products SET price_cents=?, sale_price_cents=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(price===''?null:price,salePrice===''?null:salePrice,id);
    res.json({ok:true,id,price_cents:price,sale_price_cents:salePrice});
  } catch(err){ res.status(500).json({error:`Kunne ikke oppdatere pris: ${err.message}`}); }
});

app.post('/api/products/:id/status', (req,res) => {
  const id=Number(req.params.id);
  const status=req.body?.status;
  if(!validateStatus(status)) return res.status(400).json({error:'Ugyldig status.'});
  const product=db.prepare('SELECT id FROM products WHERE id=?').get(id);
  if(!product) return res.status(404).json({error:'Product not found'});
  db.prepare('UPDATE products SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status,id);
  res.json({ok:true,status});
});

app.post('/api/products/:id/stock-status', (req,res) => {
  const id=Number(req.params.id);
  const stockStatus=req.body?.stock_status;
  if(!validateStockStatus(stockStatus)) return res.status(400).json({error:'Ugyldig lagerstatus.'});
  const product=db.prepare('SELECT id FROM products WHERE id=?').get(id);
  if(!product) return res.status(404).json({error:'Product not found'});
  db.prepare('UPDATE products SET stock_status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(stockStatus,id);
  res.json({ok:true,stock_status:stockStatus});
});

app.delete('/api/products/:id', (req,res) => {
  const id=Number(req.params.id);
  const p=db.prepare('SELECT id, name, sku FROM products WHERE id=?').get(id);
  if(!p) return res.status(404).json({error:'Product not found'});
  const files=db.prepare('SELECT filename FROM product_images WHERE product_id=?').all(id);
  db.prepare('DELETE FROM products WHERE id=?').run(id);
  for(const f of files){try{fs.unlinkSync(path.join(UPLOAD_DIR,f.filename));}catch(e){}}
  res.json({ok:true, deleted:p});
});

const storage=multer.diskStorage({destination:UPLOAD_DIR, filename:(req,file,cb)=>{
  const safe=Date.now()+'-'+slugPart(path.basename(file.originalname,path.extname(file.originalname)))+path.extname(file.originalname).toLowerCase(); cb(null,safe);
}});
const upload=multer({storage, limits:{fileSize:10*1024*1024}});
app.post('/api/products/:id/images', upload.array('images',12), (req,res)=>{
  const id=Number(req.params.id); if(!db.prepare('SELECT id FROM products WHERE id=?').get(id)) return res.status(404).json({error:'Product not found'});
  const add=db.prepare('INSERT INTO product_images(product_id,filename,sort_order) VALUES (?,?,?)');
  const tx=db.transaction(files=>files.forEach((f,i)=>add.run(id,f.filename,i)));
  tx(req.files||[]); res.status(201).json({images:(req.files||[]).map(f=>({filename:f.filename,url:`/uploads/${f.filename}`}))});
});

app.delete('/api/products/:id/images/:imageId',(req,res)=>{
  const id=Number(req.params.id), imageId=Number(req.params.imageId);
  const image=db.prepare('SELECT * FROM product_images WHERE id=? AND product_id=?').get(imageId,id);
  if(!image)return res.status(404).json({error:'Bilde ikke funnet'});
  db.prepare('DELETE FROM product_images WHERE id=? AND product_id=?').run(imageId,id);
  try{fs.unlinkSync(path.join(UPLOAD_DIR,image.filename));}catch(e){}
  res.json({ok:true});
});

app.get('/api/products/:id/market-prices',(req,res)=>{ const id=Number(req.params.id); if(!db.prepare('SELECT id FROM products WHERE id=?').get(id))return res.status(404).json({error:'Product not found'}); res.json(db.prepare('SELECT * FROM market_prices WHERE product_id=? ORDER BY checked_at DESC,id DESC').all(id)); });
app.post('/api/products/:id/market-prices',(req,res)=>{ const id=Number(req.params.id); if(!db.prepare('SELECT id FROM products WHERE id=?').get(id))return res.status(404).json({error:'Product not found'}); const b=req.body||{}; if(!b.source_name||b.price_cents==null)return res.status(400).json({error:'Kilde og pris er påkrevd.'}); const r=db.prepare('INSERT INTO market_prices(product_id,source_name,source_url,price_cents,currency,shipping_cents) VALUES (?,?,?,?,?,?)').run(id,b.source_name,b.source_url||null,Number(b.price_cents),b.currency||'NOK',b.shipping_cents==null?null:Number(b.shipping_cents)); res.status(201).json({id:r.lastInsertRowid}); });
app.delete('/api/products/:id/market-prices/:priceId',(req,res)=>{db.prepare('DELETE FROM market_prices WHERE id=? AND product_id=?').run(Number(req.params.priceId),Number(req.params.id));res.json({ok:true});});

function klarnaAuthHeader(){
  return 'Basic ' + Buffer.from(`${KLARNA_USERNAME}:${KLARNA_PASSWORD}`).toString('base64');
}
function stripeAuthHeader(){
  return 'Basic ' + Buffer.from(`${STRIPE_SECRET_KEY}:`).toString('base64');
}
async function stripeRequest(endpoint, options={}){
  const response=await fetch(`${STRIPE_API_BASE}${endpoint}`,{...options,headers:{Authorization:stripeAuthHeader(),'Content-Type':'application/x-www-form-urlencoded','Cache-Control':'no-cache',...(options.headers||{})}});
  const body=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(body?.error?.message||`Stripe API request failed (${response.status}).`);
  return body;
}
function orderNumber(id){ return `CS-${new Date().getFullYear()}-${String(id).padStart(6,'0')}`; }
function currentProductPrice(p){
  const regular=p.price_cents==null?null:Number(p.price_cents);
  const sale=p.sale_price_cents==null?null:Number(p.sale_price_cents);
  return sale!=null && regular!=null && sale>0 && sale<regular ? sale : regular;
}
function checkoutProducts(cartItems){
  if(!Array.isArray(cartItems) || !cartItems.length) throw new Error('Handlekurven er tom.');
  const getProduct=db.prepare(`SELECT p.id,p.sku,p.name,p.price_cents,p.sale_price_cents,p.status,p.stock_status FROM products p WHERE p.id=?`);
  const result=[];
  for(const raw of cartItems){
    const id=Number(raw?.id), qty=Math.floor(Number(raw?.qty));
    if(!Number.isInteger(id)||!Number.isInteger(qty)||qty<1||qty>999) throw new Error('Ugyldig produktantall.');
    const p=getProduct.get(id);
    if(!p || !['verified','active'].includes(p.status)) throw new Error(`Produktet ${id} er ikke lenger tilgjengelig.`);
    if(p.stock_status==='out_of_stock') throw new Error(`Produktet ${p.name} er ikke på lager.`);
    const unit=currentProductPrice(p);
    if(unit==null || !Number.isFinite(unit) || unit<0) throw new Error(`Produktet ${p.name} mangler pris.`);
    result.push({id:p.id,sku:p.sku,name:p.name,qty,unit_price_cents:unit,total_amount_cents:unit*qty,status:p.status,stock_status:p.stock_status||'external_stock'});
  }
  return result;
}
app.post('/api/checkout/klarna/session', async (req,res)=>{
  try{
    if(!KLARNA_USERNAME || !KLARNA_PASSWORD) return res.status(503).json({error:'Klarna er ikke konfigurert ennå. Legg inn KLARNA_USERNAME og KLARNA_PASSWORD i miljøvariablene.'});
    const customer=req.body?.customer||{};
    const required=['firstName','lastName','email','phone','address','postalCode','city'];
    for(const key of required){ if(!String(customer[key]||'').trim()) return res.status(400).json({error:'Fyll ut alle obligatoriske kunde- og leveringsfelt.'}); }
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(customer.email).trim())) return res.status(400).json({error:'Oppgi en gyldig e-postadresse.'});
    const items=checkoutProducts(req.body?.items);
    const subtotalCents=items.reduce((sum,i)=>sum+i.total_amount_cents,0);
    const totalCents=subtotalCents+SHIPPING_CENTS;
    const taxCents=items.reduce((sum,i)=>sum+Math.round(i.total_amount_cents*VAT_RATE/(1+VAT_RATE)),0);
    const snapshot={customer:{firstName:String(customer.firstName).trim(),lastName:String(customer.lastName).trim(),email:String(customer.email).trim(),phone:String(customer.phone).trim(),address:String(customer.address).trim(),address2:String(customer.address2||'').trim(),postalCode:String(customer.postalCode).trim(),city:String(customer.city).trim(),country:'NO'},items,subtotalCents,shippingCents:SHIPPING_CENTS,totalCents,currency:'NOK'};
    const local=db.prepare(`INSERT INTO orders(order_number,status,payment_provider,payment_status,customer_json,items_json,subtotal_cents,shipping_cents,total_cents,currency) VALUES (?,?,?,?,?,?,?,?,?,?)`).run('PENDING','pending','klarna','pending',JSON.stringify(snapshot.customer),JSON.stringify(items),subtotalCents,SHIPPING_CENTS,totalCents,'NOK');
    const localId=Number(local.lastInsertRowid); const localNumber=orderNumber(localId); db.prepare('UPDATE orders SET order_number=? WHERE id=?').run(localNumber,localId);
    const base=PUBLIC_BASE_URL;
    const kpPayload={purchase_country:'NO',purchase_currency:'NOK',locale:'nb-NO',intent:'buy',order_amount:totalCents,order_tax_amount:taxCents,billing_address:{given_name:snapshot.customer.firstName,family_name:snapshot.customer.lastName,email:snapshot.customer.email,phone:snapshot.customer.phone,street_address:snapshot.customer.address,street_address2:snapshot.customer.address2||undefined,postal_code:snapshot.customer.postalCode,city:snapshot.customer.city,country:'NO'},order_lines:items.map(i=>({type:'physical',reference:i.sku,name:i.name,quantity:i.qty,unit_price:i.unit_price_cents,total_amount:i.total_amount_cents,total_tax_amount:Math.round(i.total_amount_cents*VAT_RATE/(1+VAT_RATE)),tax_rate:Math.round(VAT_RATE*10000)})),merchant_urls:{success:`${base}/checkout/success?order=${encodeURIComponent(localNumber)}`}};
    const kp=await fetch(`${KLARNA_API_BASE}/payments/v1/sessions`,{method:'POST',headers:{Authorization:klarnaAuthHeader(),'Content-Type':'application/json','Cache-Control':'no-cache'},body:JSON.stringify(kpPayload)});
    const kpBody=await kp.json().catch(()=>({}));
    if(!kp.ok) throw new Error(kpBody.error_messages?.join(' ')||kpBody.error_message||`Klarna session failed (${kp.status}).`);
    const hppPayload={payment_session_url:`${KLARNA_API_BASE}/payments/v1/sessions/${kpBody.session_id}`,merchant_urls:{success:`${base}/checkout/success?order=${encodeURIComponent(localNumber)}&order_id={{order_id}}`,cancel:`${base}/checkout/cancel?order=${encodeURIComponent(localNumber)}`,back:`${base}/checkout?payment=back&order=${encodeURIComponent(localNumber)}`,failure:`${base}/checkout/failure?order=${encodeURIComponent(localNumber)}`,error:`${base}/checkout/failure?order=${encodeURIComponent(localNumber)}`},options:{place_order_mode:'PLACE_ORDER'}};
    const hpp=await fetch(`${KLARNA_API_BASE}/hpp/v1/sessions`,{method:'POST',headers:{Authorization:klarnaAuthHeader(),'Content-Type':'application/json','Cache-Control':'no-cache'},body:JSON.stringify(hppPayload)});
    const hppBody=await hpp.json().catch(()=>({}));
    if(!hpp.ok) throw new Error(hppBody.error_messages?.join(' ')||hppBody.error_message||`Klarna HPP failed (${hpp.status}).`);
    db.prepare('UPDATE orders SET payment_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run('session_created',localId);
    res.json({ok:true,orderNumber:localNumber,redirectUrl:hppBody.redirect_url});
  }catch(err){ console.error('Klarna checkout:',err); res.status(500).json({error:err.message||'Kunne ikke starte betalingen.'}); }
});
app.post('/api/checkout/stripe/session', async (req,res)=>{
  let localId=null;
  try{
    if(!STRIPE_SECRET_KEY) return res.status(503).json({error:'Stripe er ikke konfigurert ennå. Legg inn STRIPE_SECRET_KEY i miljøvariablene.'});
    const customer=req.body?.customer||{};
    const required=['firstName','lastName','email','phone','address','postalCode','city'];
    for(const key of required){ if(!String(customer[key]||'').trim()) return res.status(400).json({error:'Fyll ut alle obligatoriske kunde- og leveringsfelt.'}); }
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(customer.email).trim())) return res.status(400).json({error:'Oppgi en gyldig e-postadresse.'});
    const items=checkoutProducts(req.body?.items);
    const subtotalCents=items.reduce((sum,i)=>sum+i.total_amount_cents,0);
    const totalCents=subtotalCents+SHIPPING_CENTS;
    const snapshot={customer:{firstName:String(customer.firstName).trim(),lastName:String(customer.lastName).trim(),email:String(customer.email).trim(),phone:String(customer.phone).trim(),address:String(customer.address).trim(),address2:String(customer.address2||'').trim(),postalCode:String(customer.postalCode).trim(),city:String(customer.city).trim(),country:'NO'},items,subtotalCents,shippingCents:SHIPPING_CENTS,totalCents,currency:'NOK'};
    const local=db.prepare(`INSERT INTO orders(order_number,status,payment_provider,payment_status,customer_json,items_json,subtotal_cents,shipping_cents,total_cents,currency) VALUES (?,?,?,?,?,?,?,?,?,?)`).run('PENDING','pending','stripe','pending',JSON.stringify(snapshot.customer),JSON.stringify(items),subtotalCents,SHIPPING_CENTS,totalCents,'NOK');
    localId=Number(local.lastInsertRowid);
    const localNumber=orderNumber(localId);
    db.prepare('UPDATE orders SET order_number=? WHERE id=?').run(localNumber,localId);
    const lineItems=[];
    for(const item of items){
      lineItems.push({
        'line_items': {
          price_data: {currency:'nok',product_data:{name:item.name},unit_amount:item.unit_price_cents},
          quantity:item.qty
        }
      });
    }
    const params=new URLSearchParams();
    params.append('mode','payment');
    params.append('success_url',`${PUBLIC_BASE_URL}/checkout/success?order=${encodeURIComponent(localNumber)}&provider=stripe&session_id={CHECKOUT_SESSION_ID}`);
    params.append('cancel_url',`${PUBLIC_BASE_URL}/checkout/cancel?order=${encodeURIComponent(localNumber)}&provider=stripe`);
    params.append('customer_email',snapshot.customer.email);
    params.append('client_reference_id',localNumber);
    params.append('metadata[order_number]',localNumber);
    params.append('metadata[payment_provider]','stripe');
    params.append('payment_method_types[0]','card');
    params.append('billing_address_collection','required');
    items.forEach((item,index)=>{
      params.append(`line_items[${index}][price_data][currency]`,'nok');
      params.append(`line_items[${index}][price_data][product_data][name]`,item.name);
      params.append(`line_items[${index}][price_data][product_data][metadata][sku]`,item.sku);
      params.append(`line_items[${index}][price_data][unit_amount]`,String(item.unit_price_cents));
      params.append(`line_items[${index}][quantity]`,String(item.qty));
    });
    if(SHIPPING_CENTS>0){
      params.append(`shipping_options[0][shipping_rate_data][type]`,'fixed_amount');
      params.append(`shipping_options[0][shipping_rate_data][display_name]`,'Frakt');
      params.append(`shipping_options[0][shipping_rate_data][fixed_amount][amount]`,String(SHIPPING_CENTS));
      params.append(`shipping_options[0][shipping_rate_data][fixed_amount][currency]`,'nok');
    }
    const session=await stripeRequest('/checkout/sessions',{method:'POST',body:params.toString()});
    if(!session?.url||!session?.id) throw new Error('Stripe returnerte ingen checkout-URL.');
    db.prepare('UPDATE orders SET provider_order_id=?,payment_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(session.id,'session_created',localId);
    res.json({ok:true,orderNumber:localNumber,redirectUrl:session.url,publishableKey:STRIPE_PUBLISHABLE_KEY});
  }catch(err){
    if(localId) db.prepare('UPDATE orders SET status=?,payment_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run('payment_failed','failed',localId);
    console.error('Stripe checkout:',err);
    res.status(500).json({error:err.message||'Kunne ikke starte Stripe-betalingen.'});
  }
});

app.get('/api/checkout/order/:orderNumber', async (req,res)=>{
  const o=db.prepare('SELECT id,order_number,status,payment_provider,payment_status,provider_order_id,total_cents,currency,created_at FROM orders WHERE order_number=?').get(req.params.orderNumber);
  if(!o)return res.status(404).json({error:'Ordre ikke funnet'});

  const providerOrderId=String(req.query.order_id||req.query.session_id||o.provider_order_id||'').trim();
  if(providerOrderId && providerOrderId.length>0){
    try{
      if(o.payment_provider==='stripe'){
        if(!STRIPE_SECRET_KEY) return res.status(503).json({error:'Stripe er ikke konfigurert.'});
        if(o.provider_order_id && providerOrderId!==o.provider_order_id) return res.status(409).json({error:'Stripe-sesjonen er ikke knyttet til denne ordren.'});
        const session=await stripeRequest(`/checkout/sessions/${encodeURIComponent(providerOrderId)}`,{method:'GET'});
        const stripeAmount=Number(session.amount_total);
        const stripeCurrency=String(session.currency||'').toUpperCase();
        const expectedAmount=Number(o.total_cents);
        const expectedCurrency=String(o.currency||'NOK').toUpperCase();
        if(session.metadata?.order_number && session.metadata.order_number!==o.order_number){
          return res.status(409).json({error:'Stripe-ordren er ikke knyttet til riktig Cooper Supply-ordre.'});
        }
        if(!Number.isFinite(stripeAmount)||stripeAmount!==expectedAmount||stripeCurrency!==expectedCurrency){
          console.error('Stripe order mismatch:',{orderNumber:o.order_number,providerOrderId,stripeAmount,stripeCurrency,expectedAmount,expectedCurrency});
          return res.status(409).json({error:'Stripe-ordren stemmer ikke med Cooper Supply-ordren.'});
        }
        const state=applyStripeSessionState({...session,id:providerOrderId});
        if(!state.updated && state.reason!=='order_not_found') return res.status(409).json({error:'Stripe-sesjonen kunne ikke knyttes sikkert til ordren.'});
        if(state.status!=='authorized'){
          const fresh=db.prepare('SELECT id,order_number,status,payment_provider,payment_status,provider_order_id,total_cents,currency,created_at FROM orders WHERE id=?').get(o.id);
          return res.json(fresh);
        }
      }else{
        if(!KLARNA_USERNAME || !KLARNA_PASSWORD) return res.status(503).json({error:'Klarna er ikke konfigurert.'});
        const kr=await fetch(`${KLARNA_API_BASE}/ordermanagement/v1/orders/${encodeURIComponent(providerOrderId)}`,{method:'GET',headers:{Authorization:klarnaAuthHeader(),'Content-Type':'application/json','Cache-Control':'no-cache'}});
        const kb=await kr.json().catch(()=>({}));
        if(!kr.ok) throw new Error(kb.error_messages?.join(' ')||kb.error_message||`Klarna order lookup failed (${kr.status}).`);
        const klarnaAmount=Number(kb.order_amount);
        const klarnaCurrency=String(kb.purchase_currency||'').toUpperCase();
        const expectedAmount=Number(o.total_cents);
        const expectedCurrency=String(o.currency||'NOK').toUpperCase();
        if(!Number.isFinite(klarnaAmount)||klarnaAmount!==expectedAmount||klarnaCurrency!==expectedCurrency){
          console.error('Klarna order mismatch:',{orderNumber:o.order_number,providerOrderId,klarnaAmount,klarnaCurrency,expectedAmount,expectedCurrency});
          return res.status(409).json({error:'Klarna-ordren stemmer ikke med Cooper Supply-ordren.'});
        }
        const klarnaStatus=String(kb.status||'').toUpperCase();
        const authorized=['AUTHORIZED','PART_CAPTURED','CAPTURED'].includes(klarnaStatus);
        if(!authorized){
          db.prepare('UPDATE orders SET provider_order_id=?,status=?,payment_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(providerOrderId,'payment_pending',klarnaStatus.toLowerCase()||'unknown',o.id);
          const fresh=db.prepare('SELECT id,order_number,status,payment_provider,payment_status,provider_order_id,total_cents,currency,created_at FROM orders WHERE id=?').get(o.id);
          return res.json(fresh);
        }
        db.prepare('UPDATE orders SET provider_order_id=?,status=?,payment_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(providerOrderId,'authorized',klarnaStatus.toLowerCase(),o.id);
      }
    }catch(err){
      console.error(`${o.payment_provider||'payment'} order verification:`,err);
      return res.status(502).json({error:`Kunne ikke bekrefte ${o.payment_provider==='stripe'?'Stripe':'Klarna'}-ordren akkurat nå.`});
    }
  }

  const fresh=db.prepare('SELECT id,order_number,status,payment_provider,payment_status,provider_order_id,total_cents,currency,created_at FROM orders WHERE id=?').get(o.id);
  res.json(fresh);
});

app.get('/api/admin/summary',(req,res)=>{
  const counts=db.prepare('SELECT status, COUNT(*) count FROM products GROUP BY status').all();
  res.json({products:counts,categories:db.prepare('SELECT COUNT(*) count FROM categories').get().count,vehicles:db.prepare('SELECT COUNT(*) count FROM vehicles').get().count,engines:db.prepare('SELECT COUNT(*) count FROM engines').get().count});
});

app.get('/checkout', (req,res)=>res.sendFile(path.join(ROOT,'public','index.html')));
app.get('/checkout/:result', (req,res)=>res.sendFile(path.join(ROOT,'public','index.html')));
app.get('/products/:slug', (req,res)=>res.sendFile(path.join(ROOT,'public','index.html')));
app.use((req,res,next)=>{ if(req.path.startsWith('/api/')||req.path.startsWith('/uploads/')) return res.status(404).end(); if(req.method==='GET') return res.sendFile(path.join(ROOT,'public','index.html')); next(); });

app.listen(PORT,()=>console.log(`Cooper Supply ${APP_VERSION} running on http://localhost:${PORT}`));
