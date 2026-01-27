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
  alertThreshold: 30,     // 🚨 Alert when filtered >= 30
  alertLinksCount: 15,    // 🔗 Links in alert
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

    await new Promise((r) => setTimeout(r, 300));
  }

  console.log("✅ Telegram sent");
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

// ================= SCRAPER =================

async function scrapeCategory(category, retry = 0) {
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();

    // Real browser fingerprint
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
    );

    // Reduce bandwidth
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
      timeout: 120000,
    });

    // Safer selector
    await page.waitForSelector("a.rilrtl-products-list__link", {
      timeout: 60000,
    });

    await new Promise((r) => setTimeout(r, 6000));

    const data = await page.evaluate(() => {
      const countText =
        document.querySelector(".length strong")?.innerText || "";
      const totalItems = parseInt(
        countText.match(/\d+/)?.[0] || "0"
      );

      const links = Array.from(
        document.querySelectorAll("a.rilrtl-products-list__link")
      ).map((a) => a.href);

      return { totalItems, links };
    });

    await browser.close();

    if (!data.totalItems) throw new Error("No products detected");

    return data;
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error(
      `❌ ${category.key} scrape failed (${retry + 1}):`,
      err.message
    );

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

  // ================= PARALLEL SAFE SCRAPE =================

  const results = await Promise.allSettled(
    CONFIG.categories.map((cat) => scrapeCategory(cat))
  );

  CONFIG.categories.forEach((category, index) => {
    const result = results[index];

    if (result.status !== "fulfilled") {
      console.error(`❌ ${category.key} failed this cycle`);
      return;
    }

    const current = result.value;
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
      filteredLinks = current.links || [];
      filteredTotal = current.totalItems;

      filteredSection = `2️⃣ MEN (Filtered)
Total: ${current.totalItems}
Added: +${added}
Removed: -${removed}`;
    }
  });

  // ================= 🚨 ALERT =================

  const previousFiltered = snapshot?.MEN_FILTERED?.totalItems || 0;

  const crossedUp =
    previousFiltered < CONFIG.alertThreshold &&
    filteredTotal >= CONFIG.alertThreshold;

  if (crossedUp) {
    const alertLinks = filteredLinks
      .slice(0, CONFIG.alertLinksCount)
      .map((l) => `• ${l}`)
      .join("\n");

    const alertMsg = `🚨🚨🚨 FILTERED STOCK ALERT 🚨🚨🚨

MEN Filtered stock crossed ${CONFIG.alertThreshold}+

Current Stock: ${filteredTotal}

🔥 Top ${CONFIG.alertLinksCount} Products:
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

🔗 Top ${CONFIG.normalUpdateLinks} Filtered Links:
${normalLinks || "No links found"}

Updated: ${time}`;

  await sendTelegram(message);
}

// ================= SCHEDULER =================

runOnce();

setInterval(runOnce, 6 * 60 * 1000);  