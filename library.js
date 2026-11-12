// library.js — 文件夹扫描 / 文件名解析 / 元数据 sidecar
// 只依赖 GI 类型库，不依赖 gnome-shell 资源，可在 gjs 下单测
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async', 'next_files_finish');
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'make_directory_async', 'make_directory_finish');

export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp'];
const RESOLUTION_RE = /^(UHD|\d+x\d+)$/;
const FILENAME_RE = /^(\d{8})-(.+)\.([A-Za-z0-9]+)$/;
const LOCALE_RE = /^[a-z]{2}-[a-z]{2}\d+$/i;
const NEFFO_SCHEMA = 'org.gnome.shell.extensions.bingwallpaper';

// CamelCase / 下划线 slug → 可读标题，如 "SerengetiGiraffe" → "Serengeti Giraffe"
export function humanizeSlug(slug) {
    return slug
        .replace(/[_-]+/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/\s+/g, ' ')
        .trim();
}

// 解析 neffo 风格文件名 20250619-SerengetiGiraffe_ZH-CN2613013393_UHD.jpg
// 任意不匹配的文件名返回 null（调用方仍会保留该文件，只是走 mtime/原名降级）
export function parseImageFilename(name) {
    const m = FILENAME_RE.exec(name);
    if (!m)
        return null;
    const [, date8, middle, ext] = m;
    if (!/^\d{8}$/.test(date8) || !IMAGE_EXTS.includes(ext.toLowerCase()))
        return null;

    const parts = middle.split('_');
    let resolution = '';
    if (parts.length && RESOLUTION_RE.test(parts[parts.length - 1]))
        resolution = parts.pop();

    const localeParts = [];
    const slugParts = [];
    for (const p of parts) {
        if (LOCALE_RE.test(p))
            localeParts.push(p);
        else
            slugParts.push(p);
    }
    const slug = slugParts.join(' ');
    return {
        date8,
        resolution,
        locale: localeParts[0] || '',
        slug,
        title: humanizeSlug(slug),
        ext: ext.toLowerCase(),
    };
}

export function formatDate8(date8) {
    if (!date8 || date8.length !== 8)
        return '';
    return `${date8.slice(0, 4)}-${date8.slice(4, 6)}-${date8.slice(6, 8)}`;
}

export function today8() {
    return GLib.DateTime.new_now_local().format('%Y%m%d');
}

function date8FromMtime(tvSec) {
    if (!tvSec)
        return '';
    return GLib.DateTime.new_from_unix_local(tvSec).format('%Y%m%d');
}

// 扫描壁纸目录，只收常规图片文件（忽略 .thumbs 等隐藏目录由调用方保证目录层级）
export async function scanFolder(folderPath) {
    const dir = Gio.File.new_for_path(folderPath);
    const out = [];
    const enumerator = await dir.enumerate_children_async(
        `${Gio.FILE_ATTRIBUTE_STANDARD_NAME},${Gio.FILE_ATTRIBUTE_STANDARD_SIZE},` +
        `${Gio.FILE_ATTRIBUTE_STANDARD_TYPE},${Gio.FILE_ATTRIBUTE_TIME_MODIFIED}`,
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        GLib.PRIORITY_DEFAULT, null);
    while (true) {
        const infos = await enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT, null);
        if (!infos || !infos.length)
            break;
        for (const info of infos) {
            if (info.get_file_type() !== Gio.FileType.REGULAR)
                continue;
            const name = info.get_name();
            const dot = name.lastIndexOf('.');
            if (dot < 1 || !IMAGE_EXTS.includes(name.slice(dot + 1).toLowerCase()))
                continue;
            const mt = info.get_modification_time();
            out.push({
                name,
                size: info.get_size(),
                mtime: mt ? mt.tv_sec : 0,
            });
        }
    }
    try {
        enumerator.close(null);
    } catch (_) {}
    return out;
}

// ---------------------------------------------------------------------------
// sidecar 元数据：<壁纸文件夹>/.bing-wallpaper-folder.json
// 与 dconf 解耦——dconf 重置/换机器/老文件都不影响元数据；
// 放在图片文件夹内，目录整体拷贝/备份时元数据随行。
// ---------------------------------------------------------------------------
export const METADATA_FILENAME = '.bing-wallpaper-folder.json';

export class MetadataStore {
    constructor(folderPath) {
        this._file = Gio.File.new_for_path(
            GLib.build_filenamev([folderPath, METADATA_FILENAME]));
        this._data = {version: 1, images: {}};
        this._dirty = false;
    }

    load() {
        if (!this._file.query_exists(null))
            return;
        try {
            const [ok, bytes] = this._file.load_contents(null);
            if (!ok)
                return;
            const parsed = JSON.parse(new TextDecoder().decode(bytes));
            if (parsed && parsed.images && typeof parsed.images === 'object')
                this._data = parsed;
        } catch (e) {
            console.warn(`BingWallpaperFolder: metadata.json 读取失败，按空库启动: ${e}`);
        }
    }

    save() {
        try {
            const parent = this._file.get_parent();
            if (parent && !parent.query_exists(null))
                parent.make_directory_with_parents(null);
            const bytes = new TextEncoder().encode(JSON.stringify(this._data, null, 1));
            this._file.replace_contents(bytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            this._dirty = false;
        } catch (e) {
            console.warn(`BingWallpaperFolder: metadata.json 写入失败: ${e}`);
        }
    }

    get(name) {
        return this._data.images[name] || null;
    }

    has(name) {
        return name in this._data.images;
    }

    set(name, meta) {
        this._data.images[name] = meta;
        this._dirty = true;
    }

    count() {
        return Object.keys(this._data.images).length;
    }
}

// 文件夹（事实来源）+ sidecar（富元数据）+ 文件名（降级信息）→ 排序后的条目列表
export async function buildLibrary(folderPath, store) {
    const infos = await scanFolder(folderPath);
    const entries = infos.map(info => {
        const parsed = parseImageFilename(info.name);
        const meta = store.get(info.name);
        const date8 = (meta && meta.date) || parsed?.date8 || date8FromMtime(info.mtime);
        const title = meta?.title || parsed?.title || info.name.replace(/\.[^.]+$/, '');
        return {
            name: info.name,
            path: GLib.build_filenamev([folderPath, info.name]),
            date8: date8 || '',
            dateLabel: formatDate8(date8),
            title,
            copyright: meta?.copyright || '',
            copyrightlink: meta?.copyrightlink || '',
            urlbase: meta?.urlbase || '',
            source: meta ? 'bing' : parsed ? 'filename' : 'unknown',
            resolution: parsed?.resolution || '',
            mtime: info.mtime,
        };
    });
    entries.sort((a, b) =>
        (b.date8 || '').localeCompare(a.date8 || '') ||
        b.mtime - a.mtime ||
        a.name.localeCompare(b.name));
    return entries;
}

// 一次性导入 neffo/bing-wallpaper-changer 写在 dconf 里的 bing-json
// 仅在旧 schema 仍存在、且本扩展尚未导入过时执行
export function importNeffoMetadata(store, folderPath, markImported) {
    const schema = Gio.SettingsSchemaSource.get_default()
        ?.lookup(NEFFO_SCHEMA, true);
    if (!schema)
        return {ok: false, reason: 'schema-missing', added: 0};

    let list;
    try {
        const old = new Gio.Settings({settings_schema: schema});
        list = JSON.parse(old.get_string('bing-json') || '[]');
    } catch (e) {
        return {ok: false, reason: `read-failed: ${e}`, added: 0};
    }
    if (!Array.isArray(list))
        return {ok: false, reason: 'bad-json', added: 0};

    const resolutions = ['UHD', '1920x1080', '1920x1200', '1366x768', '1280x720'];
    let added = 0;
    for (const img of list) {
        if (!img.startdate || !img.urlbase)
            continue;
        const base = img.urlbase
            .replace(/^.*[\\/]/, '')
            .replace('th?id=OHR.', '');
        const marketMatch = /_([a-z]{2}-[a-z]{2})\d+$/i.exec(base);
        for (const res of resolutions) {
            const name = `${img.startdate}-${base}_${res}.jpg`;
            if (store.has(name))
                continue;
            const path = GLib.build_filenamev([folderPath, name]);
            if (!Gio.File.new_for_path(path).query_exists(null))
                continue;
            store.set(name, {
                title: img.title || '',
                copyright: img.copyright || '',
                copyrightlink: img.copyrightlink || '',
                date: img.startdate,
                urlbase: img.urlbase,
                market: marketMatch ? marketMatch[1] : '',
                source: 'bing-neffo-import',
            });
            added++;
        }
    }
    if (added)
        store.save();
    markImported();
    return {ok: true, added};
}
