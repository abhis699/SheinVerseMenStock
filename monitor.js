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
      label: "MEN (Filtered)",
      url: "https://sheinindia.in/sheinverse/c/sverse-5939-37961?query=%3Arelevance%3Agenderfilter%3AMen%3Averticalsizegroupformat%3AL%3Averticalsizegroupformat%3A32%3Averticalsizegroupformat%3A34%3Averticalsizegroupformat%3AXXL%3Averticalsizegroupformat%3A38%3Apricerange%3ARs.500-1000%3Apricerange%3ABelow%20Rs.500&gridColumns=5",
    },
  ],

  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,

  snapshotFile: "stock.json",

  notifyThreshold: 50,          // 🔥 SEND MSG IF MEN ALL >= 50
  normalUpdateLinks: 10,

  scrapeCooldownMs: 4000,
};

// ================= TELEGRAM =================

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`;
  const MAX_LEN = 3800;

  for (let i = 0; i < text.length; i += MAX_LEN) {
    await axios.post(url, {
      chat_id: CONFIG.telegramChatId,
      text: text.slice(i, i + MAX_LEN),
      disable_web_page_preview: true,
    });
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log("✅ Telegram sent");
}

// ================= SNAPSHOT =================

function loadSnapshot() {
  if (!fs.existsSync(CONFIG.snapshotFile)) return {};
  return JSON.parse(fs.readFileSync(CONFIG.snapshotFile, "utf8"));
}

function saveSnapshot(data) {
  fs.writeFileSync(CONFIG.snapshotFile, JSON.stringify(data, null, 2));
}

// ================= SCRAPER =================

async function scrapeCategory(category) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (["image", "font", "media", "stylesheet"].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });

  console.log(`🌐 Opening ${category.label}`);

  await page.goto(category.url, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });

  await page.waitForSelector("a.rilrtl-products-list__link", {
    timeout: 45000,
  });

  await new Promise((r) => setTimeout(r, 3000));

  const data = await page.evaluate(() => {
    const countText =
      document.querySelector(".length strong")?.innerText || "";
    const totalItems = parseInt(countText.match(/\d+/)?.[0] || "0");

    const links = Array.from(
      document.querySelectorAll("a.rilrtl-products-list__link")
    ).map((a) => a.href);

    return { totalItems, links };
  });

  await browser.close();
  return data;
}

// ================= MAIN =================

async function runOnce() {
  console.log("🚀 STOCK MONITOR RUN");

  const snapshot = loadSnapshot();
  const newSnapshot = {};

  let menSection = "";
  let filteredSection = "";

  let menAllTotal = 0;
  let newlyAddedFilteredLinks = [];

  for (const category of CONFIG.categories) {
    const current = await scrapeCategory(category);
    const previous = snapshot[category.key] || { totalItems: 0, links: [] };

    const added = Math.max(0, current.totalItems - previous.totalItems);
    const removed = Math.max(0, previous.totalItems - current.totalItems);

    newSnapshot[category.key] = {
      totalItems: current.totalItems,
      links: current.links,
      time: Date.now(),
    };

    if (category.key === "MEN_ALL") {
      menAllTotal = current.totalItems;

      menSection = `1️⃣ MEN (All Products)
Total: ${current.totalItems}
Added: +${added}
Removed: -${removed}`;
    }

    if (category.key === "MEN_FILTERED") {
      newlyAddedFilteredLinks = current.links.filter(
        (l) => !previous.links.includes(l)
      );

      filteredSection = `2️⃣ MEN (Filtered)
Total: ${current.totalItems}
Added: +${added}
Removed: -${removed}`;
    }

    await new Promise((r) => setTimeout(r, CONFIG.scrapeCooldownMs));
  }

  // ================= SIMPLE NOTIFY LOGIC =================

  const shouldNotify = menAllTotal >= CONFIG.notifyThreshold;

  console.log("📊 MEN ALL total:", menAllTotal);
  console.log("📢 Notify threshold:", CONFIG.notifyThreshold);
  console.log("🚦 Should notify?", shouldNotify);

  if (shouldNotify) {
    const linksText = newlyAddedFilteredLinks
      .slice(0, CONFIG.normalUpdateLinks)
      .map((l) => `• ${l}`)
      .join("\n");

    const time = new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
    });

    const message = `📦 SHEIN STOCK

${menSection}

${filteredSection}

🔗 Top ${CONFIG.normalUpdateLinks} Newly Added Filtered Links:
${linksText || "No new links found"}

Updated: ${time}`;

    await sendTelegram(message);
  } else {
    console.log("ℹ️ No Telegram sent — MEN stock below threshold");
  }

  saveSnapshot(newSnapshot);
}

// ================= SCHEDULER =================

runOnce();
setInterval(runOnce, 6 * 60 * 1000);
