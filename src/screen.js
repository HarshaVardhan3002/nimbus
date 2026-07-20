'use strict';
/**
 * Full-resolution screenshot via desktopCapturer.
 *
 * Captures the display the pill is currently on rather than always the primary,
 * so on a multi-monitor setup the answer is about the screen you are looking at.
 *
 * Downscales above a cap: a 4K screenshot is ~8MP, which every vision model
 * tiles and bills for, and the extra resolution buys nothing for reading a
 * problem statement. The old version sent the full native resolution.
 */

const { desktopCapturer, screen } = require('electron');

const MAX_EDGE = 1920;

async function captureScreenshot(anchor) {
  const display = anchor
    ? screen.getDisplayMatching(anchor)
    : screen.getPrimaryDisplay();

  const { width, height } = display.size;
  const scale = display.scaleFactor || 1;

  const nativeW = Math.floor(width * scale);
  const nativeH = Math.floor(height * scale);
  const ratio = Math.min(1, MAX_EDGE / Math.max(nativeW, nativeH));

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.max(1, Math.floor(nativeW * ratio)),
      height: Math.max(1, Math.floor(nativeH * ratio))
    },
    fetchWindowIcons: false
  });
  if (!sources.length) return null;

  const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  const img = src.thumbnail;
  if (!img || img.isEmpty()) return null;

  // JPEG rather than PNG: a screenshot data URL at PNG is several megabytes and
  // it is base64-encoded into the request body, so it dominates upload latency.
  return 'data:image/jpeg;base64,' + img.toJPEG(82).toString('base64');
}

module.exports = { captureScreenshot, MAX_EDGE };
