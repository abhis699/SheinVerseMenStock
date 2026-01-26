require('dotenv').config();

const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const cron = require('node-cron');
const axios = require('axios');

// ==================== CONFIGURATION ====================
const CONFIG = {
  targetUrl: 'https://sheinindia.in/sheinverse/c/sverse-5939-37961?query=%3Arelevance%3Agenderfilter%3AMen',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  snapshotFile: 'stock.json',
  cronSchedule: '*/10 * * * *',
  maxRetries: 2,
  retryDelay: 5000,
};

// ==================== UTILITY FUNCTIONS ====================

async function sendTelegramNotification(message) {
  try {
    const url = `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`;
    await axios.post(url, {
      chat_id: CONFIG.telegramChatId,
      text: message,
      disable_web_page_preview: true,
    });
    console.log('✅ Telegram notification sent successfully');
  } catch (error) {
    console.error('❌ Failed to send Telegram notification:', error.message);
  }
}

async function loadSnapshot() {
  try {
    const data = await fs.readFile(CONFIG.snapshotFile, 'utf8');
    const snapshot = JSON.parse(data);
    console.log(`📂 Loaded ${snapshot.products.length} products from previous snapshot`);
    return snapshot;
  } catch (error) {
    console.log('📂 No previous snapshot found, starting fresh');
    return { products: [], timestamp: null };
  }
}

async function saveSnapshot(products) {
  const snapshot = {
    products: Array.from(products),
    timestamp: new Date().toISOString(),
    count: products.size,
  };
  
  await fs.writeFile(
    CONFIG.snapshotFile,
    JSON.stringify(snapshot, null, 2),
    'utf8'
  );
  console.log(`💾 Saved ${products.size} products to snapshot`);
}

async function scrapeProducts(retryCount = 0) {
  let browser = null;
  
  try {
    console.log('🌐 Launching browser...');
    
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
    
    const page = await browser.newPage();
    
    // Block images and other resources for faster loading
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const resourceType = request.resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(resourceType)) {
        request.abort();
      } else {
        request.continue();
      }
    });
    
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    
    console.log('📡 Navigating to target URL...');
    await page.goto(CONFIG.targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
    
    console.log('⏳ Waiting for content to load (15 seconds)...');
    await new Promise(resolve => setTimeout(resolve, 15000));
    
    // Scroll to trigger lazy loading
    console.log('📜 Scrolling to load all products...');
    await page.evaluate(async () => {
      for (let i = 0; i < 8; i++) {
        window.scrollBy(0, 500);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      window.scrollTo(0, 0);
    });
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Extract product IDs using the exact URL pattern from Shein
    console.log('🔍 Extracting product identifiers...');
    const products = await page.evaluate(() => {
      const productIds = new Set();
      
      // Look for all product links with the pattern /p/{PRODUCT_ID}
      const allLinks = document.querySelectorAll('a[href*="/p/"]');
      
      allLinks.forEach(link => {
        const href = link.getAttribute('href');
        if (href) {
          // Extract product ID from href like: /shein-...product.../p/443380970_color
          const match = href.match(/\/p\/(\d+)_/);
          if (match && match[1]) {
            productIds.add(match[1]);
          }
        }
      });
      
      return {
        products: Array.from(productIds),
        totalLinks: allLinks.length,
      };
    });
    
    console.log(`📊 Found ${products.totalLinks} product links on page`);
    console.log(`✅ Extracted ${products.products.length} unique product IDs`);
    
    await browser.close();
    
    if (products.products.length === 0) {
      throw new Error('No products found - page structure may have changed');
    }
    
    return new Set(products.products);
    
  } catch (error) {
    console.error(`❌ Scraping error (attempt ${retryCount + 1}):`, error.message);
    
    if (browser) {
      await browser.close().catch(() => {});
    }
    
    if (retryCount < CONFIG.maxRetries) {
      console.log(`🔄 Retrying in ${CONFIG.retryDelay / 1000} seconds...`);
      await new Promise(resolve => setTimeout(resolve, CONFIG.retryDelay));
      return scrapeProducts(retryCount + 1);
    }
    
    throw error;
  }
}

function compareSnapshots(oldProducts, newProducts) {
  const oldSet = new Set(oldProducts);
  const newSet = new Set(newProducts);
  
  const added = Array.from(newSet).filter(id => !oldSet.has(id));
  const removed = Array.from(oldSet).filter(id => !newSet.has(id));
  
  return { added, removed };
}

function formatNotification(totalItems, added, removed, addedProducts) {
  const timestamp = new Date().toLocaleString('en-IN', { 
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  
  let message = 
`📦 SHEIN MEN STOCK UPDATE
Total Items: ${totalItems}
Added: ${added}
Removed: ${removed}
Updated: ${timestamp}`;

  // Add clickable links for new products
  if (addedProducts.length > 0) {
    message += '\n\nNEW PRODUCTS:';
    addedProducts.forEach(id => {
      message += `\nhttps://sheinindia.in/p/${id}`;
    });
  }
  
  return message;
}

async function monitorStock() {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 Starting stock monitoring cycle...');
  console.log('='.repeat(60));
  
  try {
    const oldSnapshot = await loadSnapshot();
    const newProducts = await scrapeProducts();
    const { added, removed } = compareSnapshots(oldSnapshot.products, newProducts);
    
    console.log(`\n📊 Stock Status:`);
    console.log(`   📦 Total Items: ${newProducts.size}`);
    console.log(`   ✅ Added: ${added.length}`);
    console.log(`   ❌ Removed: ${removed.length}`);
    
    // Always send notification every cycle with added products
    const message = formatNotification(newProducts.size, added.length, removed.length, added);
    await sendTelegramNotification(message);
    
    await saveSnapshot(newProducts);
    console.log('✅ Monitoring cycle completed successfully\n');
    
  } catch (error) {
    console.error('💥 Monitoring cycle failed:', error.message);
    await sendTelegramNotification(
      `⚠️ SHEIN MONITOR ERROR\nFailed to check stock: ${error.message}\nTime: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
    );
  }
}

async function testSetup() {
  console.log('🧪 Testing setup...\n');
  
  console.log('1️⃣ Testing Telegram connection...');
  await sendTelegramNotification(
    `✅ SHEIN STOCK MONITOR ACTIVE\n\nYour bot is successfully configured and running!\nMonitoring: Shein India Men's SHEINVERSE Collection\n\nYou'll receive notifications every 10 minutes.`
  );
  
  console.log('\n2️⃣ Running initial stock check...');
  await monitorStock();
  
  console.log('\n✅ Setup test completed!');
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║      SHEIN INDIA STOCK MONITORING SYSTEM              ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
  
  if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) {
    console.error('❌ ERROR: Please configure Telegram credentials!');
    process.exit(1);
  }
  
  if (process.argv.includes('--test')) {
    await testSetup();
    process.exit(0);
  }
  
  console.log('🔍 Running initial stock check...\n');
  await monitorStock();
  
  console.log(`⏰ Scheduling monitoring every 10 minutes...\n`);
  cron.schedule(CONFIG.cronSchedule, () => {
    monitorStock();
  });
  
  console.log('✅ Monitor is now running! Press Ctrl+C to stop.\n');
}

main().catch(error => {
  console.error('💥 Fatal error:', error);
  process.exit(1);
});