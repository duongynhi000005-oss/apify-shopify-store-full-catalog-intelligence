import { Actor } from 'apify';
import * as cheerio from 'cheerio';

await Actor.init();

const input = (await Actor.getInput()) || {};
const startUrls = Array.isArray(input.startUrls) && input.startUrls.length > 0
    ? input.startUrls
    : [{ url: 'https://gymshark.com' }];
const maxProductsPerStore = Number(input.maxProductsPerStore ?? 50);

const SHOPIFY_APP_SIGNATURES = [
    { name: 'Klaviyo', re: /klaviyo\.com/i },
    { name: 'Judge.me Reviews', re: /judge\.me/i },
    { name: 'Yotpo', re: /yotpo\.com/i },
    { name: 'Loox Reviews', re: /loox\.io/i },
    { name: 'Recharge Subscriptions', re: /rechargepayments\.com|rechargecdn\.com/i },
    { name: 'Gorgias Helpdesk', re: /gorgias\.chat|gorgias\.io/i },
    { name: 'Privy', re: /privy\.com/i },
    { name: 'Smile.io Loyalty', re: /smile\.io/i },
    { name: 'Afterpay / Clearpay', re: /afterpay\.com|clearpay/i },
    { name: 'Klarna', re: /klarna\.com/i },
    { name: 'Shop Pay', re: /shop\.app\/pay|shopify-payment-button/i },
    { name: 'Triple Whale', re: /triplewhale\.com/i },
    { name: 'Elevar', re: /getelevar\.com/i },
    { name: 'PageFly', re: /pagefly\.io/i },
    { name: 'Shogun', re: /getshogun\.com/i }
];

async function fetchText(url, timeoutMs = 12000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            signal: ctrl.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
                'Accept': 'application/json,text/html;q=0.9,*/*;q=0.8'
            }
        });
        if (!res.ok) return null;
        return await res.text();
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

for (const item of startUrls) {
    const rawUrl = typeof item === 'string' ? item : item?.url;
    if (!rawUrl) continue;
    const baseUrl = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;
    let parsed;
    try {
        parsed = new URL(baseUrl);
    } catch {
        continue;
    }

    const origin = parsed.origin;
    const homeHtml = (await fetchText(origin)) || '';
    const $ = cheerio.load(homeHtml);
    const storeTitle = $('meta[property="og:site_name"]').attr('content')
        || $('title').first().text().trim()
        || parsed.hostname;
    const installedApps = SHOPIFY_APP_SIGNATURES.filter((a) => a.re.test(homeHtml)).map((a) => a.name);
    const themeMatch = homeHtml.match(/Shopify\.theme\s*=\s*(\{[^}]+\})/);
    let themeName = null;
    if (themeMatch) {
        try { themeName = JSON.parse(themeMatch[1]).name; } catch {}
    }

    const productsUrl = `${origin}/products.json?limit=${Math.min(250, maxProductsPerStore)}`;
    const productsRaw = await fetchText(productsUrl);
    let products = [];
    if (productsRaw) {
        try {
            const pJson = JSON.parse(productsRaw);
            products = (pJson.products || []).slice(0, maxProductsPerStore).map((p) => {
                const prices = (p.variants || []).map((v) => Number(v.price)).filter((n) => !Number.isNaN(n));
                return {
                    id: p.id,
                    title: p.title,
                    handle: p.handle,
                    productUrl: `${origin}/products/${p.handle}`,
                    vendor: p.vendor,
                    productType: p.product_type,
                    minPrice: prices.length ? Math.min(...prices) : null,
                    maxPrice: prices.length ? Math.max(...prices) : null,
                    variantsCount: (p.variants || []).length,
                    inStock: (p.variants || []).some((v) => v.available),
                    image: p.images?.[0]?.src || null,
                    publishedAt: p.published_at
                };
            });
        } catch {}
    }

    const allPrices = products.map((p) => p.minPrice).filter((n) => typeof n === 'number');
    const avgPrice = allPrices.length ? Number((allPrices.reduce((a, b) => a + b, 0) / allPrices.length).toFixed(2)) : null;

    await Actor.pushData({
        storeUrl: origin,
        domain: parsed.hostname.replace(/^www\./, ''),
        storeTitle,
        isShopifyDetected: /cdn\.shopify\.com|Shopify\.shop/i.test(homeHtml) || products.length > 0,
        themeName,
        installedApps,
        productsExtractedCount: products.length,
        averageProductPriceUsd: avgPrice,
        products,
        scrapedAt: new Date().toISOString()
    });
}

await Actor.exit();
