import type { Source } from '../types/sources';
import { unpackEvaled } from '../impl/unpacker';
function toAbsoluteUrl(urlOrPath: string, base: string): string {
  try {
    if (!urlOrPath) return urlOrPath;
    if (/^https?:\/\//i.test(urlOrPath)) return urlOrPath;
    if (urlOrPath.startsWith('//')) return `https:${urlOrPath}`;
    return new URL(urlOrPath, base).toString();
  } catch {
    return urlOrPath;
  }
}

function parseJwplayerSourcesFromJs(js: string, base: string): { url: string; label?: string }[] {
  const sources: { url: string; label?: string }[] = [];
  const re = /\{[^{}]*?file\s*:\s*["']([^"']+)["'][^{}]*?(?:label\s*:\s*["']([^"']+)["'])?[^{}]*?\}/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(js)) !== null) {
    const file = toAbsoluteUrl(match[1]!, base);
    const label = match[2] || undefined;
    if (/\.(m3u8|mp4)(\?|$)/i.test(file)) {
      sources.push({ url: file, label });
    }
  }
  return sources;
}

type Variant = { url: string; bandwidth?: number; resolution?: { width: number; height: number } };

function parseMasterVariants(masterText: string, masterUrl: string): Variant[] {
  const lines = masterText.split(/\r?\n/);
  const variants: Variant[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^#EXT-X-STREAM-INF:/i.test(line)) {
      const meta = line;
      const next = lines[i + 1] || '';
      if (!next || next.startsWith('#')) continue;
      let bandwidth: number | undefined;
      let resolution: { width: number; height: number } | undefined;
      const bwMatch = meta.match(/BANDWIDTH=(\d+)/i);
      if (bwMatch) bandwidth = parseInt(bwMatch[1] as string, 10);
      const resMatch = meta.match(/RESOLUTION=(\d+)x(\d+)/i);
      if (resMatch) {
        resolution = { width: parseInt(resMatch[1] as string, 10), height: parseInt(resMatch[2] as string, 10) };
      }
      const abs = toAbsoluteUrl(next.trim(), masterUrl);
      variants.push({ url: abs, bandwidth, resolution });
    }
  }
  if (variants.length === 0) {
    for (const line of lines) {
      if (line && !line.startsWith('#') && /\.m3u8(\?|$)/i.test(line)) {
        variants.push({ url: toAbsoluteUrl(line.trim(), masterUrl) });
      }
    }
  }
  return variants;
}

function pickVariant(variants: Variant[]): Variant | null {
  if (variants.length === 0) return null;
  let best = variants[0] as Variant;
  for (const v of variants) {
    const areaBest = best.resolution ? best.resolution.width * best.resolution.height : 0;
    const areaV = v.resolution ? v.resolution.width * v.resolution.height : 0;
    if (areaV > areaBest) best = v;
    else if (areaV === areaBest) {
      const bwBest = best.bandwidth ?? 0;
      const bwV = v.bandwidth ?? 0;
      if (bwV > bwBest) best = v;
    }
  }
  return best;
}

function base64UrlEncodeString(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  const b64 = btoa(binary);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function extractVk(id: string): Promise<Source> {
  const userAgent = 'Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0';
  const iframeUrl = toAbsoluteUrl(id, 'https://');
  const iframeOrigin = new URL(iframeUrl).origin + '/';
  const iframeRes = await fetch(iframeUrl, {
    headers: {
      'User-Agent': userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Referer': iframeOrigin,
    },
  });
  const iframeHtml = await iframeRes.text();

  let unpacked = '';
  try {
    unpacked = unpackEvaled(iframeHtml);
  } catch {
    unpacked = iframeHtml;
  }

  const jwSources = parseJwplayerSourcesFromJs(unpacked, iframeOrigin);
  if (jwSources.length === 0) {
    throw new Error('VK: No media sources found');
  }

  let finalUrl = jwSources[0]!.url;
  let quality = (jwSources[0]!.label || '').trim() || 'auto';
  const hlsItem = jwSources.find(s => /\.m3u8(\?|$)/i.test(s.url));
  if (hlsItem) {
    finalUrl = hlsItem.url;
    quality = (hlsItem.label || '').trim() || 'auto';
    try {
      const res = await fetch(finalUrl, { headers: { Referer: iframeOrigin, 'User-Agent': userAgent } });
      const text = await res.text();
      if (/#EXTM3U/i.test(text)) {
        const variants = parseMasterVariants(text, res.url || finalUrl);
        const best = pickVariant(variants);
        if (best && best.url) finalUrl = best.url;
        else if (variants.length > 0) finalUrl = variants[0]!.url;
      }
    } catch {}
  }

  const proxyPayload = {
    u: finalUrl,
    h: {
      Referer: iframeOrigin,
      'User-Agent': userAgent,
    },
  };
  const encoded = base64UrlEncodeString(JSON.stringify(proxyPayload));
  const proxiedUrl = `/hls/${encoded}.m3u8`;

  const source: Source = {
    sources: [{ url: proxiedUrl, quality }],
    tracks: [],
    audio: [],
    intro: { start: 0, end: 0 },
    outro: { start: 0, end: 0 },
    headers: {
      Referer: iframeOrigin,
      'User-Agent': userAgent,
    },
  };

  return source;
}