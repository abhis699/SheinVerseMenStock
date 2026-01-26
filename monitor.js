require("dotenv").config();

const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");
const express = require("express");

// ================= SAFETY =================

process.on("unhandledRejection", async (err) => {
  console.error("Unhandled Promise:", err);
  await sendErrorAlert(err);
});

process.on("uncaughtException", async (err) => {
  console.error("Uncaught Exception:", err);
  await sendErrorAlert(err);
});

let isRunning = false;

// ================= KEEP ALIVE SERVER =================

const app = express();
app.get("/", (req, res) => {
  res.send("OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
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
};

// ================= TELEGRAM =================

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`;

  await axios.post(url, {
    chat_id: CONFIG.telegramChatId,
    text,
    disable_web_page_preview: true,
  });

  console.log("✅ Telegram sent");
}

// ================= ERROR ALERT =================

async function sendErrorAlert(error) {
  try {
    const message = `🚨 BOT ERROR ALERT

${error?.message || error}

Time: ${new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
    })}`;

    await sendTelegram(message);
  } catch (err) {
    console.error("Failed to send error alert:", err.message);
  }
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
  headless: true,
  
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--single-process",
    "--no-zygote",
  ],
});


    const page = await browser.newPage();

    // Reduce bandwidth
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (
        ["image", "font", "media", "stylesheet", "other"].includes(type)
      ) {
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

      const firstProduct = document.querySelector(
        ".item a.rilrtl-products-list__link"
      );

      return {
        totalItems,
        productLink: firstProduct?.href || null,
      };
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

    await sendErrorAlert(err);
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
  if (isRunning) {
    console.log("⏳ Previous run still active, skipping...");
    return;
  }

  isRunning = true;

  try {
    console.log("🚀 STOCK MONITOR RUN");

    const snapshot = loadSnapshot();
    const newSnapshot = {};
    const sections = [];

    for (const category of CONFIG.categories) {
      const current = await scrapeCategory(category);
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
        time: Date.now(),
      };

      sections.push(
        `🔹 ${category.label}
Total: ${current.totalItems}
Added: +${added}
Removed: -${removed}
Sample: ${current.productLink || "N/A"}`
      );
    }

    saveSnapshot(newSnapshot);

    const time = new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
    });

    const message = `📦 SHEIN STOCK UPDATE

${sections.join("\n\n")}

Updated: ${time}`;

    await sendTelegram(message);
  } catch (err) {
    console.error("Run failed:", err.message);
    await sendErrorAlert(err);
  } finally {
    isRunning = false;
  }
}

// ================= SCHEDULER =================

// Run immediately
runOnce();

// Run every 10 minutes
setInterval(runOnce, 10 * 60 * 1000);
