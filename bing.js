// bing.js — Bing HPImageArchive 拉取与壁纸下载（Soup 3）
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async',
    'replace_contents_finish');

const BING_ARCHIVE = 'https://www.bing.com/HPImageArchive.aspx';
const BING_BASE = 'https://www.bing.com';

// 与 neffo 扩展完全一致的命名/URL 约定，复用其历史缓存文件
export function imageUrl(urlbase, resolution) {
    return `${BING_BASE}${urlbase}_${resolution}.jpg&qlt=100`;
}

export function filenameFor(image, resolution) {
    const base = image.urlbase
        .replace(/^.*[\\/]/, '')
        .replace('th?id=OHR.', '');
    return `${image.startdate}-${base}_${resolution}.jpg`;
}

export function newSession() {
    return new Soup.Session({
        user_agent: 'Mozilla/5.0 (X11; Linux x86_64) BingWallpaperFolder/1.0',
        accept_language: 'zh-CN,zh;q=0.9,en;q=0.8',
        timeout: 30,
    });
}

// 返回 Bing 原始 JSON：{ images: [{ startdate, urlbase, title, copyright, ... }], ... }
export async function fetchArchive(session, market, n = 8) {
    const hash = {
        format: 'js',
        idx: '0',
        n: String(n),
        mbl: '1',
        mkt: market === 'auto' ? '' : market,
    };
    const url = `${BING_ARCHIVE}?${Soup.form_encode_hash(hash)}`;
    const message = Soup.Message.new('GET', url);
    const bytes = await session.send_and_read_async(
        message, GLib.PRIORITY_DEFAULT, null);
    if (message.statusCode !== 200)
        throw new Error(`HPImageArchive HTTP ${message.statusCode}`);
    const text = new TextDecoder().decode(bytes.toArray());
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.images))
        throw new Error('HPImageArchive 返回了无法识别的 JSON');
    return parsed;
}

export async function download(session, url, file) {
    const message = Soup.Message.new('GET', url);
    const bytes = await session.send_and_read_async(
        message, GLib.PRIORITY_DEFAULT, null);
    if (message.statusCode !== 200)
        throw new Error(`下载失败 HTTP ${message.statusCode}: ${url}`);
    await file.replace_contents_bytes_async(
        bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}
