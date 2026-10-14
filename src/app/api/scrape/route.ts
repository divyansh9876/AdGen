import { NextResponse } from 'next/server';
import puppeteer, { Page, ElementHandle } from 'puppeteer';
import { Product } from '@/types/product';

export async function POST(request: Request) {
  let browser;
  try {
    const { url } = await request.json();

    if (!url || typeof url !== 'string') {
      return NextResponse.json(
        { error: 'URL is required' },
        { status: 400 }
      );
    }

    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return NextResponse.json(
        { error: 'Enter a valid http or https URL' },
        { status: 400 }
      );
    }

    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return NextResponse.json(
        { error: 'Enter a valid http or https URL' },
        { status: 400 }
      );
    }

    if (isPrivateHost(target.hostname)) {
      return NextResponse.json(
        { error: 'That address cannot be scraped' },
        { status: 400 }
      );
    }

    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run',
        '--disable-background-networking',
      ],
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1280, height: 800 });
    await page.setDefaultNavigationTimeout(60000);
    await page.setJavaScriptEnabled(true);

    // Amazon and Shopify keep analytics requests open, so networkidle never arrives.
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const type = request.resourceType();
      if (type === 'image' || type === 'media' || type === 'font' || type === 'stylesheet') {
        request.abort().catch(() => {});
      } else {
        request.continue().catch(() => {});
      }
    });

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    await page.waitForSelector('#productTitle, #landingImage, h1, .product__title, .product-title', {
      timeout: 15000,
    }).catch(() => {});

    const host = target.hostname.toLowerCase();
    const isAmazon = host.includes('amazon.') || host.startsWith('amzn.') || host.includes('.amzn.');
    const isShopify = host.includes('myshopify.com') || host.includes('shopify.');

    let product: Product;
    try {
      if (isAmazon) {
        product = await scrapeAmazon(page);
      } else if (isShopify) {
        product = await scrapeShopify(page);
      } else {
        product = await scrapeGeneric(page);
      }
    } catch (siteError) {
      if (!isAmazon && !isShopify) {
        throw siteError;
      }
      product = await scrapeGeneric(page);
    }

    await browser.close();
    return NextResponse.json(product);
  } catch (error) {
    console.error('Scraping error:', error);
    if (browser) {
      await browser.close();
    }
    const message = error instanceof Error ? error.message : 'Failed to scrape product data';
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || /timeout/i.test(message));
    return NextResponse.json(
      {
        error: timedOut
          ? 'The page took too long to load. Try the link again.'
          : message,
      },
      { status: 500 }
    );
  }
}

async function scrapeAmazon(page: Page): Promise<Product> {
  // Helper function to safely extract text content
  const safeTextExtract = async (selector: string, fallback = ''): Promise<string> => {
    try {
      const element = await page.$(selector);
      return element ? (await element.evaluate((el: Element) => el.textContent?.trim() || '')) : fallback;
    } catch {
      return fallback;
    }
  };

  // Helper function to safely extract multiple image URLs
  const safeImagesExtract = async (): Promise<string[]> => {
    const images: string[] = [];
    
    try {
      // Try to get the highest quality image from the main product image
      const mainImage = await page.$eval(
        '#landingImage, #imgBlkFront, #main-image',
        (el: Element) => {
          if (el instanceof HTMLImageElement) {
            // Get the data-a-dynamic-image attribute which contains all available sizes
            const dynamicImages = el.getAttribute('data-a-dynamic-image');
            if (dynamicImages) {
              try {
                const images = JSON.parse(dynamicImages);
                // Get the URL with the highest dimensions
                return Object.entries(images)
                  .sort(([, a]: any, [, b]: any) => (b.width * b.height) - (a.width * a.height))[0][0];
              } catch {
                // Fallback to other high-res sources
                return el.getAttribute('data-old-hires') || 
                       el.getAttribute('data-zoom-hires') || 
                       el.src;
              }
            }
            return el.getAttribute('data-old-hires') || 
                   el.getAttribute('data-zoom-hires') || 
                   el.src;
          }
          return '';
        }
      ).catch(() => '');

      if (mainImage) {
        images.push(mainImage);
      }

      // Try to get all variant images in high resolution
      const variantImages = await page.$$eval(
        '#altImages img, #imageBlock img, .imgTagWrapper img, .a-button-thumbnail img',
        (elements: Element[]) => {
          return elements.map((el) => {
            if (el instanceof HTMLImageElement) {
              const hiRes = el.getAttribute('data-old-hires') || 
                          el.getAttribute('data-zoom-hires');
              
              // Check for dynamic images
              const dynamicImages = el.getAttribute('data-a-dynamic-image');
              if (dynamicImages) {
                try {
                  const images = JSON.parse(dynamicImages);
                  // Get the URL with the highest dimensions
                  return Object.entries(images)
                    .sort(([, a]: any, [, b]: any) => (b.width * b.height) - (a.width * a.height))[0][0];
                } catch {
                  return hiRes || el.src;
                }
              }
              
              return hiRes || el.src;
            }
            return '';
          }).filter(url => 
            url && 
            !url.includes('sprite') && 
            !url.includes('placeholder') && 
            !url.includes('gif') &&
            !url.includes('thumb') && 
            !url.includes('small') &&
            !url.includes('SS40') &&
            !url.includes('mini')
          );
        }
      );
      
      images.push(...variantImages);

      // Remove duplicates and filter out low-quality images
      return [...new Set(images)].filter(url => {
        // Filter out low-resolution images
        const isLowRes = url.includes('_SL') || url.includes('_SR');
        if (isLowRes) {
          // Extract resolution from URL if possible
          const match = url.match(/_S[LR](\d+)_/);
          if (match) {
            const resolution = parseInt(match[1]);
            return resolution >= 800; // Only keep images with resolution >= 800
          }
        }
        return true;
      }).map(url => {
        // Try to get the highest resolution version by modifying Amazon image URLs
        return url.replace(/_S[LR]\d+_/g, '_SL1500_')
                 .replace(/\._[^.]*_\./, '.') // Remove quality modifiers
                 .replace(/\._(AA|AB|AC|AD|AE)\d+_/, '.'); // Remove Amazon's size suffixes
      });
    } catch (error) {
      console.error('Error extracting images:', error);
      return images;
    }
  };

  const title = await safeTextExtract('#productTitle');
  if (!title) {
    throw new Error('Could not find product title');
  }

  const images = await safeImagesExtract();
  if (images.length === 0) {
    throw new Error('Could not find product images');
  }

  const price = await safeTextExtract('.a-price .a-offscreen, #priceblock_ourprice, #price_inside_buybox');
  const description = await safeTextExtract('#productDescription p, #feature-bullets');
  
  const features = await page.$$eval(
    '#feature-bullets li span, #productDescription ul li', 
    (elements: Element[]) => elements.map((el: Element) => el.textContent?.trim() || '').filter(Boolean)
  );

  return {
    title,
    image: images[0], // Main image
    images: images.slice(1), // Additional images
    price,
    description,
    features,
    url: page.url(),
  };
}

async function scrapeShopify(page: Page): Promise<Product> {
  // Helper function to safely extract text content
  const safeTextExtract = async (selector: string, fallback = ''): Promise<string> => {
    try {
      const element = await page.$(selector);
      return element ? (await element.evaluate((el: Element) => el.textContent?.trim() || '')) : fallback;
    } catch {
      return fallback;
    }
  };

  // Helper function to safely extract multiple image URLs
  const safeImagesExtract = async (): Promise<string[]> => {
    const images: string[] = [];
    
    try {
      // Try to get images from the product gallery
      const galleryImages = await page.$$eval(
        '.product-gallery img, .product__media img, .product-single__media img, [data-product-media-type="image"] img',
        (elements: Element[]) => {
          return elements.map((el) => {
            if (el instanceof HTMLImageElement) {
              // Try to get the highest resolution version
              const srcset = el.getAttribute('srcset');
              if (srcset) {
                // Parse srcset and get the highest resolution URL
                const sources = srcset.split(',')
                  .map(src => {
                    const [url, width] = src.trim().split(' ');
                    return {
                      url,
                      width: parseInt(width?.replace('w', '') || '0')
                    };
                  })
                  .sort((a, b) => b.width - a.width);
                
                if (sources.length > 0) {
                  return sources[0].url;
                }
              }
              
              // Try to get original image by removing Shopify's image parameters
              const src = el.src || el.getAttribute('data-src') || '';
              if (src) {
                // Remove Shopify's image parameters to get the original size
                return src.split('?')[0].replace(/_\d+x\d+\./, '.');
              }
            }
            return '';
          }).filter(url => 
            url && 
            !url.includes('loader') && 
            !url.includes('placeholder') &&
            !url.includes('no-image') &&
            !url.includes('blank')
          );
        }
      );
      
      images.push(...galleryImages);

      // Try to get images from JSON data in the page
      const jsonData = await page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
        for (const script of scripts) {
          try {
            const data = JSON.parse(script.textContent || '');
            if (data.product && data.product.images) {
              return data.product.images;
            }
          } catch {
            continue;
          }
        }
        return null;
      });

      if (jsonData && Array.isArray(jsonData)) {
        const highResImages = jsonData
          .map((img: any) => {
            if (typeof img === 'string') {
              return img.split('?')[0].replace(/_\d+x\d+\./, '.');
            }
            return '';
          })
          .filter(Boolean);
        
        images.push(...highResImages);
      }
    } catch (error) {
      console.error('Error extracting images:', error);
    }

    // Remove duplicates and ensure we have full resolution images
    return [...new Set(images)].map(url => {
      // Remove any Shopify image parameters to get original size
      return url.split('?')[0].replace(/_\d+x\d+\./, '.');
    });
  };

  const title = await safeTextExtract('.product-title, .product__title, h1');
  if (!title) {
    throw new Error('Could not find product title');
  }

  const images = await safeImagesExtract();
  if (images.length === 0) {
    throw new Error('Could not find product images');
  }

  const price = await safeTextExtract('.product-price, .price__regular, .product__price');
  const description = await safeTextExtract('.product-description, .product__description');
  
  const features = await page.$$eval(
    '.product-features li, .product__features li', 
    (elements: Element[]) => elements.map((el: Element) => el.textContent?.trim() || '').filter(Boolean)
  );

  return {
    title,
    image: images[0], // Main image
    images: images.slice(1), // Additional images
    price,
    description,
    features,
    url: page.url(),
  };
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === '0.0.0.0' ||
    host === '::1'
  ) {
    return true;
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) {
    return false;
  }

  const a = Number(ipv4[1]);
  const b = Number(ipv4[2]);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

async function scrapeGeneric(page: Page): Promise<Product> {
  const data = await page.evaluate(() => {
    const absolute = (value: string) => {
      try {
        return new URL(value, location.href).href;
      } catch {
        return '';
      }
    };

    const meta = (selector: string) =>
      document.querySelector(selector)?.getAttribute('content')?.trim() || '';

    const asText = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

    const records: Array<Record<string, unknown>> = [];
    const visit = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      const record = node as Record<string, unknown>;
      const type = record['@type'];
      const types = Array.isArray(type) ? type : [type];
      if (types.some((item) => typeof item === 'string' && /product/i.test(item))) {
        records.push(record);
      }
      if (record['@graph']) visit(record['@graph']);
    };

    document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
      try {
        visit(JSON.parse(script.textContent || ''));
      } catch {
        // Pages often include incomplete JSON-LD.
      }
    });

    const product = records[0];
    const offerSource = product?.offers;
    const offer = (Array.isArray(offerSource) ? offerSource[0] : offerSource) as
      | Record<string, unknown>
      | undefined;
    const amount = offer?.price ?? offer?.lowPrice;
    const currency = asText(offer?.priceCurrency);
    const structuredPrice = amount ? `${currency} ${amount}`.trim() : '';

    const structuredImages = (() => {
      const image = product?.image;
      if (!image) return [] as string[];
      const values = Array.isArray(image) ? image : [image];
      return values.map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'url' in item) {
          return asText((item as Record<string, unknown>).url);
        }
        return '';
      });
    })();

    const title =
      asText(product?.name) ||
      meta('meta[property="og:title"]') ||
      meta('meta[name="twitter:title"]') ||
      document.querySelector('h1')?.textContent?.trim() ||
      document.title.trim();

    const description =
      asText(product?.description) ||
      meta('meta[property="og:description"]') ||
      meta('meta[name="description"]') ||
      meta('meta[name="twitter:description"]');

    const price =
      structuredPrice ||
      meta('meta[property="product:price:amount"]') ||
      meta('meta[property="og:price:amount"]') ||
      document.querySelector('[itemprop="price"]')?.getAttribute('content') ||
      document.querySelector('[itemprop="price"]')?.textContent?.trim() ||
      '';

    const images = [
      ...structuredImages,
      meta('meta[property="og:image"]'),
      meta('meta[property="og:image:url"]'),
      meta('meta[name="twitter:image"]'),
      ...Array.from(document.querySelectorAll('img')).map(
        (img) => img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || ''
      ),
    ]
      .map((src) => absolute(src))
      .filter((src) => src.startsWith('http') && !/logo|icon|sprite|pixel|tracking|badge/i.test(src));

    const features = Array.from(document.querySelectorAll('li'))
      .map((item) => item.textContent?.trim() || '')
      .filter((item) => item.length > 2 && item.length < 180);

    return {
      title,
      description,
      price,
      images: [...new Set(images)].slice(0, 8),
      features: [...new Set(features)].slice(0, 8),
    };
  });

  if (!data.title) {
    throw new Error('Could not find a title on this page');
  }

  if (data.images.length === 0) {
    throw new Error('Could not find images on this page');
  }

  return {
    title: data.title,
    image: data.images[0],
    images: data.images.slice(1),
    price: data.price,
    description: data.description || data.title,
    features: data.features,
    url: page.url(),
  };
} 