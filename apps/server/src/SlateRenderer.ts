import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export interface SlateContent {
  title: string;
  subtitle?: string;
  wordmark?: string;
}

/**
 * Renders a branded title-card PNG using the headless Chromium we already ship
 * for recording. This avoids depending on ffmpeg's `drawtext`/libfreetype,
 * which is not present in every ffmpeg build (and produced a black slate). The
 * PNG is then looped into video by the Fuser.
 */
export class SlateRenderer {
  async render(content: SlateContent, outputPath: string): Promise<void> {
    await mkdir(path.dirname(outputPath), { recursive: true });
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
      await page.setContent(buildHtml(content), { waitUntil: 'load' });
      await page.screenshot({ path: outputPath as `${string}.png`, type: 'png' });
    } finally {
      await browser.close().catch(() => undefined);
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildHtml(content: SlateContent): string {
  const title = escapeHtml(content.title);
  const subtitle = content.subtitle ? escapeHtml(content.subtitle) : '';
  const wordmark = escapeHtml(content.wordmark ?? 'Pitchbox');
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1280px; height: 720px; }
      body {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        background: radial-gradient(1200px 700px at 50% 35%, #1b1b2b 0%, #0b0b10 60%, #050507 100%);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        color: #fff;
        text-align: center;
        padding: 0 120px;
      }
      .wordmark {
        text-transform: uppercase;
        letter-spacing: 0.4em;
        font-size: 16px;
        font-weight: 600;
        color: #8b8ba7;
        margin-bottom: 28px;
      }
      .title {
        font-size: 64px;
        font-weight: 700;
        line-height: 1.1;
        letter-spacing: -0.02em;
        background: linear-gradient(90deg, #c7c7ff, #ffffff);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }
      .subtitle {
        margin-top: 24px;
        font-size: 24px;
        font-weight: 400;
        color: #b6b6c8;
        max-width: 900px;
      }
      .rule {
        margin-top: 40px;
        width: 64px;
        height: 3px;
        border-radius: 999px;
        background: linear-gradient(90deg, #6d6df0, #a86df0);
      }
    </style>
  </head>
  <body>
    <div class="wordmark">${wordmark}</div>
    <div class="title">${title}</div>
    ${subtitle ? `<div class="subtitle">${subtitle}</div>` : ''}
    <div class="rule"></div>
  </body>
</html>`;
}
