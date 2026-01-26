require("dotenv").config();

const puppeteer = require("puppeteer");
const cron = require("node-cron");
const axios = require("axios");

// ==================== CONFIGURATION ====================

const CONFIG = {
  category: {
    name: "MEN",
    url: "https://sheinindia.in/sheinverse/c/sverse-5939-37961?query=%3Arelevance%3Agenderfilter%3AMen",
  },
  telegramBotToken:"8421901165:AAHgAe2M0FzdCNt67dW9sjkTGHNtpQagIHA",
  telegramChatId:"8282846997",
  cronSchedule: "*/10 * * * *",
  maxRetries: 2,
  retryDelay: 5000,
};

// ==================== TELEGRAM ====================

async function sendTelegramNotification(message) {
  try {
    const url = `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`;
    await axios.post(url, {
      chat_id: CONFIG.telegramChatId,
      text: message,
      disable_web_page_preview: true,
    });
    console.log("✅ Telegram notification sent");
  } catch (error) {
    console.error("❌ Telegram error:", error.message);
  }
}

// ==================== SCRAPER ====================

async function scrapeStockCount(retryCount = 0) {
  let browser;

  try {
    console.log("🌐 Launching browser...");

    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();

    // Speed optimization
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const type = request.resourceType();
      if (["image", "font", "media", "stylesheet"].includes(type)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    await page.setViewport({ width: 1920, height: 1080 });

    console.log("📡 Opening MEN page...");
    await page.goto(CONFIG.category.url, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });

    console.log("⏳ Waiting for products...");
    await new Promise((r) => setTimeout(r, 12000));

    console.log("📜 Scrolling...");
    await page.evaluate(async () => {
      for (let i = 0; i < 8; i++) {
        window.scrollBy(0, 600);
        await new Promise((r) => setTimeout(r, 1000));
      }
    });

    const count = await page.evaluate(() => {
      const ids = new Set();
      const links = document.querySelectorAll('a[href*="/p/"]');

      links.forEach((link) => {
        const match = link.href.match(/\/p\/(\d+)_/);
        if (match) ids.add(match[1]);
      });

      return ids.size;
    });

    await browser.close();

    if (count === 0) {
      throw new Error("No products detected");
    }

    console.log(`✅ MEN Stock Count: ${count}`);
    return count;
  } catch (error) {
    if (browser) await browser.close().catch(() => {});

    console.error(`❌ Scrape error attempt ${retryCount + 1}:`, error.message);

    if (retryCount < CONFIG.maxRetries) {
      console.log(`🔄 Retrying in ${CONFIG.retryDelay / 1000}s...`);
      await new Promise((r) => setTimeout(r, CONFIG.retryDelay));
      return scrapeStockCount(retryCount + 1);
    }

    throw error;
  }
}

// ==================== MONITOR ====================

async function monitorStock() {
  console.log("\n========================================");
  console.log("🚀 Checking SHEIN MEN Stock...");
  console.log("========================================");

  try {
    const count = await scrapeStockCount();

    const time = new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      hour12: false,
    });

    const message = `📦 SHEIN MEN STOCK
Current Products: ${count}
Time: ${time}`;

    await sendTelegramNotification(message);
    console.log("✅ Stock update sent\n");
  } catch (error) {
    console.error("💥 Monitor failed:", error.message);

    await sendTelegramNotification(
      `⚠️ SHEIN MONITOR ERROR
${error.message}
Time: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`
    );
  }
}

// ==================== MAIN ====================

async function main() {


  console.log("🚀 SHEIN MEN STOCK MONITOR STARTED");

  await monitorStock();

  console.log(`⏰ Running every 10 minutes...\n`);
  cron.schedule(CONFIG.cronSchedule, monitorStock);
}

main();
