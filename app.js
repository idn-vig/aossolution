const express = require("express");
const session = require("express-session");
const path = require("path");
const crypto = require("crypto");
const { readStore, writeStore, DB_FILE } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_PRICE = "$10";
const METADATA_TIMEOUT_MS = 8000;

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function hashPassword(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function ensureUniqueSlug(baseSlug, items, currentId) {
  const cleanBase = baseSlug || `item-${Date.now()}`;
  let slug = cleanBase;
  let counter = 1;

  while (items.some((item) => item.slug === slug && item.id !== currentId)) {
    counter += 1;
    slug = `${cleanBase}-${counter}`;
  }

  return slug;
}

function getCategoryWithCount(store) {
  return store.categories.map((category) => ({
    ...category,
    totalFiles: store.files.filter((file) => file.categorySlug === category.slug).length,
  }));
}

function formatBytes(bytes) {
  const size = Number(bytes || 0);

  if (!size || Number.isNaN(size)) {
    return "";
  }

  if (size >= 1024 ** 3) {
    const value = size / 1024 ** 3;
    return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)}`.replace(/\.0$/, "").replace(/(\.\d)0$/, "$1") + " GB";
  }

  if (size >= 1024 ** 2) {
    const value = size / 1024 ** 2;
    return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)}`.replace(/\.0$/, "") + " MB";
  }

  return `${Math.round(size / 1024)} KB`;
}

function extractSizeFromText(value) {
  const match = String(value || "").match(/(\d+(?:[.,]\d+)?)\s*(GB|MB|KB)/i);

  if (!match) {
    return "";
  }

  return `${match[1].replace(",", ".")} ${match[2].toUpperCase()}`;
}

function getDefaultPassword(site) {
  try {
    return new URL(site.website).hostname.replace(/^www\./, "");
  } catch {
    return "aosunlock.my.id";
  }
}

function guessBrand(value) {
  const text = String(value || "").toLowerCase();

  if (text.includes("honor")) {
    return "Honor";
  }

  if (text.includes("huawei") || text.includes("kirin")) {
    return "Huawei";
  }

  return "Huawei / Honor";
}

function guessCategorySlug(value, categories, currentSlug) {
  const text = String(value || "").toLowerCase();
  const rules = [
    { slug: "remote-contact", keywords: ["remote", "support", "contact", "anydesk", "teamviewer"] },
    { slug: "tools", keywords: ["tool", "driver", "unlock", "dongle", "setup", "usb"] },
    { slug: "spd", keywords: ["spd", "spreadtrum", "pac"] },
    { slug: "qualcomm", keywords: ["qualcomm", "qcom", "edl", "firehose", "loader", "xml", "test point", "9008"] },
    { slug: "kirin", keywords: ["kirin", "hisilicon", "board software", "update.app", "erecovery", "ota"] },
  ];

  const matched = rules.find((rule) => rule.keywords.some((keyword) => text.includes(keyword)));

  if (matched && categories.some((category) => category.slug === matched.slug)) {
    return matched.slug;
  }

  if (currentSlug && categories.some((category) => category.slug === currentSlug)) {
    return currentSlug;
  }

  return "";
}

function extractVersion(value) {
  const text = String(value || "");
  const patterns = [
    /\b(?:HarmonyOS|EMUI)\s*[\d.]+/i,
    /\b(?:V|v)\s*\d+(?:\.\d+)+\b/,
    /\b\d+\.\d+\.\d+(?:\.\d+)?\b/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[0].replace(/\s+/g, " ").trim();
    }
  }

  return "";
}

function buildTags({ title, brand, categoryName }) {
  const tagSet = new Set();
  const combined = `${title || ""} ${brand || ""} ${categoryName || ""}`
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3);

  [brand, categoryName, "huawei", "honor"].forEach((value) => {
    String(value || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3)
      .forEach((token) => tagSet.add(token));
  });

  combined.slice(0, 6).forEach((token) => tagSet.add(token));

  return Array.from(tagSet).slice(0, 8);
}

function buildDescription({ title, brand, categoryName }) {
  const brandLabel = brand || "Huawei / Honor";
  const categoryLabel = categoryName || "file solution";

  return `${title} package for ${brandLabel} devices. Includes the main ${categoryLabel.toLowerCase()} resources for service and repair use.`;
}

function parseTags(value) {
  return String(value || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function parseContentDispositionFilename(value) {
  const header = String(value || "");
  const utfMatch = header.match(/filename\*=UTF-8''([^;]+)/i);

  if (utfMatch) {
    try {
      return decodeURIComponent(utfMatch[1]).replace(/["']/g, "").trim();
    } catch {
      return utfMatch[1].replace(/["']/g, "").trim();
    }
  }

  const plainMatch = header.match(/filename="?([^"]+)"?/i);
  return plainMatch ? plainMatch[1].trim() : "";
}

async function fetchLinkMetadata(rawUrl) {
  const url = String(rawUrl || "").trim();

  if (!url) {
    return { fileSize: "", fileName: "", warnings: [] };
  }

  const parsedUrl = new URL(url);
  const host = parsedUrl.hostname.toLowerCase();
  const pathname = parsedUrl.pathname.toLowerCase();

  if (host.includes("drive.google.com") && pathname.includes("/folders/")) {
    return {
      fileSize: "",
      fileName: "",
      warnings: ["Google Drive folder link detected. Size cannot be read automatically. Use a direct file link or fill the size manually."],
    };
  }

  if (host.includes("drive.google.com") && pathname.includes("/file/d/")) {
    return {
      fileSize: "",
      fileName: "",
      warnings: [
        "Google Drive view link detected. The page size is not the real file size. Please fill the size manually or use a direct download link.",
      ],
    };
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("Only http and https links are supported.");
  }

  const warnings = [];
  const requestHeaders = {
    "user-agent": "Mozilla/5.0 AOS-Solution Metadata Bot",
    range: "bytes=0-0",
  };

  for (const method of ["HEAD", "GET"]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method,
        redirect: "follow",
        headers: requestHeaders,
        signal: controller.signal,
      });

      const contentDisposition = response.headers.get("content-disposition");
      const contentRange = response.headers.get("content-range");
      const directLength = response.headers.get("content-length");
      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      const finalUrl = response.url || url;
      const fileName =
        parseContentDispositionFilename(contentDisposition) ||
        decodeURIComponent(finalUrl.split("/").pop() || "").split("?")[0];

      let totalBytes = 0;

      if (contentRange) {
        const rangeMatch = contentRange.match(/\/(\d+)$/);
        if (rangeMatch) {
          totalBytes = Number(rangeMatch[1]);
        }
      }

      if (!totalBytes && directLength && (method === "HEAD" || response.status === 200)) {
        totalBytes = Number(directLength);
      }

      if (response.body && typeof response.body.cancel === "function") {
        response.body.cancel().catch(() => {});
      }

      const formattedSize = formatBytes(totalBytes) || extractSizeFromText(`${fileName} ${finalUrl}`);

      if (!formattedSize) {
        if (host.includes("drive.google.com")) {
          warnings.push("Google Drive page link detected. Size is not available unless you use a direct downloadable file link.");
        } else if (contentType.includes("text/html")) {
          warnings.push("This link points to a web page, not a direct file, so size could not be read automatically.");
        } else {
          warnings.push("The host did not expose file size automatically.");
        }
      }

      clearTimeout(timer);

      return {
        fileSize: formattedSize,
        fileName,
        warnings,
      };
    } catch (error) {
      clearTimeout(timer);

      if (method === "GET") {
        warnings.push("The host did not expose file size automatically.");
      }
    }
  }

  return { fileSize: "", fileName: "", warnings };
}

async function buildAutoDraft({ title, primaryLink, store, categorySlug }) {
  const metadata = await fetchLinkMetadata(primaryLink);
  const combinedSource = [title, metadata.fileName, primaryLink].filter(Boolean).join(" ");
  const brand = guessBrand(combinedSource);
  const resolvedCategorySlug = guessCategorySlug(combinedSource, store.categories, categorySlug);
  const category = store.categories.find((item) => item.slug === resolvedCategorySlug);
  const version = extractVersion(combinedSource);
  const fileSize = metadata.fileSize || extractSizeFromText(combinedSource);
  const resolvedTitle =
    String(title || "").trim() ||
    metadata.fileName.replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[_-]+/g, " ").trim();

  const warnings = [...metadata.warnings];

  if (!resolvedCategorySlug) {
    warnings.push("Category could not be guessed automatically from this title/link. Please choose it manually.");
  }

  return {
    title: resolvedTitle,
    brand,
    version,
    price: DEFAULT_PRICE,
    categorySlug: category?.slug || "",
    categoryName: category?.name || "",
    description: buildDescription({ title: resolvedTitle || "Huawei / Honor file", brand, categoryName: category?.name || "file solution" }),
    password: getDefaultPassword(store.site),
    fileSize,
    tags: buildTags({ title: resolvedTitle, brand, categoryName: category?.name }),
    downloadCount: 0,
    warnings,
  };
}

function requireAdmin(req, res, next) {
  if (!req.session.adminUser) {
    req.session.flash = { type: "error", message: "Please sign in to access the admin dashboard." };
    return res.redirect("/admin/login");
  }
  next();
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(
  session({
    secret: "web-solution-secret",
    resave: false,
    saveUninitialized: false,
  })
);

app.use((req, res, next) => {
  const store = readStore();
  const flash = req.session.flash;
  delete req.session.flash;

  res.locals.flash = flash;
  res.locals.currentPath = req.path;
  res.locals.adminUser = req.session.adminUser;
  res.locals.siteCategories = store.categories;
  next();
});

app.get("/", (req, res) => {
  const store = readStore();
  const files = [...store.files].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  res.render("index", {
    site: store.site,
    siteCategories: store.categories,
    categories: getCategoryWithCount(store),
    featuredFiles: files.filter((file) => file.featured).slice(0, 4),
    recentFiles: files.slice(0, 12),
    popularFiles: [...files].sort((a, b) => b.downloadCount - a.downloadCount).slice(0, 5),
    totalFiles: files.length,
  });
});

app.get("/files", (req, res) => {
  const store = readStore();
  const search = (req.query.q || "").trim().toLowerCase();
  const category = req.query.category || "";

  let files = [...store.files].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  if (category) {
    files = files.filter((file) => file.categorySlug === category);
  }

  if (search) {
    files = files.filter((file) =>
      [file.title, file.brand, file.description, file.tags.join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(search)
    );
  }

  const activeCategory = store.categories.find((item) => item.slug === category);

  res.render("files", {
    site: store.site,
    siteCategories: store.categories,
    categories: getCategoryWithCount(store),
    files,
    search,
    activeCategory,
  });
});

app.get("/category/:slug", (req, res) => {
  res.redirect(`/files?category=${encodeURIComponent(req.params.slug)}`);
});

app.get("/file/:slug", (req, res) => {
  const store = readStore();
  const file = store.files.find((item) => item.slug === req.params.slug);

  if (!file) {
    return res.status(404).render("404", { site: store.site, siteCategories: store.categories });
  }

  const relatedFiles = store.files
    .filter((item) => item.categorySlug === file.categorySlug && item.id !== file.id)
    .slice(0, 3);
  const category = store.categories.find((item) => item.slug === file.categorySlug);

  res.render("detail", {
    site: store.site,
    siteCategories: store.categories,
    file,
    category,
    relatedFiles,
  });
});

app.get("/admin/login", (req, res) => {
    if (req.session.adminUser) {
      return res.redirect("/admin");
    }

  const store = readStore();
  res.render("admin/login", { site: store.site });
});

app.post("/admin/login", (req, res) => {
  const store = readStore();
  const { username, password } = req.body;

    if (
      username === store.admin.username &&
      hashPassword(password || "") === store.admin.passwordHash
    ) {
      req.session.adminUser = username;
      req.session.flash = { type: "success", message: "Admin login successful." };
      return res.redirect("/admin");
    }

    req.session.flash = { type: "error", message: "Invalid username or password." };
    res.redirect("/admin/login");
  });

app.get("/admin/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/admin/login");
  });
});

app.get("/admin", requireAdmin, (req, res) => {
  const store = readStore();
  const files = [...store.files].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  res.render("admin/dashboard", {
    site: store.site,
    files,
    categories: getCategoryWithCount(store),
    stats: {
      totalFiles: store.files.length,
      totalCategories: store.categories.length,
      featuredFiles: store.files.filter((file) => file.featured).length,
      hotFiles: store.files.filter((file) => file.hot).length,
    },
  });
});

app.get("/admin/files/new", requireAdmin, (req, res) => {
  const store = readStore();

  res.render("admin/form", {
    site: store.site,
    categories: store.categories,
    file: null,
    formAction: "/admin/files",
    pageTitle: "Add New File",
  });
});

app.post("/admin/link-preview", requireAdmin, async (req, res) => {
  try {
    const store = readStore();
    const title = (req.body.title || "").trim();
    const primaryLink = (req.body.primaryLink || "").trim();

    if (!primaryLink) {
      return res.status(400).json({ ok: false, message: "Paste the primary link first." });
    }

    const draft = await buildAutoDraft({
      title,
      primaryLink,
      store,
      categorySlug: (req.body.categorySlug || "").trim(),
    });

    const warningText = draft.warnings.length ? ` ${draft.warnings.join(" ")}` : "";

    res.json({
      ok: true,
      data: draft,
      message: `Auto fill complete.${warningText}`.trim(),
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      message: error.message || "Could not analyze this link.",
    });
  }
});

app.post("/admin/files", requireAdmin, async (req, res) => {
  const store = readStore();
  const title = (req.body.title || "").trim();
  const primaryLink = (req.body.primaryLink || "").trim();

  if (!title || !primaryLink) {
    req.session.flash = { type: "error", message: "Title and primary link are required." };
    return res.redirect("/admin/files/new");
  }

  const autoDraft = await buildAutoDraft({
    title,
    primaryLink,
    store,
    categorySlug: (req.body.categorySlug || "").trim(),
  });
  const resolvedCategorySlug = ((req.body.categorySlug || "").trim() || autoDraft.categorySlug);
  const category = store.categories.find((item) => item.slug === resolvedCategorySlug);

  if (!category) {
    req.session.flash = { type: "error", message: "Please choose the correct category before saving." };
    return res.redirect("/admin/files/new");
  }

  const file = {
    id: String(Date.now()),
    title,
    slug: ensureUniqueSlug(slugify(title), store.files),
    brand: (req.body.brand || "").trim() || autoDraft.brand,
    version: (req.body.version || "").trim() || autoDraft.version,
    price: (req.body.price || "").trim() || DEFAULT_PRICE,
    categorySlug: category.slug,
    categoryName: category.name,
    description: (req.body.description || "").trim() || autoDraft.description,
    password: (req.body.password || "").trim() || autoDraft.password,
    primaryLink,
    mirrorLink: (req.body.mirrorLink || "").trim(),
    tags: parseTags(req.body.tags).length ? parseTags(req.body.tags) : autoDraft.tags,
    fileSize: (req.body.fileSize || "").trim() || autoDraft.fileSize,
    featured: req.body.featured === "on",
    hot: req.body.hot === "on",
    downloadCount: Number(req.body.downloadCount || autoDraft.downloadCount || 0),
    updatedAt: new Date().toISOString(),
  };

  store.files.unshift(file);
  writeStore(store);

  req.session.flash = { type: "success", message: "New file added successfully." };
  res.redirect("/admin");
});

app.get("/admin/files/:id/edit", requireAdmin, (req, res) => {
  const store = readStore();
  const file = store.files.find((item) => item.id === req.params.id);

  if (!file) {
    req.session.flash = { type: "error", message: "File data was not found." };
    return res.redirect("/admin");
  }

  res.render("admin/form", {
    site: store.site,
    categories: store.categories,
    file,
    formAction: `/admin/files/${file.id}/update`,
    pageTitle: `Edit ${file.title}`,
  });
});

app.post("/admin/files/:id/update", requireAdmin, async (req, res) => {
  const store = readStore();
  const file = store.files.find((item) => item.id === req.params.id);
  const title = (req.body.title || "").trim();
  const primaryLink = (req.body.primaryLink || "").trim();

  if (!file || !title || !primaryLink) {
    req.session.flash = { type: "error", message: "File, title, and primary link must be valid." };
    return res.redirect("/admin");
  }

  const autoDraft = await buildAutoDraft({
    title,
    primaryLink,
    store,
    categorySlug: (req.body.categorySlug || "").trim() || file.categorySlug,
  });
  const resolvedCategorySlug = ((req.body.categorySlug || "").trim() || autoDraft.categorySlug || file.categorySlug);
  const category = store.categories.find((item) => item.slug === resolvedCategorySlug);

  if (!category) {
    req.session.flash = { type: "error", message: "Please choose the correct category before saving." };
    return res.redirect("/admin");
  }

  file.title = title;
  file.slug = ensureUniqueSlug(slugify(title), store.files, file.id);
  file.brand = (req.body.brand || "").trim() || file.brand || autoDraft.brand;
  file.version = (req.body.version || "").trim() || file.version || autoDraft.version;
  file.price = (req.body.price || "").trim() || file.price || DEFAULT_PRICE;
  file.categorySlug = category.slug;
  file.categoryName = category.name;
  file.description = (req.body.description || "").trim() || file.description || autoDraft.description;
  file.password = (req.body.password || "").trim() || file.password || autoDraft.password;
  file.primaryLink = primaryLink;
  file.mirrorLink = (req.body.mirrorLink || "").trim();
  file.tags = parseTags(req.body.tags).length ? parseTags(req.body.tags) : file.tags.length ? file.tags : autoDraft.tags;
  file.fileSize = (req.body.fileSize || "").trim() || file.fileSize || autoDraft.fileSize;
  file.featured = req.body.featured === "on";
  file.hot = req.body.hot === "on";
  file.downloadCount = Number(req.body.downloadCount || 0);
  file.updatedAt = new Date().toISOString();

  writeStore(store);

  req.session.flash = { type: "success", message: "File updated successfully." };
  res.redirect("/admin");
});

app.post("/admin/files/:id/delete", requireAdmin, (req, res) => {
  const store = readStore();
  const initialLength = store.files.length;
  store.files = store.files.filter((item) => item.id !== req.params.id);

  if (store.files.length === initialLength) {
    req.session.flash = { type: "error", message: "File was not found." };
    return res.redirect("/admin");
  }

  writeStore(store);
  req.session.flash = { type: "success", message: "File deleted successfully." };
  res.redirect("/admin");
});

app.get("/admin/settings", requireAdmin, (req, res) => {
  const store = readStore();
  res.render("admin/settings", { site: store.site, admin: store.admin });
});

app.post("/admin/settings", requireAdmin, (req, res) => {
  const store = readStore();

  store.site.name = (req.body.siteName || "").trim();
  store.site.tagline = (req.body.tagline || "").trim();
  store.site.notice = (req.body.notice || "").trim();
  store.site.logo = (req.body.logo || "").trim() || store.site.logo;
  store.site.telegram = (req.body.telegram || "").trim();
  store.site.whatsapp = (req.body.whatsapp || "").trim();
  store.site.contactNumber = (req.body.contactNumber || "").trim();
  store.site.facebook = (req.body.facebook || "").trim();
  store.site.website = (req.body.website || "").trim();

  store.admin.username = (req.body.username || "").trim() || store.admin.username;

  if ((req.body.newPassword || "").trim()) {
    store.admin.passwordHash = hashPassword(req.body.newPassword.trim());
  }

  writeStore(store);
  req.session.flash = { type: "success", message: "Website settings saved successfully." };
  res.redirect("/admin/settings");
});

app.use((req, res) => {
  const store = readStore();
  res.status(404).render("404", { site: store.site, siteCategories: store.categories });
});

app.listen(PORT, () => {
  console.log(`Web Solution running at http://localhost:${PORT}`);
  console.log(`SQLite database: ${DB_FILE}`);
});
