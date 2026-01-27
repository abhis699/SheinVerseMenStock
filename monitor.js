require("dotenv").config();

const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");

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

  maxFilteredLinks: 10,     // Top 10 links in section 2
  pincode: "110096",        // 🔴 Change to your pincode
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

// ================= PINCODE HELPERS =================

// Extract numeric product code from URL
function extractProductCode(url) {
  if (!url) return null;
  const match = url.match(/(\d{8,})/); // long numeric id
  return match ? match[1] : null;
}

// Call SHEIN delivery API
async function checkPincodeAvailability(productCode) {
  try {
    const res = await axios.get(
      "https://www.sheinindia.in/api/edd/checkDeliveryDetails",
      {
        params: {
          productCode,
          postalCode: CONFIG.pincode,
          quantity: 1,
          IsExchange: false,
        },
        timeout: 15000,
      }
    );
    return res.data;
  } catch (err) {
    console.error("❌ Pincode API failed:", productCode);
    return null;
  }
}

// Decide deliverable or not
function isDeliverable(apiData) {
  if (!apiData) return false;

  if (typeof apiData.servicability === "boolean") {
    return apiData.servicability === true;
  }

  if (
    Array.isArray(apiData.productDetails) &&
    apiData.productDetails.length > 0
  ) {
    return apiData.productDetails[0].servicability === true;
  }

  return false;
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
  let pincodeSection = "";

  let filteredLinks = [];

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
      links: current.links,
      time: Date.now(),
    };

    // -------- MEN ALL --------
    if (category.key === "MEN_ALL") {
      menSection = `1️⃣ MEN (All Products)
Total: ${current.totalItems}
Added: +${added}
Removed: -${removed}`;
    }

    // -------- MEN FILTERED --------
    if (category.key === "MEN_FILTERED") {
      filteredLinks = current.links || [];

      const topLinks = filteredLinks
        .slice(0, CONFIG.maxFilteredLinks)
        .map((l) => `• ${l}`)
        .join("\n");

      filteredSection = `2️⃣ MEN (Filtered)
Total: ${current.totalItems}
Added: +${added}
Removed: -${removed}

🔗 Top ${CONFIG.maxFilteredLinks} Links:
${topLinks || "No links found"}`;
    }
  }

  // ================= PINCODE DELIVERABLE =================

  const deliverableLinks = [];

  for (const link of filteredLinks) {
    const productCode = extractProductCode(link);
    if (!productCode) continue;

    const apiData = await checkPincodeAvailability(productCode);

    if (isDeliverable(apiData)) {
      deliverableLinks.push(link);
    }

    // small delay to avoid hammering API
    await new Promise((r) => setTimeout(r, 300));
  }

  pincodeSection = `3️⃣ PINCODE DELIVERABLE PRODUCTS (Pincode: ${CONFIG.pincode})

${
  deliverableLinks.length > 0
    ? deliverableLinks.map((l) => `• ${l}`).join("\n")
    : "❌ No deliverable products found"
}`;

  saveSnapshot(newSnapshot);

  const time = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
  });

  const message = `📦 SHEIN STOCK UPDATE

${menSection}

${filteredSection}

${pincodeSection}

Updated: ${time}`;

  await sendTelegram(message);
}

// ================= SCHEDULER =================

// Run immediately
runOnce();

// Run every 5 minutes
setInterval(runOnce, 5 * 60 * 1000);
