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

function extractIframeSrc(html: string, base: string): string | null {
  const upperMatch = html.match(/<iframe[^>]*?src=["']([^"'\s>]+)["'][^>]*?>/i);
  const src = upperMatch?.[1] || '';
  if (!src) return null;
  return toAbsoluteUrl(src, base);
}

function base64UrlToBase64(b64url: string): string {
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  return b64;
}

function base64UrlDecodeToString(b64url: string): string | null {
  try {
    const b64 = base64UrlToBase64(b64url);
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)!;
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function extractHlsFromConfig(jsOrHtml: string, base: string): { url: string; label?: string } | null {
  const srcMatch = jsOrHtml.match(/sources\s*:\s*\[[\s\S]*?\{[\s\S]*?\"src\"\s*:\s*\"([^\"]+\.m3u8[^\"]*)\"[\s\S]*?\}/i);
  if (!srcMatch || !srcMatch[1]) return null;
  const url = toAbsoluteUrl(srcMatch[1], base);
  let label: string | undefined;
  const labelMatch = jsOrHtml.match(/sources\s*:\s*\[[\s\S]*?\{[\s\S]*?\"label\"\s*:\s*\"([^\"]+)\"[\s\S]*?\}/i);
  if (labelMatch && labelMatch[1]) label = labelMatch[1];
  return { url, label };
}

function extractM3u8Generic(jsOrHtml: string): string | null {
  const m = jsOrHtml.match(/["']([^"']*\.m3u8[^"']*)["']/i);
  return m && m[1] ? m[1] : null;
}

function extractDictionary(unpacked: string): string[] | null {
  const dictMatch = unpacked.match(/'([^']*)'\.split\('\|\'\)/);
  if (!dictMatch || !dictMatch[1]) return null;
  return dictMatch[1].split('|');
}

function denormalizeNumericTokens(encodedUrl: string, dict: string[] | null): string {
  if (!dict) return encodedUrl;
  return encodedUrl.replace(/\b(\d+)\b/g, (full, d) => {
    const idx = parseInt(d, 10);
    return Number.isFinite(idx) && idx >= 0 && idx < dict.length && dict[idx] ? dict[idx] : full;
  });
}

async function fetchText(url: string, referer: string, userAgent: string): Promise<string> {
  const res = await fetch(url, { headers: { Referer: referer, 'User-Agent': userAgent, Accept: '*/*' } });
  return await res.text();
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

function decodeJuicyCodesPayloadFromHtml(html: string): string | null {
  const runMatch = html.match(/JuicyCodes\.Run\(\s*((?:"[^"]*"|'[^']*')(?:\s*\+\s*(?:"[^"]*"|'[^']*'))*)\s*\)/i);
  if (!runMatch || !runMatch[1]) return null;

  const concatSection = runMatch[1];
  const partRegex = /"([^"]*)"|'([^']*)'/g;
  let combined = '';
  let m: RegExpExecArray | null;
  while ((m = partRegex.exec(concatSection)) !== null) {
    const piece = (m[1] ?? m[2] ?? '');
    combined += piece;
  }
  if (!combined) return null;
  return base64UrlDecodeToString(combined);
}

export async function extractFlash(id: string): Promise<Source> {
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
  if (!iframeUrl) throw new Error('DESI-FLASH: iframe src not found');

  const iframeOrigin = new URL(iframeUrl).origin + '/';
  const iframeHeaders: Record<string, string> = {
    'User-Agent': userAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Referer': landingDomain,
  };

  const iframeRes = await fetch(iframeUrl, { headers: iframeHeaders });
  const iframeHtml = await iframeRes.text();

  const juicyDecoded = decodeJuicyCodesPayloadFromHtml(iframeHtml);
  if (!juicyDecoded) {
    throw new Error('DESI-FLASH: JuicyCodes payload not found');
  }

  let unpacked: string;
  try {
    unpacked = unpackEvaled(juicyDecoded);
  } catch {
    unpacked = juicyDecoded;
  }

  let hls = extractHlsFromConfig(unpacked, iframeOrigin);
  if (!hls) {
    const dict = extractDictionary(unpacked);
    const genericUrl = extractM3u8Generic(unpacked);
    if (genericUrl) {
      const rebuilt = denormalizeNumericTokens(genericUrl, dict);
      const finalUrl = toAbsoluteUrl(rebuilt, iframeOrigin);
      hls = { url: finalUrl, label: 'auto' };
    }
  }
  if (!hls) throw new Error('DESI-FLASH: HLS source not found after unpacking, Contact Developer for support.');

  let hlsUrl = hls.url;
  try {
    const master = await fetchText(hlsUrl, iframeOrigin, userAgent);
    if (/#EXTM3U/i.test(master) && /#EXT-X-STREAM-INF:/i.test(master)) {
      const variants = parseMasterVariants(master, hlsUrl);
      const best = pickVariant(variants);
      if (best && best.url) {
        hlsUrl = best.url;
      } else if (variants.length > 0) {
        hlsUrl = variants[0]!.url;
      }
    }
  } catch {}

  const proxyPayload = {
    u: hlsUrl,
    h: {
      Referer: iframeOrigin,
      'User-Agent': userAgent,
    },
  };
  const encoded = base64UrlEncodeString(JSON.stringify(proxyPayload));
  const proxiedUrl = `/hls/${encoded}.m3u8`;
  const quality = (hls.label && hls.label.trim()) || 'auto';

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
