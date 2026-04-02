const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "aos.sqlite");
const LEGACY_JSON_FILE = path.join(DATA_DIR, "site.json");
const DEFAULT_CATEGORIES = [
  {
    slug: "qualcomm",
    name: "Qualcomm",
    icon: "chip",
    description: "Qualcomm firmware, test point files, XML packages, and flash resources for Huawei and Honor devices.",
  },
  {
    slug: "kirin",
    name: "Kirin",
    icon: "cpu",
    description: "Kirin firmware dumps, board software, and unbrick resources for Huawei and Honor models.",
  },
  {
    slug: "spd",
    name: "SPD",
    icon: "flash",
    description: "SPD service packages, drivers, and supported repair resources for compatible devices.",
  },
  {
    slug: "tools",
    name: "Tools",
    icon: "tool",
    description: "Flash tools, unlock utilities, drivers, and helper software for Huawei and Honor servicing.",
  },
  {
    slug: "remote-contact",
    name: "Remote Contact",
    icon: "support",
    description: "Remote service access, contact channels, and support resources.",
  },
];

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function defaultStore() {
  return {
    site: {
      name: "AOS-SOLUTION",
      tagline: "Huawei and Honor file solution archive with firmware, FRP, test point, and repair tools.",
      notice: "Huawei and Honor file solutions, verified firmware links, and service tool access.",
      logo: "/huawei-solutions.svg",
      telegram: "https://t.me/websolutionhub",
      whatsapp: "https://wa.me/6282234370999",
      contactNumber: "+6282234370999",
      facebook: "https://www.facebook.com/anggaaosunlocker",
      website: "https://aosunlock.my.id",
    },
    admin: {
      username: "admin",
      passwordHash: "240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9",
    },
    categories: DEFAULT_CATEGORIES,
    files: [],
  };
}

function normalizeStore(rawStore) {
  const store = rawStore || {};
  const defaults = defaultStore();

  return {
    site: {
      ...defaults.site,
      ...(store.site || {}),
    },
    admin: {
      ...defaults.admin,
      ...(store.admin || {}),
    },
    categories: Array.isArray(store.categories) ? store.categories : [],
    files: Array.isArray(store.files) ? store.files : [],
  };
}

function parseTags(rawTags) {
  if (Array.isArray(rawTags)) {
    return rawTags.filter(Boolean);
  }

  try {
    const parsed = JSON.parse(rawTags || "[]");
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

ensureDataDir();

const db = new DatabaseSync(DB_FILE);

function runInTransaction(callback) {
  db.exec("BEGIN");

  try {
    callback();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function initializeSchema() {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS site_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL,
      passwordHash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT NOT NULL,
      description TEXT NOT NULL,
      sortOrder INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      brand TEXT NOT NULL DEFAULT '',
      version TEXT NOT NULL DEFAULT '',
      price TEXT NOT NULL DEFAULT '',
      categorySlug TEXT NOT NULL,
      categoryName TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      password TEXT NOT NULL DEFAULT '',
      primaryLink TEXT NOT NULL,
      mirrorLink TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      fileSize TEXT NOT NULL DEFAULT '',
      featured INTEGER NOT NULL DEFAULT 0,
      hot INTEGER NOT NULL DEFAULT 0,
      downloadCount INTEGER NOT NULL DEFAULT 0,
      updatedAt TEXT NOT NULL
    );
  `);
}

function hydrateStoreFromDatabase() {
  const siteRows = db.prepare("SELECT key, value FROM site_settings").all();
  const adminRow = db.prepare("SELECT username, passwordHash FROM admin WHERE id = 1").get();
  const categories = db
    .prepare("SELECT slug, name, icon, description FROM categories ORDER BY sortOrder ASC, name ASC")
    .all();
  const files = db.prepare("SELECT * FROM files ORDER BY datetime(updatedAt) DESC, id DESC").all();

  return normalizeStore({
    site: Object.fromEntries(siteRows.map((row) => [row.key, row.value])),
    admin: adminRow || undefined,
    categories,
    files: files.map((file) => ({
      ...file,
      tags: parseTags(file.tags),
      featured: Boolean(file.featured),
      hot: Boolean(file.hot),
      downloadCount: Number(file.downloadCount || 0),
    })),
  });
}

function writeStore(store) {
  const normalizedStore = normalizeStore(store);

  runInTransaction(() => {
    db.exec("DELETE FROM site_settings");
    db.exec("DELETE FROM admin");
    db.exec("DELETE FROM categories");
    db.exec("DELETE FROM files");

    const siteInsert = db.prepare("INSERT INTO site_settings (key, value) VALUES (?, ?)");
    Object.entries(normalizedStore.site).forEach(([key, value]) => {
      siteInsert.run(key, String(value ?? ""));
    });

    db
      .prepare("INSERT INTO admin (id, username, passwordHash) VALUES (1, ?, ?)")
      .run(normalizedStore.admin.username, normalizedStore.admin.passwordHash);

    const categoryInsert = db.prepare(
      "INSERT INTO categories (slug, name, icon, description, sortOrder) VALUES (?, ?, ?, ?, ?)"
    );
    normalizedStore.categories.forEach((category, index) => {
      categoryInsert.run(
        category.slug,
        category.name,
        category.icon || "chip",
        category.description || "",
        index
      );
    });

    const fileInsert = db.prepare(`
      INSERT INTO files (
        id, title, slug, brand, version, price, categorySlug, categoryName, description,
        password, primaryLink, mirrorLink, tags, fileSize, featured, hot, downloadCount, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    normalizedStore.files.forEach((file) => {
      fileInsert.run(
        file.id,
        file.title,
        file.slug,
        file.brand || "",
        file.version || "",
        file.price || "",
        file.categorySlug,
        file.categoryName || "",
        file.description || "",
        file.password || "",
        file.primaryLink,
        file.mirrorLink || "",
        JSON.stringify(parseTags(file.tags)),
        file.fileSize || "",
        file.featured ? 1 : 0,
        file.hot ? 1 : 0,
        Number(file.downloadCount || 0),
        file.updatedAt
      );
    });
  });
}

function seedDatabaseIfEmpty() {
  const hasSettings = db.prepare("SELECT COUNT(*) AS total FROM site_settings").get().total;

  if (hasSettings > 0) {
    return;
  }

  let initialStore = defaultStore();

  if (fs.existsSync(LEGACY_JSON_FILE)) {
    try {
      initialStore = normalizeStore(JSON.parse(fs.readFileSync(LEGACY_JSON_FILE, "utf8")));
    } catch {
      initialStore = defaultStore();
    }
  }

  writeStore(initialStore);
}

function ensureSeedData() {
  const defaults = defaultStore();
  const settingsCount = db.prepare("SELECT COUNT(*) AS total FROM site_settings").get().total;
  const adminCount = db.prepare("SELECT COUNT(*) AS total FROM admin").get().total;
  const categoryCount = db.prepare("SELECT COUNT(*) AS total FROM categories").get().total;

  runInTransaction(() => {
    if (settingsCount === 0) {
      const siteInsert = db.prepare("INSERT INTO site_settings (key, value) VALUES (?, ?)");
      Object.entries(defaults.site).forEach(([key, value]) => {
        siteInsert.run(key, String(value ?? ""));
      });
    }

    if (adminCount === 0) {
      db
        .prepare("INSERT INTO admin (id, username, passwordHash) VALUES (1, ?, ?)")
        .run(defaults.admin.username, defaults.admin.passwordHash);
    }

    if (categoryCount === 0) {
      const categoryInsert = db.prepare(
        "INSERT INTO categories (slug, name, icon, description, sortOrder) VALUES (?, ?, ?, ?, ?)"
      );

      defaults.categories.forEach((category, index) => {
        categoryInsert.run(category.slug, category.name, category.icon, category.description, index);
      });
    }
  });
}

initializeSchema();
seedDatabaseIfEmpty();
ensureSeedData();

function readStore() {
  return hydrateStoreFromDatabase();
}

module.exports = {
  DB_FILE,
  readStore,
  writeStore,
};
