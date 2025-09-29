import type { Source } from '../types/sources';
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

function extractIframeSrc(html: string, base: string): string | null {
  const match = html.match(/<iframe[^>]*?src=["']([^"'\s>]+)["'][^>]*?>/i);
  if (!match || !match[1]) return null;
  return toAbsoluteUrl(match[1], base);
}

function extractHlsFromConfig(html: string): { url: string; label?: string } | null {
  const srcMatch = html.match(/sources\s*:\s*\[[\s\S]*?\{[\s\S]*?"src"\s*:\s*"([^"]+\.m3u8[^"]*)"[\s\S]*?\}/i);
  if (!srcMatch || !srcMatch[1]) return null;
  const url = srcMatch[1];

  let label: string | undefined;
  const labelMatch = html.match(/sources\s*:\s*\[[\s\S]*?\{[\s\S]*?"label"\s*:\s*"([^"]+)"[\s\S]*?\}/i);
  if (labelMatch && labelMatch[1]) label = labelMatch[1];

  return { url, label };
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

export async function extractDaily(id: string): Promise<Source> {
  const landingDomain = 'https://starscopsinsider.com/';
  const landingUrl = `${landingDomain}post.php?id=${encodeURIComponent(id)}`;

  const userAgent = 'Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0';

  const landingHeaders: Record<string, string> = {
    'User-Agent': userAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Referer': 'https://playdesi.info/',
  };

  const landingRes = await fetch(landingUrl, { headers: landingHeaders });
  const landingHtml = await landingRes.text();

  const iframeUrl = extractIframeSrc(landingHtml, landingDomain);
  if (!iframeUrl) throw new Error('DAILY: iframe src not found');

  const iframeOrigin = new URL(iframeUrl).origin + '/';
  const iframeHeaders: Record<string, string> = {
    'User-Agent': userAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Referer': landingDomain,
  };

  const iframeRes = await fetch(iframeUrl, { headers: iframeHeaders });
  const iframeHtml = await iframeRes.text();

  const hls = extractHlsFromConfig(iframeHtml);
  if (!hls) throw new Error('DAILY: HLS source not found in config');
  let hlsUrl = toAbsoluteUrl(hls.url, iframeOrigin);

  try {
    const hlsRes = await fetch(hlsUrl, { headers: { 'Referer': iframeOrigin, 'User-Agent': userAgent } });
    hlsUrl = hlsRes.url || hlsUrl;
    const master = await hlsRes.text();
    if (/#EXTM3U/i.test(master)) {
      const variants = parseMasterVariants(master, hlsUrl);
      const best = pickVariant(variants);
      if (best && best.url) hlsUrl = best.url;
      else if (variants.length > 0) hlsUrl = variants[0]!.url;
    }
  } catch {
  }

  const quality = (hls.label && hls.label.trim()) || 'auto';

  const proxyPayload = {
    u: hlsUrl,
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