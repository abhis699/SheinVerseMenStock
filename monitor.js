require("dotenv").config();

const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");
const express = require("express");

// ================= KEEP ALIVE SERVER =================

const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.send("Shein Stock Bot Running");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Keep-alive server running on port", PORT);
});

// ================= CONFIG =================

const CONFIG = {
  categories: [
    {
      key: "MEN_ALL",
      label: "MEN (All Products)",
      url: "https://sheinindia.in/sheinverse/c/sverse-5939-37961?query=%3Arelevance%3Agenderfilter%3AMen",
    },
    {
      key: "MEN_FILTERED",
      label: "MEN (L, XL, 28, 30, 32)",
      url: "https://sheinindia.in/sheinverse/c/sverse-5939-37961?query=%3Arelevance%3Agenderfilter%3AMen%3Averticalsizegroupformat%3AL%3Averticalsizegroupformat%3AXL%3Averticalsizegroupformat%3A28%3Averticalsizegroupformat%3A30%3Averticalsizegroupformat%3A32&gridColumns=5",
    },
  ],

  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,

  snapshotFile: "stock.json",

  maxRetries: 2,
  retryDelay: 5000,

  normalUpdateLinks: 10,   // 🔗 Links in normal update
  maxFilteredLinks: 30,    // 🚨 Links in BIG ALERT
  filteredThreshold: 30,  // 🚨 Alert trigger
};

// ================= TELEGRAM (AUTO SPLIT SAFE) =================

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`;
  const MAX_LEN = 3800;

  const chunks = [];
  for (let i = 0; i < text.length; i += MAX_LEN) {
    chunks.push(text.slice(i, i + MAX_LEN));
  }

  for (const chunk of chunks) {
    await axios.post(url, {
      chat_id: CONFIG.telegramChatId,
      text: chunk,
      disable_web_page_preview: true,
    });

    await new Promise((r) => setTimeout(r, 400));
  }

  console.log("✅ Telegram sent (split-safe)");
}

// ================= SNAPSHOT =================

function loadSnapshot() {
  try {
    if (!fs.existsSync(CONFIG.snapshotFile)) return {};
    return JSON.parse(fs.readFileSync(CONFIG.snapshotFile, "utf8"));
  } catch {
    return {};
  }
}

function saveSnapshot(data) {
  fs.writeFileSync(CONFIG.snapshotFile, JSON.stringify(data, null, 2));
}

// ================= NEWEST SORT HELPERS =================

function getProductIdFromLink(link) {
  const match = link.match(/(\d{8,})/);
  return match ? Number(match[1]) : 0;
}

function sortNewestFirst(links = []) {
  return [...links].sort(
    (a, b) => getProductIdFromLink(b) - getProductIdFromLink(a)
  );
}

// ================= SCRAPER =================

async function scrapeCategory(category, retry = 0) {
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (["image", "font", "media", "stylesheet"].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setViewport({ width: 1280, height: 800 });

    console.log(`🌐 Opening ${category.label}`);
    await page.goto(category.url, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.waitForSelector(".item", { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 3000));

    const data = await page.evaluate(() => {
      const countText =
        document.querySelector(".length strong")?.innerText || "";
      const totalItems = parseInt(
        countText.match(/\d+/)?.[0] || "0"
      );

      const links = Array.from(
        document.querySelectorAll(".item a.rilrtl-products-list__link")
      ).map((a) => a.href);

      return { totalItems, links };
    });

    await browser.close();

    if (!data.totalItems) throw new Error("No products detected");

    return data;
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error(`❌ ${category.key} scrape failed (${retry + 1})`);

    if (retry < CONFIG.maxRetries) {
      await new Promise((r) => setTimeout(r, CONFIG.retryDelay));
      return scrapeCategory(category, retry + 1);
    }

    throw err;
  }
}

// ================= DIFF =================

function calculateDiff(oldCount, newCount) {
  return {
    added: Math.max(0, newCount - oldCount),
    removed: Math.max(0, oldCount - newCount),
  };
}

// ================= MAIN =================

async function runOnce() {
  console.log("🚀 STOCK MONITOR RUN");

  const snapshot = loadSnapshot();
  const newSnapshot = {};

  let menSection = "";
  let filteredSection = "";

  let filteredLinks = [];
  let filteredTotal = 0;

  // ================= PARALLEL SCRAPE =================

  const results = await Promise.all(
    CONFIG.categories.map((cat) => scrapeCategory(cat))
  );

  CONFIG.categories.forEach((category, index) => {
    const current = results[index];
    const previous = snapshot[category.key];

    let added = 0;
    let removed = 0;

    if (previous?.totalItems !== undefined) {
      const diff = calculateDiff(
        previous.totalItems,
        current.totalItems
      );
      added = diff.added;
      removed = diff.removed;
    }

    newSnapshot[category.key] = {
      totalItems: current.totalItems,
      links: current.links,
      time: Date.now(),
    };

    if (category.key === "MEN_ALL") {
      menSection = `1️⃣ MEN (All Products)
Total: ${current.totalItems}
Added: +${added}
Removed: -${removed}`;
    }

    if (category.key === "MEN_FILTERED") {
      filteredLinks = sortNewestFirst(current.links || []);
      filteredTotal = current.totalItems;

      filteredSection = `2️⃣ MEN (Filtered)
Total: ${current.totalItems}
Added: +${added}
Removed: -${removed}`;
    }
  });

  // ================= 🚨 THRESHOLD ALERT =================

  const previousFiltered = snapshot?.MEN_FILTERED?.totalItems || 0;

  const crossedUp =
    previousFiltered < CONFIG.filteredThreshold &&
    filteredTotal >= CONFIG.filteredThreshold;

  if (crossedUp) {
    const alertLinks = filteredLinks
      .slice(0, CONFIG.maxFilteredLinks)
      .map((l) => `• ${l}`)
      .join("\n");

    const alertMsg = `🚨🚨🚨 BIG STOCK ALERT 🚨🚨🚨

🔥 MEN FILTERED STOCK CROSSED ${CONFIG.filteredThreshold}+ 🔥

Current Stock: ${filteredTotal}

🛒 TOP ${CONFIG.maxFilteredLinks} NEWEST PRODUCTS:
${alertLinks || "No links found"}

⏰ ${new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
    })}`;

    await sendTelegram(alertMsg);
  }

  saveSnapshot(newSnapshot);

  // ================= NORMAL UPDATE =================

  const normalLinks = filteredLinks
    .slice(0, CONFIG.normalUpdateLinks)
    .map((l) => `• ${l}`)
    .join("\n");

  const time = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
  });

  const message = `📦 SHEIN STOCK UPDATE

${menSection}

${filteredSection}

🔗 TOP ${CONFIG.normalUpdateLinks} NEWEST FILTERED LINKS IS HERE:
${normalLinks || "No links found"}

Updated: ${time}`;

  await sendTelegram(message);
}

// ================= SCHEDULER =================

runOnce();
setInterval(runOnce, 5 * 60 * 1000);
